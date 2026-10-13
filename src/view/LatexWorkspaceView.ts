import { Menu, Notice, Platform, TFile, TextFileView, WorkspaceLeaf, setIcon, type ViewStateResult } from "obsidian";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Annotation, Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { bracketMatching, indentUnit } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { nextDiagnostic, previousDiagnostic } from "@codemirror/lint";
import type TexPanePlugin from "../main";
import type { LayoutMode } from "../settings";
import type { Diagnostic, BuildResult, ProjectInfo } from "../types";
import { PdfPane } from "./PdfPane";
import { LogDrawer } from "./LogDrawer";
import { bibSyntax, latexSyntax } from "../editor/latexLanguage";
import { latexAutocomplete } from "../editor/completion";
import { envAutoClose } from "../editor/envAutoClose";
import { applyDiagnostics, diagnosticsGutter } from "../editor/diagnostics";
import { embedChips, refreshChips } from "../editor/embedChips";
import { bold, italic, toggleComment } from "../editor/editing";
import { flashLine, lineFlashField } from "../editor/lineFlash";
import { extractLabels } from "../core/indexers";
import { resolveProject } from "../core/projectResolver";
import { forwardSearch, inverseSearch, type MappedLocation } from "../core/syncMap";
import { buildEnv, installHint } from "../core/toolchain";
import { toVaultRel } from "../core/paths";
import type { ProjectSession, SessionEvent } from "../session";

export const VIEW_TYPE = "texpane-workspace";
const External = Annotation.define<boolean>();
const LAYOUT_ICONS: Record<LayoutMode, string> = { split: "columns-2", editor: "file-code", pdf: "file-text" };

export class LatexWorkspaceView extends TextFileView {
  private plugin: TexPanePlugin;
  private editor!: EditorView;
  private wrapComp = new Compartment();
  private pdf: PdfPane | null = null;
  private log!: LogDrawer;
  private session: ProjectSession | null = null;
  private unlisten: (() => void) | null = null;
  private rootEl!: HTMLElement;
  private mainEl!: HTMLElement;
  private editorPane!: HTMLElement;
  private dividerEl!: HTMLElement;
  private pdfPane!: HTMLElement;
  private layout: LayoutMode = "split";
  private ratio = 0.5;
  private ratioSaveTimer: number | null = null;
  private resizeObs: ResizeObserver | null = null;
  private recompileBtn!: HTMLElement;
  private logBtn!: HTMLElement;
  private layoutBtn!: HTMLElement;
  private syncBtn!: HTMLElement;
  private lastDiags: Diagnostic[] = [];
  private pendingReveal: { line: number; col?: number } | null = null;
  private pdfLoadedFor = "";
  private bindToken = 0;
  private manualSave = false;
  private currentRoot = "";

  constructor(leaf: WorkspaceLeaf, plugin: TexPanePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = true;
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return this.file?.basename ?? "LaTeX";
  }
  getIcon() {
    return "sigma";
  }
  isTex(): boolean {
    return (this.file?.extension ?? "tex") === "tex";
  }
  getSession() {
    return this.session;
  }
  getEditor() {
    return this.editor;
  }
  absPath(): string {
    return this.file ? path.join(this.plugin.notes.basePath(), ...this.file.path.split("/")) : "";
  }

