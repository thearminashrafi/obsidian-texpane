/**
 * Glue between TeXPane and LeanPane: per-view project lookup, chips and completion hosts, mismatch diagnostics,
 * the blueprint data for the progress panel, "Formalize this", and TeXPane's own API (TeXPaneApiV1).
 * Everything here goes quiet when LeanPane is absent. The pure logic lives in src/core and src/integration/*.ts
 * (leanBridge, blueprintStore, chipInfo), which are unit-tested with a fake LeanPane API.
 */
import { FuzzySuggestModal, Notice, TFile, type App } from "obsidian";
import * as path from "node:path";
import type TexPanePlugin from "../main";
import type { LatexWorkspaceView } from "../view/LatexWorkspaceView";
import { PromptModal } from "../modals";
import { parseBlueprint, type BlueprintNode, type BlueprintSource } from "../core/blueprint";
import { blueprintEntryChange } from "../core/blueprintEntry";
import {
  applyChanges,
  buildGraph,
  detectMismatches,
  editsToChanges,
  labelLine,
  statementText,
  type GraphNode,
  type Mismatch,
  type MismatchKind,
  type TextEdit,
} from "../core/blueprintModel";
import { isValidLeanName, leanNameFromLabel, parseLeanMagic, resolveVaultRelative } from "../core/leanProject";
import { toVaultRel } from "../core/paths";
import type { DeclSummary, LeanProjectInfo, TeXPaneApiV1 } from "./api-types";
import { API_VERSION, getLeanPaneApi } from "./api-types";
import { collectBlueprintSources } from "../core/blueprintSources";
import { BlueprintStore, type ParsedBlueprint } from "./blueprintStore";
import type { LeanChipHost } from "../editor/leanChips";
import type { CompletionHost } from "../editor/completion";
import type { LeanAvailability } from "./chipInfo";
import { LeanBridge } from "./leanBridge";
import type { Diagnostic } from "../types";

interface ViewState {
  key: string;
  /** undefined: not resolved yet */
  info: LeanProjectInfo | null | undefined;
  resolving: Promise<LeanProjectInfo | null> | null;
  timer: number | null;
  /** a check is running; `again` asks for one more when it ends */
  running: boolean;
  again: boolean;
}

const HUGE_LIST = 5000;
const DECL_TTL_MS = 20000;
const EDIT_DEBOUNCE_MS = 600;

export interface PanelData {
  root: string;
  name: string;
  info: LeanProjectInfo | null;
  nodes: BlueprintNode[];
  sources: BlueprintSource[];
  graph: GraphNode[];
}

type PickItem = { kind: "file"; file: TFile; label: string } | { kind: "new"; label: string };

class LeanFilePicker extends FuzzySuggestModal<PickItem> {
  constructor(app: App, private items: PickItem[], private pick: (i: PickItem) => void) {
    super(app);
    this.setPlaceholder("Lean file for the new declaration");
  }
  getItems() {
    return this.items;
  }
  getItemText(i: PickItem) {
    return i.label;
  }
  onChooseItem(i: PickItem) {
    this.pick(i);
  }
}

export class LeanIntegration {
  readonly bridge: LeanBridge;
  readonly store: BlueprintStore;
  private views = new Map<LatexWorkspaceView, ViewState>();
  private updated = new Set<() => void>();
  private apiListeners = new Set<() => void>();
  private declCache = new Map<string, { at: number; items: DeclSummary[]; huge: boolean }>();
  private editTimer: number | null = null;
  private lastLeanFile = new Map<string, string>();
  private syncing = false;
  private started = false;

  constructor(private plugin: TexPanePlugin) {
    this.bridge = new LeanBridge({ getApi: () => getLeanPaneApi(plugin.app) });
    this.store = new BlueprintStore((p) => this.readVaultText(p));
  }

  private get app() {
    return this.plugin.app;
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    if (this.started) return;
    this.started = true;
    this.bridge.onChange((e) => {
      this.declCache.clear();
      this.refreshAll(e === "availability");
      this.notifyUpdated();
    });
    this.store.onChange(() => {
      this.refreshAll();
      this.notifyUpdated();
      for (const l of [...this.apiListeners]) {
        try {
          l();
        } catch (e) {
          console.error("[TeXPane] onBlueprintChanged callback failed", e);
        }
      }
    });
    const ws = this.app.workspace as unknown as { on(name: string, cb: () => void): ReturnType<App["workspace"]["on"]> };
    for (const ev of ["leanpane:api-ready", "leanpane:api-unload"]) this.plugin.registerEvent(ws.on(ev, () => this.recheck()));
    // enabling or disabling a plugin changes the layout of the settings, ribbon and so on; cheap enough to look again
    this.plugin.registerEvent(this.app.workspace.on("layout-change", () => this.recheck()));
    this.recheck();
  }

  /** Re-check every open view now (a setting changed). */
  syncNow() {
    this.refreshAll();
  }

  /** Cache key of the Lean project lookup for a view: its root file and the `% !LEAN project` comment in it. */
  private async projectKey(view: LatexWorkspaceView): Promise<string> {
    const root = this.rootOf(view);
    if (!root) return "";
    return `${root}|${parseLeanMagic((await this.readVaultText(root)) ?? "").project ?? ""}`;
  }

  /** Look for LeanPane again (it may have been enabled, disabled or replaced). */
  recheck() {
    this.bridge.recheck();
  }

  dispose() {
    for (const s of this.views.values()) if (s.timer) window.clearTimeout(s.timer);
    this.views.clear();
    if (this.editTimer) window.clearTimeout(this.editTimer);
    this.editTimer = null;
    this.bridge.dispose();
    this.store.dispose();
    this.updated.clear();
    this.apiListeners.clear();
  }

  available(): boolean {
    return this.bridge.available();
  }

  /** The panel and settings redraw when anything about Lean or the blueprint changed. */
  onUpdated(cb: () => void): () => void {
    this.updated.add(cb);
    return () => this.updated.delete(cb);
  }
  private notifyUpdated() {
    for (const l of [...this.updated]) {
      try {
        l();
      } catch (e) {
        console.error("[TeXPane] lean update listener failed", e);
      }
    }
  }

  // ---------------------------------------------------------------- reading
  private async readVaultText(p: string): Promise<string | null> {
    const open = this.plugin.latexViews().find((v) => v.file?.path === p);
    if (open) return open.getViewData();
    const f = this.app.vault.getAbstractFileByPath(p);
    if (!(f instanceof TFile)) return null;
    try {
      return await this.app.vault.cachedRead(f);
    } catch {
      return null;
    }
  }

  private absOf(vaultPath: string): string {
    return path.join(this.plugin.notes.basePath(), ...vaultPath.split("/"));
  }
  private rootOf(view: LatexWorkspaceView): string | null {
    const s = view.getSession();
    if (!s) return null;
    return toVaultRel(this.plugin.notes.basePath(), s.project.rootAbsPath);
  }

  // ---------------------------------------------------------------- Lean project of a LaTeX project
  /** Lean project for a LaTeX root file (vault path): the `% !LEAN project` comment wins, else LeanPane walks up from the file. */
  async lookupProject(rootRel: string, fallbackFile?: string): Promise<LeanProjectInfo | null> {
    if (!this.bridge.available()) return null;
    const text = (await this.readVaultText(rootRel)) ?? "";
    const magic = parseLeanMagic(text).project;
    if (magic !== undefined) {
      const folder = resolveVaultRelative(rootRel, magic);
      if (folder === null) return null;
      return this.bridge.projectFor(folder ? `${folder}/x.lean` : "x.lean");
    }
    const info = await this.bridge.projectFor(rootRel);
    if (info || !fallbackFile || fallbackFile === rootRel) return info;
    return this.bridge.projectFor(fallbackFile);
  }

  private stateOf(view: LatexWorkspaceView): ViewState {
    let st = this.views.get(view);
    if (!st) this.views.set(view, (st = { key: "", info: undefined, resolving: null, timer: null, running: false, again: false }));
    return st;
  }

  /** Resolve (and cache) the Lean project of a view. */
  ensureProject(view: LatexWorkspaceView): Promise<LeanProjectInfo | null> {
    const st = this.stateOf(view);
    if (st.resolving) return st.resolving;
    const root = this.rootOf(view);
    if (!root || !this.bridge.available()) return Promise.resolve(null);
    const p = this.lookupProject(root, view.file?.path).then((info) => {
      st.info = info;
      st.resolving = null;
      return info;
    });
    st.resolving = p;
    void p.catch(() => (st.resolving = null));
    return p;
  }

  availability(view: LatexWorkspaceView): LeanAvailability {
    if (!this.bridge.available()) return "no-leanpane";
    const st = this.views.get(view);
    if (!st || st.info === undefined) {
      // resolve once; the answer (a project or "none") is remembered, so this cannot loop
      if (st && !st.resolving && this.rootOf(view)) void this.ensureProject(view).then(() => this.touchChips(view));
      return "pending";
    }
    return st.info ? "ready" : "no-project";
  }