  // ---------------------------------------------------------------- lifecycle
  async onOpen() {
    const el = this.contentEl;
    el.empty();
    el.addClass("texpane-view");
    this.rootEl = el.createDiv({ cls: "tp-root" });
    this.mainEl = this.rootEl.createDiv({ cls: "tp-main" });
    this.editorPane = this.mainEl.createDiv({ cls: "tp-editor-pane" });
    this.dividerEl = this.mainEl.createDiv({ cls: "tp-divider", attr: { "aria-label": "Drag to resize, double-click to reset" } });
    this.pdfPane = this.mainEl.createDiv({ cls: "tp-pdf-pane" });
    this.pdf = new PdfPane(this.pdfPane, { onInverse: (p, x, y) => void this.onInverse(p, x, y) });
    this.log = new LogDrawer(this.rootEl, { onSelect: (d) => void this.openDiagnostic(d), label: (f) => this.labelFor(f) });
    this.layout = this.plugin.settings.openIn;

    this.editor = new EditorView({ state: this.makeState(""), parent: this.editorPane });
    this.setupHeader();
    this.setupDivider();
    this.applyStyleSettings();
    this.applyLayout();

    this.resizeObs = new ResizeObserver(() => this.layoutResize());
    this.resizeObs.observe(this.rootEl);
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.refreshChipsNow()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.refreshChipsNow()));
    this.registerEvent(this.app.vault.on("rename", () => this.refreshChipsNow()));
    this.registerEvent(this.app.vault.on("delete", () => this.refreshChipsNow()));
    this.registerEvent(this.app.vault.on("create", () => this.refreshChipsNow()));
  }

  async onClose() {
    if (this.ratioSaveTimer) window.clearTimeout(this.ratioSaveTimer);
    this.unbindSession();
    this.resizeObs?.disconnect();
    this.pdf?.dispose();
    this.pdf = null;
    this.editor?.destroy();
    this.contentEl.empty();
  }

  // ---------------------------------------------------------------- TextFileView contract
  getViewData(): string {
    return this.editor ? this.editor.state.doc.toString() : this.data;
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (!this.editor) return;
    if (clear) {
      this.editor.setState(this.makeState(data));
      if (this.lastDiags.length) this.applyEditorDiagnostics();
    } else if (data !== this.editor.state.doc.toString()) {
      const sel = this.editor.state.selection.main;
      this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: data }, selection: { anchor: Math.min(sel.head, data.length) }, annotations: External.of(true) });
    }
    this.applyLayoutForFile();
    if (this.pendingReveal) {
      const r = this.pendingReveal;
      this.pendingReveal = null;
      this.revealLine(r.line, r.col);
    }
  }

  clear(): void {
    if (this.editor) this.editor.setState(this.makeState(""));
    this.data = "";
  }

  async onLoadFile(file: TFile) {
    await super.onLoadFile(file);
    this.applyLayoutForFile();
    await this.bindSession();
  }

  async onUnloadFile(file: TFile) {
    // super saves pending edits first; unbind afterwards so the session still sees this view while saving
    await super.onUnloadFile(file);
    this.unbindSession();
  }

  async onRename(file: TFile) {
    await super.onRename(file);
    await this.bindSession();
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
  }

  setEphemeralState(state: any): void {
    super.setEphemeralState(state);
    if (state && typeof state.line === "number") {
      if (this.editor && this.file) this.revealLine(state.line + 1, state.column !== undefined ? state.column + 1 : undefined);
      else this.pendingReveal = { line: state.line + 1 };
    }
  }

  async save(clear?: boolean): Promise<void> {
    await super.save(clear);
    if (this.manualSave) {
      this.manualSave = false;
      void this.recompile();
    }
  }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    if (source !== "more-options" && source !== "tab-header") return;
    menu.addSeparator();
    for (const [id, label] of [["pdflatex", "pdfLaTeX"], ["xelatex", "XeLaTeX"], ["lualatex", "LuaLaTeX"]] as const) {
      menu.addItem((i) =>
        i
          .setTitle(`Engine: ${label}`)
          .setIcon("cpu")
          .setChecked((this.session?.project.engine ?? this.plugin.settings.engine) === id)
          .onClick(async () => {
            this.plugin.settings.engine = id;
            await this.plugin.saveSettings();
            new Notice(`TeXPane: default engine is now ${label}. A "% !TEX program" comment still overrides it.`);
            void this.recompile();
          }),
      );
    }
    menu.addItem((i) => i.setTitle("Export flattened project…").setIcon("package").onClick(() => void this.plugin.exportFlattened(this)));
    menu.addItem((i) => i.setTitle("Clean build files").setIcon("trash-2").onClick(() => void this.plugin.cleanBuild(this)));
    menu.addItem((i) => i.setTitle(Platform.isMacOS ? "Reveal PDF in Finder" : "Reveal PDF in file manager").setIcon("folder-open").onClick(() => this.plugin.revealPdf(this)));
  }

  // ---------------------------------------------------------------- editor
  private host() {
    const notes = this.plugin.notes;
    const view = this;
    return {
      completion: {
        labels: () => {
          const here = view.absPath();
          const idx = view.session?.index.labels().filter((l) => l.file !== here) ?? [];
          return [...idx, ...extractLabels(view.getViewData(), here)];
        },
        bibEntries: () => view.session?.index.bibEntries() ?? [],
        notes: () => notes.suggestions(),
        headingsOf: (n: string) => notes.headings(n, view.file?.path ?? ""),
        blocksOf: (n: string) => notes.blocks(n, view.file?.path ?? ""),
      },
      chips: {
        exists: (n: string) => !!notes.findFile(n, view.file?.path ?? "") && notes.findFile(n, view.file?.path ?? "")!.extension === "md",
        open: (n: string, newTab: boolean) => {
          const f = notes.findFile(n, view.file?.path ?? "");
          if (f) void view.app.workspace.getLeaf(newTab ? "split" : "tab").openFile(f);
        },
        hover: (ev: MouseEvent, el: HTMLElement, linktext: string) => {
          (view.app.workspace as any).trigger("hover-link", { event: ev, source: "texpane", hoverParent: view, targetEl: el, linktext: linktext.replace(/\.md$/, ""), sourcePath: view.file?.path ?? "" });
        },
        dragNote: (ev: DragEvent) => view.plugin.noteFromDrag(ev),
      },
    };
  }

  private makeState(doc: string): EditorState {
    const s = this.plugin.settings;
    const host = this.host();
    const ext = this.file?.extension ?? "tex";
    const keys = keymap.of([
      { key: "Mod-Enter", run: () => (void this.recompile(), true) },
      { key: "Mod-s", run: () => ((this.manualSave = true), void this.save(), true) },
      { key: "Mod-/", run: toggleComment },
      { key: "Mod-b", run: bold },
      { key: "Mod-i", run: italic },
    ]);
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      bracketMatching(),
      closeBrackets(),
      indentUnit.of("  "),
      EditorState.tabSize.of(2),
      search({ top: true }),
      this.wrapComp.of(s.softWrap ? EditorView.lineWrapping : []),
      ext === "bib" ? bibSyntax() : latexSyntax(),
      latexAutocomplete(host.completion),
      diagnosticsGutter(),
      lineFlashField,
      Prec.highest(envAutoClose),
      Prec.high(keys),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap]),
      EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        if (u.transactions.some((t) => t.annotation(External))) {
          this.session?.schedule();
          return;
        }
        this.data = u.state.doc.toString();
        this.requestSave();
        this.onUserEdit();
      }),
    ];
    if (ext === "tex") extensions.push(embedChips(host.chips));
    return EditorState.create({ doc, extensions });
  }

  private onUserEdit() {
    this.session?.schedule();
  }

  private refreshChipsNow() {
    try {
      this.editor?.dispatch({ effects: refreshChips.of(null) });
    } catch {
      /* destroyed */
    }
  }

  revealLine(line: number, col?: number) {
    if (!this.editor) return;
    const doc = this.editor.state.doc;
    const n = Math.min(Math.max(1, line), doc.lines);
    const l = doc.line(n);
    const pos = Math.min(l.from + Math.max(0, (col ?? 1) - 1), l.to);
    this.editor.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    flashLine(this.editor, n);
    this.editor.focus();
  }

  insertAtCursor(text: string) {
    const r = this.editor.state.selection.main;
    this.editor.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length }, userEvent: "input" });
    this.editor.focus();
  }

  applyStyleSettings() {
    const s = this.plugin.settings;
    const el = this.contentEl;
    el.style.setProperty("--tp-font-size", `${s.fontSize}px`);
    el.toggleClass("tp-follow-theme", s.syntaxColours === "theme");
    el.toggleClass("tp-accent", s.useAccent);
    this.pdf?.setDark(s.pdfDarkMode);
    this.editor?.dispatch({ effects: this.wrapComp.reconfigure(s.softWrap ? EditorView.lineWrapping : []) });
  }

  // ---------------------------------------------------------------- header + layout
  private setupHeader() {
    this.recompileBtn = this.addAction("refresh-cw", "Recompile", () => void this.recompile());
    this.recompileBtn.addClass("tp-action-recompile");
    this.layoutBtn = this.addAction("columns-2", "Layout", (e) => this.layoutMenu(e));
    this.syncBtn = this.addAction("locate", "Sync to PDF", () => void this.syncToPdf());
    this.logBtn = this.addAction("alert-triangle", "Log", () => this.toggleLog());
    this.logBtn.addClass("tp-action-log");
  }

  private layoutMenu(e: MouseEvent) {
    const m = new Menu();
    for (const [id, label] of [["split", "Split"], ["editor", "Editor only"], ["pdf", "PDF only"]] as const) {
      m.addItem((i) => i.setTitle(label).setIcon(LAYOUT_ICONS[id]).setChecked(this.layout === id).onClick(() => this.setLayout(id)));
    }
    m.showAtMouseEvent(e);
  }

  cycleLayout() {
    const order: LayoutMode[] = ["split", "editor", "pdf"];
    this.setLayout(order[(order.indexOf(this.layout) + 1) % order.length]);
  }

  setLayout(l: LayoutMode) {
    this.layout = l;
    this.applyLayout();
  }

  private applyLayoutForFile() {
    const tex = this.isTex();
    this.rootEl.toggleClass("no-pdf", !tex);
    this.syncBtn?.toggleClass("is-hidden", !tex);
    this.layoutBtn?.toggleClass("is-hidden", !tex);
    this.applyLayout();
  }

  private applyLayout() {
    const eff: LayoutMode = this.isTex() ? this.layout : "editor";
    for (const l of ["split", "editor", "pdf"]) this.rootEl.toggleClass(`layout-${l}`, l === eff);
    setIcon(this.layoutBtn, LAYOUT_ICONS[this.layout]);
    this.applyRatio();
  }

  private applyRatio() {
    const key = this.projectKey();
    const r = this.plugin.settings.splitRatios[key] ?? 0.5;
    this.ratio = r;
    this.editorPane.style.flex = `${r} 1 0`;
    this.pdfPane.style.flex = `${1 - r} 1 0`;
  }

  private projectKey(): string {
    const root = this.session?.project.rootAbsPath ?? this.absPath();
    return toVaultRel(this.plugin.notes.basePath(), root) ?? root;
  }

  private layoutResize() {
    const w = this.rootEl.clientWidth;
    this.rootEl.toggleClass("is-narrow", w > 0 && w < 560);
  }

  private setupDivider() {
    const d = this.dividerEl;
    d.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      d.addClass("is-dragging");
      const move = (ev: PointerEvent) => {
        const rect = this.mainEl.getBoundingClientRect();
        const vertical = this.rootEl.hasClass("is-narrow");
        const raw = vertical ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
        this.ratio = Math.min(0.85, Math.max(0.15, raw));
        this.editorPane.style.flex = `${this.ratio} 1 0`;
        this.pdfPane.style.flex = `${1 - this.ratio} 1 0`;
      };
      const up = () => {
        d.removeClass("is-dragging");
        d.removeEventListener("pointermove", move);
        d.removeEventListener("pointerup", up);
        d.removeEventListener("pointercancel", up);
        this.saveRatio();
      };
      d.addEventListener("pointermove", move);
      d.addEventListener("pointerup", up);
      d.addEventListener("pointercancel", up);
    });
    d.addEventListener("dblclick", () => {
      this.ratio = 0.5;
      this.editorPane.style.flex = "0.5 1 0";
      this.pdfPane.style.flex = "0.5 1 0";
      this.saveRatio();
    });
  }

  private saveRatio() {
    this.plugin.settings.splitRatios[this.projectKey()] = this.ratio;
    if (this.ratioSaveTimer) window.clearTimeout(this.ratioSaveTimer);
    this.ratioSaveTimer = window.setTimeout(() => void this.plugin.saveSettings(), 400);
  }

  toggleLog() {
    this.log.toggle();
  }
  isLogOpen() {
    return this.log.isOpen();
  }

  // ---------------------------------------------------------------- session binding
  private async bindSession() {
    const token = ++this.bindToken;
    this.unbindSession();
    if (!this.file) return;
    const info = await this.resolveProjectInfo();
    if (token !== this.bindToken || !this.file) return;
    const session = this.plugin.sessionFor(info);
    const resolver = () => this.resolveProjectInfo();
    session.resolver = resolver;
    this.session = session;
    this.currentRoot = info.rootAbsPath;
    this.applyRatio();
    const listener = (e: SessionEvent) => this.onSessionEvent(e);
    session.listeners.add(listener);
    this.unlisten = () => {
      session.listeners.delete(listener);
      // a closed view (or one showing another file) must not resolve this project any more
      if (session.resolver === resolver) session.resolver = null;
    };
    this.pdfLoadedFor = "";
    if (session.last) this.onResult(session.last, false);
    else await this.showExistingPdf(info);
    this.updateBusy(session.state);
    if (this.isTex() || session.last === null) {
      if (this.plugin.settings.autoCompile && !session.last) void session.compileNow().catch(() => undefined);
    }
    this.plugin.updateStatusBar();
  }

  private unbindSession() {
    this.unlisten?.();
    this.unlisten = null;
  }

  private async resolveProjectInfo(): Promise<ProjectInfo> {
    const s = this.plugin.settings;
    return resolveProject({
      filePath: this.absPath(),
      content: this.editor ? this.getViewData() : undefined,
      vaultBase: this.plugin.notes.basePath(),
      defaultEngine: s.engine,
      buildFolder: s.buildFolder,
      fs: {
        readFile: async (p) => {
          try {
            return await fsp.readFile(p, "utf8");
          } catch {
            return null;
          }
        },
        exists: async (p) => {
          try {
            await fsp.access(p);
            return true;
          } catch {
            return false;
          }
        },
      },
    });
  }

  private async showExistingPdf(info: ProjectInfo) {
    const pdf = path.join(info.buildDir, path.basename(info.rootAbsPath).replace(/\.tex$/i, "") + ".pdf");
    try {
      await fsp.access(pdf);
      await this.loadPdf(pdf);
    } catch {
      this.showNoPdfCard("Compiling… the PDF will appear here.");
    }
  }

  async recompile() {
    if (!this.session) await this.bindSession();
    try {
      await this.session?.compileNow();
    } catch (e) {
      if ((e as Error)?.message !== "cancelled") console.error(e);
    }
  }

  private onSessionEvent(e: SessionEvent) {
    if (e.type === "state") this.updateBusy(e.state);
    else if (e.type === "result") this.onResult(e.result, true);
    this.plugin.updateStatusBar();
  }

  private updateBusy(state: string) {
    const busy = state === "running" || state === "queued";
    this.recompileBtn?.toggleClass("is-spinning", busy);
    this.pdf?.setBuilding(busy);
  }

  private async loadPdf(pdfPath: string) {
    try {
      const buf = await fsp.readFile(pdfPath);
      const bytes = new Uint8Array(buf.length);
      bytes.set(buf);
      this.pdf?.showCard(null);
      await this.pdf?.load(bytes);
      this.pdfLoadedFor = pdfPath;
    } catch (e) {
      console.warn("[TeXPane] could not read PDF", e);
    }
  }

  private onResult(r: BuildResult, fresh: boolean) {
    this.lastDiags = r.diagnostics;
    this.log.set(r.diagnostics, r.rawLog || r.processOutput);
    this.applyEditorDiagnostics();
    const counts = this.log.counts();
    this.logBtn?.setAttr("data-count", String(counts.error + counts.warning));
    this.logBtn?.toggleClass("has-errors", counts.error > 0);
    this.logBtn?.toggleClass("has-warnings", counts.error === 0 && counts.warning > 0);
    this.logBtn?.setAttr("aria-label", `Log: ${counts.error} errors, ${counts.warning} warnings`);
    if (r.status === "no-toolchain") {
      this.showSetupCard();
      return;
    }
    const havePdf = !!r.pdfPath;
    if (havePdf && (r.pdfUpdated || this.pdfLoadedFor !== r.pdfPath)) void this.loadPdf(r.pdfPath!);
    this.pdf?.setStale(r.status === "errors" || r.status === "failed" || r.status === "timeout");
    if (!havePdf && r.status !== "cancelled" && !this.pdf?.hasDocument()) {
      this.showNoPdfCard("No PDF yet. Fix the first error in the log.");
      if (fresh && counts.error > 0) this.log.setOpen(true);
    }
  }

  private applyEditorDiagnostics() {
    if (!this.editor) return;
    const here = this.absPath();
    applyDiagnostics(this.editor, this.lastDiags.filter((d) => d.file && path.resolve(d.file) === path.resolve(here)));
  }

  private showNoPdfCard(text: string) {
    if (!this.pdf || this.pdf.hasDocument()) return;
    const card = createDiv({ cls: "tp-card" });
    card.createEl("strong", { text: "No PDF yet" });
    card.createEl("p", { text });
    this.pdf.showCard(card);
  }

  private showSetupCard() {
    if (!this.pdf) return;
    const tc = this.plugin.toolchain;
    const hint = installHint(process.platform);
    const card = createDiv({ cls: "tp-card tp-setup-card" });
    card.createEl("strong", { text: "LaTeX is not set up" });
    card.createEl("p", { text: tc?.missing.length ? `Missing: ${tc.missing.join(", ")}.` : "latexmk was not found." });
    card.createEl("p", { text: `${hint.title} (${hint.url})` });
    const ol = card.createEl("ol");
    hint.steps.forEach((s) => ol.createEl("li", { text: s }));
    const btn = card.createEl("button", { text: "Re-check", cls: "mod-cta" });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await this.plugin.detectToolchain();
      btn.disabled = false;
      if (this.plugin.toolchain?.found) {
        this.pdf?.showCard(null);
        void this.recompile();
      } else new Notice("TeXPane: latexmk still not found.");
    });
    this.pdf.showCard(card);
  }

  // ---------------------------------------------------------------- navigation
  private labelFor(file: string): string {
    const rel = toVaultRel(this.plugin.notes.basePath(), file);
    if (rel) return rel;
    const root = this.session?.project.cwd;
    if (root && path.relative(root, file) && !path.relative(root, file).startsWith("..")) return path.relative(root, file);
    return path.basename(file);
  }

  async openDiagnostic(d: Diagnostic) {
    if (d.note) {
      await this.openNote(d.note.path, d.note.line);
      return;
    }
    if (!d.file) return;
    await this.openLocation({ file: d.file, line: d.line ?? 1 });
  }

  private async openNote(notePath: string, line?: number) {
    const f = this.app.vault.getAbstractFileByPath(notePath);
    if (!(f instanceof TFile)) {
      new Notice(`TeXPane: note not found: ${notePath}`);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(f, line ? { eState: { line: line - 1 } } : undefined);
  }

  async openLocation(loc: MappedLocation) {
    if (loc.note) {
      await this.openNote(loc.note.path, loc.note.line);
      return;
    }
    const rel = toVaultRel(this.plugin.notes.basePath(), loc.file);
    const f = rel ? this.app.vault.getAbstractFileByPath(rel) : null;
    if (!(f instanceof TFile)) {
      new Notice(`TeXPane: ${loc.file} is outside the vault`);
      return;
    }
    if (f === this.file) this.revealLine(loc.line);
    else {
      this.pendingReveal = { line: loc.line };
      await this.leaf.openFile(f, { eState: { line: loc.line - 1 } });
    }
  }

  private syncArgs() {
    const s = this.session;
    const r = s?.last;
    const tc = this.plugin.toolchain;
    if (!s || !r || !r.pdfPath || !tc?.synctex) return null;
    return {
      synctexPath: tc.synctex.path,
      mapping: r.mapping,
      pdfFile: r.pdfPath,
      buildDir: s.project.buildDir,
      env: buildEnv({ binDir: tc.binDir }, process.env),
      cwd: s.project.cwd,
    };
  }

  async syncToPdf() {
    if (!this.isTex()) return;
    const a = this.syncArgs();
    if (!a) {
      new Notice(this.plugin.toolchain?.synctex ? "TeXPane: compile first, then sync." : "TeXPane: the synctex tool was not found.");
      return;
    }
    if (this.layout === "editor") this.setLayout("split");
    const head = this.editor.state.selection.main.head;
    const line = this.editor.state.doc.lineAt(head);
    const r = await forwardSearch({ ...a, texFile: this.absPath(), line: line.number, column: head - line.from + 1 });
    if (!r) {
      new Notice("TeXPane: SyncTeX found no position for this line (comment, preamble, or PDF out of date).");
      return;
    }
    this.pdf?.flash(r.page, r.h, r.v, r.W, r.H);
  }

  private async onInverse(page: number, x: number, y: number) {
    const a = this.syncArgs();
    if (!a) return;
    const r = await inverseSearch({ ...a, page, x, y });
    if (!r) {
      new Notice("TeXPane: SyncTeX found no source for that spot.");
      return;
    }
    await this.openLocation(r);
  }

  // ---------------------------------------------------------------- diagnostics navigation helpers
  nextProblem(dir: 1 | -1) {
    (dir === 1 ? nextDiagnostic : previousDiagnostic)(this.editor);
  }
}