  // ---------------------------------------------------------------- per view
  attachView(view: LatexWorkspaceView) {
    const st = this.stateOf(view);
    st.info = undefined;
    st.resolving = null;
    this.scheduleView(view, 50);
  }
  detachView(view: LatexWorkspaceView) {
    const st = this.views.get(view);
    if (st?.timer) window.clearTimeout(st.timer);
    this.views.delete(view);
  }
  /** The editor text changed: the blueprint cache is stale soon. */
  viewEdited(_view: LatexWorkspaceView) {
    this.texChanged();
  }
  /** A .tex file changed anywhere. */
  texChanged() {
    if (this.editTimer) window.clearTimeout(this.editTimer);
    this.editTimer = window.setTimeout(() => {
      this.editTimer = null;
      this.store.invalidate();
    }, EDIT_DEBOUNCE_MS);
  }

  /** Check every open view again. `forget`: LeanPane appeared, left or was replaced, so every project answer is stale. */
  private refreshAll(forget = false) {
    for (const [v, st] of this.views) {
      if (forget) {
        st.info = undefined;
        st.resolving = null;
      }
      this.scheduleView(v, 150);
    }
  }
  private scheduleView(view: LatexWorkspaceView, delay: number) {
    const st = this.stateOf(view);
    if (st.timer) window.clearTimeout(st.timer);
    st.timer = window.setTimeout(() => {
      st.timer = null;
      void this.runView(view);
    }, delay);
  }
  /** One check at a time per view: a second request while one runs makes it run again afterwards (never in parallel). */
  private async runView(view: LatexWorkspaceView) {
    const st = this.views.get(view);
    if (!st) return;
    if (st.running) {
      st.again = true;
      return;
    }
    st.running = true;
    try {
      do {
        st.again = false;
        await this.computeView(view).catch((e) => console.warn("[TeXPane] Lean check failed", e));
      } while (st.again && this.views.has(view));
    } finally {
      st.running = false;
    }
  }
  private touchChips(view: LatexWorkspaceView) {
    if (this.views.has(view)) view.refreshLean();
  }

  private async computeView(view: LatexWorkspaceView) {
    if (!this.views.has(view)) return;
    if (!this.bridge.available()) {
      view.setLeanDiagnostics([]);
      view.refreshLean();
      return;
    }
    const root = this.rootOf(view);
    // another root file, or the magic comment changed: look the project up again
    const st = this.stateOf(view);
    const key = await this.projectKey(view);
    if (key !== st.key) {
      st.key = key;
      st.info = undefined;
      st.resolving = null;
    }
    const info = root ? await this.ensureProject(view) : null;
    if (!this.views.has(view)) return;
    if (!root || !info) {
      view.setLeanDiagnostics([]);
      view.refreshLean();
      return;
    }
    const bp = await this.store.get(root);
    const names = [...new Set(bp.nodes.flatMap((n) => n.lean))];
    await this.bridge.request(
      info.root,
      names.filter((n) => !this.bridge.statusOf(info.root, n)),
    );
    if (!this.views.has(view)) return;
    const mismatches = detectMismatches(bp.nodes, this.bridge.statusMap(info.root), bp.sources);
    view.setLeanDiagnostics(mismatches.map((m) => this.toDiagnostic(root, m)));
    view.refreshLean();
    if (this.plugin.settings.syncLeanok && !this.syncing && mismatches.some((m) => m.auto && m.fix)) {
      this.syncing = true;
      try {
        // decide on the text as it is right now, not on the cached parse: an earlier pass may just have edited it
        const fresh = (await this.currentMismatches(root, true)).filter((m) => m.auto && m.fix);
        if (fresh.length) {
          await this.applyEdits(fresh.flatMap((m) => m.fix!.edits));
          this.store.invalidate();
        }
      } finally {
        this.syncing = false;
      }
    }
  }

  private toDiagnostic(root: string, m: Mismatch): Diagnostic {
    return {
      severity: "warning",
      file: this.absOf(m.file),
      line: m.line,
      col: m.col,
      endCol: m.endCol,
      message: m.message,
      source: "lean",
      fixes: m.fix ? [{ label: m.fix.label, run: () => this.runFix(root, m.kind, m.label) }] : undefined,
    };
  }

  /** Re-derive the mismatch from the current text, then apply its fix (the line numbers may have moved since the diagnostic was made). */
  private async runFix(root: string, kind: MismatchKind, label: string) {
    const m = (await this.currentMismatches(root, true)).find((x) => x.kind === kind && x.label === label && x.fix);
    if (!m?.fix) {
      new Notice("TeXPane: this \\leanok problem no longer applies.");
      return;
    }
    await this.applyEdits(m.fix.edits);
    this.store.invalidate();
  }

  /** Mismatches for the project; `fresh` re-reads the files instead of using the cached parse. */
  private async currentMismatches(root: string, fresh = false): Promise<Mismatch[]> {
    const info = await this.lookupProject(root);
    if (!info) return [];
    let bp: { nodes: BlueprintNode[]; sources: BlueprintSource[] };
    if (fresh) {
      const sources = await collectBlueprintSources(root, (p) => this.readVaultText(p));
      bp = { sources, nodes: parseBlueprint(sources) };
    } else bp = await this.store.get(root);
    return detectMismatches(bp.nodes, this.bridge.statusMap(info.root), bp.sources);
  }

  /** Command: apply every \leanok fix for the active project. */
  async fixAll(view: LatexWorkspaceView) {
    const root = this.rootOf(view);
    if (!root) return;
    const fixes = (await this.currentMismatches(root, true)).filter((m) => m.fix && m.kind !== "lean-missing");
    if (!fixes.length) {
      new Notice("TeXPane: \\leanok already matches Lean.");
      return;
    }
    await this.applyEdits(fixes.flatMap((m) => m.fix!.edits));
    this.store.invalidate();
    new Notice(`TeXPane: updated \\leanok in ${fixes.length} place${fixes.length === 1 ? "" : "s"}.`);
  }

  // ---------------------------------------------------------------- editing files
  /** Apply line edits to open editors or, for files that are not open, to the file itself. */
  async applyEdits(edits: readonly TextEdit[]) {
    const byFile = new Map<string, TextEdit[]>();
    for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    for (const [file, list] of byFile) {
      const view = this.plugin.latexViews().find((v) => v.file?.path === file);
      if (view) {
        const ed = view.getEditor();
        const changes = editsToChanges(ed.state.doc.toString(), list);
        if (changes.length) ed.dispatch({ changes, userEvent: "input.lean" });
        continue;
      }
      const f = this.app.vault.getAbstractFileByPath(file);
      if (f instanceof TFile) await this.app.vault.process(f, (t) => applyChanges(t, editsToChanges(t, list)));
    }
  }

  // ---------------------------------------------------------------- editor hosts
  chipHost(view: LatexWorkspaceView): LeanChipHost {
    return {
      availability: () => this.availability(view),
      status: (name) => {
        const info = this.views.get(view)?.info;
        if (!info) return undefined;
        this.bridge.want(info.root, [name]);
        return this.bridge.statusOf(info.root, name);
      },
      open: (name, newTab) => void this.openDeclaration(view, name, newTab),
    };
  }

  completionHost(view: LatexWorkspaceView): NonNullable<CompletionHost["lean"]> {
    return {
      declarations: (typed) => {
        if (!this.bridge.available()) return null;
        return this.ensureProject(view).then((info) => (info ? this.declarations(info.root, typed) : { items: [], complete: true }));
      },
    };
  }

  /** Declarations for completion: the whole list when it is small, else the ones starting with what was typed. */
  private async declarations(root: string, typed: string): Promise<{ items: DeclSummary[]; complete: boolean }> {
    const api = this.bridge.api();
    if (!api) return { items: [], complete: true };
    let c = this.declCache.get(root);
    if (!c || Date.now() - c.at > DECL_TTL_MS) {
      const items = await api.listDeclarations(root);
      c = { at: Date.now(), items, huge: items.length >= HUGE_LIST };
      this.declCache.set(root, c);
    }
    if (!c.huge) return { items: c.items, complete: true };
    if (typed.length < 2) return { items: c.items.slice(0, 300), complete: false };
    return { items: await api.listDeclarations(root, typed), complete: false };
  }

  async openDeclaration(view: LatexWorkspaceView, name: string, newTab: boolean) {
    const api = this.bridge.api();
    if (!api) {
      new Notice("TeXPane: LeanPane isn't installed, so there is nothing to open the declaration in.");
      return;
    }
    const info = await this.ensureProject(view);
    if (!info) {
      new Notice("TeXPane: no Lean project found for this file.");
      return;
    }
    await this.openDeclarationIn(info.root, name, newTab);
  }
  async openDeclarationIn(projectRoot: string, name: string, newTab = false) {
    const api = this.bridge.api();
    if (!api) return;
    try {
      const ok = await api.openDeclaration(projectRoot, name, { newLeaf: newTab });
      if (!ok) new Notice(`TeXPane: Lean has no declaration "${name}" yet.`);
    } catch (e) {
      new Notice(`TeXPane: could not open ${name}: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- progress panel
  /** Vault path of the root file of the project the active LaTeX view belongs to. */
  activeRoot(): string | null {
    const v = this.plugin.activeLatexView();
    return v ? this.rootOf(v) : null;
  }

  async panelData(root: string, refresh = false): Promise<PanelData> {
    const bp: ParsedBlueprint = await this.store.get(root);
    const info = await this.lookupProject(root);
    if (info) {
      const names = [...new Set(bp.nodes.flatMap((n) => n.lean))];
      await this.bridge.request(
        info.root,
        refresh ? names : names.filter((n) => !this.bridge.statusOf(info.root, n)),
        refresh,
      );
    }
    const statuses = info ? this.bridge.statusMap(info.root) : new Map();
    return { root, name: path.posix.basename(path.posix.dirname(root) === "." ? root : path.posix.dirname(root)) || root, info, nodes: bp.nodes, sources: bp.sources, graph: buildGraph(bp.nodes, statuses) };
  }

  // ---------------------------------------------------------------- Formalize this
  /** Blueprint node under the cursor of this file (statement or its proof). */
  nodeAtCursor(view: LatexWorkspaceView): { node: BlueprintNode; sources: BlueprintSource[] } | null {
    const file = view.file?.path;
    if (!file || !view.isTex()) return null;
    const sources = [{ file, text: view.getViewData() }];
    const line = view.getEditor().state.doc.lineAt(view.getEditor().state.selection.main.head).number;
    const node = parseBlueprint(sources).find((n) => (line >= n.line && line <= n.endLine) || (n.proofLine !== undefined && line >= n.proofLine && line <= (n.proofEndLine ?? n.proofLine)));
    return node ? { node, sources } : null;
  }

  canFormalize(view: LatexWorkspaceView): boolean {
    return this.bridge.available() && this.nodeAtCursor(view) !== null;
  }

  async formalize(view: LatexWorkspaceView) {
    const api = this.bridge.api();
    if (!api) return;
    const hit = this.nodeAtCursor(view);
    if (!hit) {
      new Notice("TeXPane: put the cursor inside a theorem, lemma, definition or similar environment (with a \\label).");
      return;
    }
    const info = await this.ensureProject(view);
    if (!info) {
      new Notice('TeXPane: no Lean project found for this file. Put the .tex file inside a Lean project, or add "% !LEAN project = <folder>" to the root file.');
      return;
    }
    const { node } = hit;
    if (node.lean.length) {
      new Notice(`TeXPane: ${node.label} already points to ${node.lean.join(", ")}.`);
      return;
    }
    new PromptModal(this.app, "Formalize this", "Lean declaration name", leanNameFromLabel(node.label, node.env), "Next", (name) => {
      if (!isValidLeanName(name)) {
        new Notice(`TeXPane: "${name}" is not a valid Lean name.`);
        return;
      }
      this.pickLeanFile(info, (file) => void this.createAndLink(view, info, node.label, name, file));
    }).open();
  }

  private pickLeanFile(info: LeanProjectInfo, done: (vaultPath: string) => void) {
    const under = (p: string) => (info.root === "" ? true : p.startsWith(info.root + "/"));
    const rel = (p: string) => (info.root === "" ? p : p.slice(info.root.length + 1));
    const files = this.app.vault
      .getFiles()
      .filter((f) => f.extension === "lean" && under(f.path) && !/(^|\/)\.lake\//.test(f.path))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    const last = this.lastLeanFile.get(info.root);
    files.sort((a, b) => Number(b.path === last) - Number(a.path === last));
    const items: PickItem[] = [...files.map((f): PickItem => ({ kind: "file", file: f, label: rel(f.path) })), { kind: "new", label: "New Lean file…" }];
    new LeanFilePicker(this.app, items, (item) => {
      if (item.kind === "file") {
        done(item.file.path);
        return;
      }
      new PromptModal(this.app, "New Lean file", "Path inside the Lean project", "Blueprint.lean", "Create", async (v) => {
        const clean = v.replace(/\\/g, "/").replace(/^\/+/, "");
        if (!clean || clean.split("/").includes("..")) return;
        const target = `${info.root ? info.root + "/" : ""}${/\.lean$/i.test(clean) ? clean : clean + ".lean"}`;
        try {
          if (!this.app.vault.getAbstractFileByPath(target)) {
            const dir = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
            await this.plugin.ensureFolder(dir);
            await this.app.vault.create(target, "");
          }
          done(target);
        } catch (e) {
          new Notice(`TeXPane: could not create ${target}: ${(e as Error).message}`);
        }
      }).open();
    }).open();
  }

  private async createAndLink(view: LatexWorkspaceView, info: LeanProjectInfo, label: string, name: string, leanFile: string) {
    const api = this.bridge.api();
    if (!api || !view.file) return;
    // the text may have changed while the dialogs were open: look the statement up again
    const sources = [{ file: view.file.path, text: view.getViewData() }];
    const node = parseBlueprint(sources).find((n) => n.label === label);
    if (!node) {
      new Notice(`TeXPane: ${label} is no longer in this file.`);
      return;
    }
    try {
      const res = await api.createStub(info.root, { file: leanFile, name, docstring: statementText(sources, node) });
      this.lastLeanFile.set(info.root, leanFile);
      const lines = sources[0].text.split(/\r?\n/);
      const at = labelLine(lines, node) ?? node.line;
      const indent = /^\s*/.exec(lines[at - 1] ?? "")![0];
      await this.applyEdits([{ file: view.file.path, line: at, op: "insert-after", text: `${indent}\\lean{${name}}` }]);
      new Notice(`TeXPane: created ${name} in ${res.file}:${res.line}`);
      void this.bridge.request(info.root, [name], true);
    } catch (e) {
      new Notice(`TeXPane: LeanPane could not create the declaration: ${(e as Error).message}`, 8000);
    }
  }

  // ---------------------------------------------------------------- TeXPane's API for LeanPane
  readonly api: TeXPaneApiV1 = {
    version: API_VERSION,
    blueprintRefs: (leanName) => this.blueprintRefs(leanName),
    openLocation: (file, line) => this.openLocation(file, line),
    addBlueprintEntry: (req) => this.addBlueprintEntry(req),
    onBlueprintChanged: (cb) => {
      this.apiListeners.add(cb);
      return () => this.apiListeners.delete(cb);
    },
  };

  private async blueprintRefs(leanName: string) {
    const mains = new Set(this.plugin.projects().map((p) => p.main));
    for (const v of this.plugin.latexViews()) {
      const r = this.rootOf(v);
      if (r) mains.add(r);
    }
    const out: Array<{ file: string; line: number; label: string; env: string; title?: string; leanok: boolean }> = [];
    const seen = new Set<string>();
    for (const main of mains) {
      let bp: ParsedBlueprint;
      try {
        bp = await this.store.get(main);
      } catch {
        continue;
      }
      for (const n of bp.nodes) {
        if (!n.lean.includes(leanName)) continue;
        const k = `${n.file}:${n.line}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ file: n.file, line: n.line, label: n.label, env: n.env, title: n.title, leanok: n.env === "definition" ? n.leanok : n.proofLine !== undefined ? n.proofLeanok : n.leanok });
      }
    }
    return out;
  }

  private async openLocation(file: string, line: number): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(file);
    if (!(f instanceof TFile)) throw new Error(`TeXPane: ${file} is not in the vault`);
    const view = this.plugin.latexViews().find((v) => v.file === f);
    if (view) {
      this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
      view.revealLine(line);
      return;
    }
    await this.app.workspace.getLeaf("tab").openFile(f, { eState: { line: line - 1 } });
  }

  private async addBlueprintEntry(req: { texFile: string; env: string; label: string; leanName: string; statement: string }): Promise<{ file: string; line: number }> {
    const f = this.app.vault.getAbstractFileByPath(req.texFile);
    if (!(f instanceof TFile)) throw new Error(`TeXPane: ${req.texFile} is not in the vault`);
    const view = this.plugin.latexViews().find((v) => v.file === f);
    if (view) {
      const ed = view.getEditor();
      const { change, line } = blueprintEntryChange(ed.state.doc.toString(), req);
      ed.dispatch({ changes: change, userEvent: "input.lean" });
      return { file: req.texFile, line };
    }
    let line = 1;
    await this.app.vault.process(f, (t) => {
      const r = blueprintEntryChange(t, req);
      line = r.line;
      return applyChanges(t, [r.change]);
    });
    return { file: req.texFile, line };
  }
}
