import { Notice, Plugin, TFile, TFolder, WorkspaceLeaf, normalizePath, Platform } from "obsidian";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_SETTINGS, TexPaneSettingTab, type TexPaneSettings } from "./settings";
import { LatexWorkspaceView, VIEW_TYPE } from "./view/LatexWorkspaceView";
import { OUTLINE_TYPE, OutlineView } from "./view/OutlineView";
import { ObsidianNotes } from "./obsidianNotes";
import { ProjectSession } from "./session";
import { detectToolchain } from "./core/toolchain";
import { exportFlattened } from "./core/exportFlatten";
import { collectProjectFiles } from "./core/buildPipeline";
import { detectPackages } from "./core/indexers";
import type { ProjectInfo, ToolchainInfo } from "./types";
import { EmbedNoteModal, PromptModal } from "./modals";
import { ARTICLE_TEMPLATE, PROJECT_BIB, PROJECT_MAIN } from "./templates";

export default class TexPanePlugin extends Plugin {
  settings: TexPaneSettings = { ...DEFAULT_SETTINGS };
  toolchain: ToolchainInfo | null = null;
  notes!: ObsidianNotes;
  private sessions = new Map<string, ProjectSession>();
  private statusEl: HTMLElement | null = null;
  private lastLatexView: LatexWorkspaceView | null = null;
  private focusPrev: { left: boolean; right: boolean } | null = null;

  async onload() {
    await this.loadSettings();
    this.notes = new ObsidianNotes(this.app);

    this.registerView(VIEW_TYPE, (leaf) => new LatexWorkspaceView(leaf, this));
    this.registerView(OUTLINE_TYPE, (leaf) => new OutlineView(leaf, this));
    this.tryRegister(["tex"]);
    if (this.settings.registerAuxTypes) for (const ext of ["bib", "sty", "cls"]) this.tryRegister([ext]);
    this.registerHoverLinkSource("texpane", { display: "TeXPane", defaultMod: true });
    this.addSettingTab(new TexPaneSettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("tp-status");
    this.statusEl.addEventListener("click", () => this.activeLatexView()?.toggleLog());
    this.statusEl.hide();

    this.addCommands();
    this.registerVaultEvents();
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((i) => i.setTitle("New LaTeX file").setIcon("file-plus").onClick(() => void this.newLatexFile(file)));
        menu.addItem((i) => i.setTitle("New LaTeX project").setIcon("folder-plus").onClick(() => this.newLatexProject(file)));
      }),
    );
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateStatusBar()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.updateStatusBar()));

    this.app.workspace.onLayoutReady(() => {
      void this.detectToolchain().then(() => {
        if (!this.toolchain?.found) new Notice("TeXPane: LaTeX (latexmk) was not found. See Settings → TeXPane.", 8000);
      });
    });
  }

  onunload() {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    document.body.removeClass("texpane-focus");
  }

  private tryRegister(exts: string[]) {
    try {
      this.registerExtensions(exts, VIEW_TYPE);
    } catch (e) {
      console.warn("[TeXPane] could not register", exts, e);
      new Notice(`TeXPane: the .${exts.join(", .")} extension is already handled by another plugin and was left alone.`);
    }
  }

  // ------------------------------------------------------------------ settings
  async loadSettings() {
    const d = (await this.loadData()) ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...d, splitRatios: { ...(d.splitRatios ?? {}) } };
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  refreshViews() {
    for (const v of this.latexViews()) v.applyStyleSettings();
  }

  async detectToolchain() {
    this.toolchain = await detectToolchain({ settingsDir: this.settings.texBinDir || null });
    this.updateStatusBar();
    return this.toolchain;
  }

  // ------------------------------------------------------------------ views + sessions
  latexViews(): LatexWorkspaceView[] {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view).filter((v): v is LatexWorkspaceView => v instanceof LatexWorkspaceView);
  }
  activeLatexView(): LatexWorkspaceView | null {
    const v = this.app.workspace.getActiveViewOfType(LatexWorkspaceView);
    if (v) this.lastLatexView = v;
    if (v) return v;
    // keep showing the last one while a sidebar (e.g. outline) is focused
    const alive = this.lastLatexView && this.latexViews().includes(this.lastLatexView);
    return alive ? this.lastLatexView : null;
  }

  sessionFor(info: ProjectInfo): ProjectSession {
    let s = this.sessions.get(info.rootAbsPath);
    if (!s) {
      s = new ProjectSession(this, info);
      this.sessions.set(info.rootAbsPath, s);
    } else s.project = info;
    return s;
  }

  registerEmbedGraph(_s: ProjectSession) {
    /* sessions hold their own embeddedNotes sets; vault events consult them */
  }

  async saveDirtyViews() {
    await Promise.all(this.latexViews().map((v) => v.save().catch(() => undefined)));
  }

  private registerVaultEvents() {
    const kick = (f: TFile, oldPath?: string) => {
      const abs = path.join(this.notes.basePath(), ...f.path.split("/"));
      for (const s of this.sessions.values()) {
        const isNote = f.extension === "md" && (s.embeddedNotes.has(f.path) || (oldPath !== undefined && s.embeddedNotes.has(oldPath)));
        const inProject = ["tex", "bib", "sty", "cls"].includes(f.extension) && (s.index.has(abs) || !path.relative(s.project.cwd, abs).startsWith(".."));
        if (isNote || inProject) {
          if (f.extension !== "md") void s.index.update(abs).catch(() => undefined);
          s.schedule();
        }
      }
    };
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (!(f instanceof TFile)) return;
        if (f.path.includes("/.texpane/")) return;
        // ignore our own saves (open view already has exactly this content)
        const own = this.latexViews().find((v) => v.file === f);
        if (own && own.getViewData() === own.data) {
          void this.app.vault.cachedRead(f).then((disk) => {
            if (disk !== own.getViewData()) kick(f);
          });
          return;
        }
        kick(f);
      }),
    );
    this.registerEvent(this.app.vault.on("rename", (f, old) => f instanceof TFile && kick(f, old)));
    this.registerEvent(
      this.app.vault.on("delete", (f) => {
        if (f instanceof TFile) kick(f, f.path);
      }),
    );
  }

  // ------------------------------------------------------------------ status bar
  updateStatusBar() {
    const el = this.statusEl;
    if (!el) return;
    const v = this.activeLatexView();
    if (!v) {
      el.hide();
      return;
    }
    el.show();
    const s = v.getSession();
    const tc = this.toolchain;
    if (tc && !tc.found) {
      el.setText("TeX: not installed");
      return;
    }
    let text = "TeX: Ready";
    if (s) {
      const r = s.last;
      if (s.state === "running" || s.state === "queued") text = "TeX: Compiling…";
      else if (s.state === "scheduled") text = "TeX: Typing…";
      else if (r) {
        const t = (r.durationMs / 1000).toFixed(1);
        text = r.status === "ok" ? `TeX: Ready · ${t} s` : r.status === "errors" ? `TeX: Compiled with errors · ${t} s` : r.status === "cancelled" ? "TeX: Cancelled" : r.status === "timeout" ? "TeX: Timed out" : "TeX: Failed";
      }
      const eng = { pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX" }[s.project.engine];
      text += ` · ${eng}`;
      if (this.settings.showWordCount && s.words !== null) text += ` · ${s.words.toLocaleString()} words`;
    }
    el.setText(text);
    el.setAttr("aria-label", "Click to toggle the TeX log");
  }

  // ------------------------------------------------------------------ commands
  private addCommands() {
    const withView = (fn: (v: LatexWorkspaceView) => void) => (checking: boolean) => {
      const v = this.app.workspace.getActiveViewOfType(LatexWorkspaceView);
      if (!v) return false;
      if (!checking) fn(v);
      return true;
    };
    this.addCommand({ id: "recompile", name: "Recompile", icon: "refresh-cw", checkCallback: withView((v) => void v.recompile()) });
    this.addCommand({
      id: "sync-to-pdf",
      name: "Jump to PDF position (forward search)",
      icon: "locate",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "j" }],
      checkCallback: withView((v) => void v.syncToPdf()),
    });
    this.addCommand({ id: "next-error", name: "Next problem", icon: "arrow-down", hotkeys: [{ modifiers: [], key: "F8" }], checkCallback: withView((v) => v.nextProblem(1)) });
    this.addCommand({ id: "previous-error", name: "Previous problem", icon: "arrow-up", hotkeys: [{ modifiers: ["Shift"], key: "F8" }], checkCallback: withView((v) => v.nextProblem(-1)) });
    this.addCommand({ id: "toggle-log", name: "Toggle log drawer", icon: "alert-triangle", hotkeys: [{ modifiers: ["Mod", "Alt"], key: "l" }], checkCallback: withView((v) => v.toggleLog()) });
    this.addCommand({ id: "cycle-layout", name: "Cycle layout (split, editor, PDF)", icon: "columns-2", hotkeys: [{ modifiers: ["Mod", "Alt"], key: "v" }], checkCallback: withView((v) => v.cycleLayout()) });
    this.addCommand({ id: "toggle-focus", name: "Toggle focus mode", icon: "maximize", hotkeys: [{ modifiers: ["Mod", "Alt"], key: "f" }], callback: () => this.toggleFocus() });
    this.addCommand({
      id: "embed-note",
      name: "Embed note…",
      icon: "file-input",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "e" }],
      checkCallback: withView((v) => new EmbedNoteModal(this.app, (f) => v.insertAtCursor(`\\obsidian{${this.notes.nameFor(f)}}`)).open()),
    });
    this.addCommand({ id: "bold", name: "Bold (\\textbf)", icon: "bold", checkCallback: withView((v) => v.getEditor() && import("./editor/editing").then((m) => m.bold(v.getEditor()))) });
    this.addCommand({ id: "italic", name: "Italic (\\emph)", icon: "italic", checkCallback: withView((v) => v.getEditor() && import("./editor/editing").then((m) => m.italic(v.getEditor()))) });
    this.addCommand({ id: "toggle-comment", name: "Toggle comment", icon: "percent", checkCallback: withView((v) => import("./editor/editing").then((m) => m.toggleComment(v.getEditor()))) });
    this.addCommand({ id: "export-flat", name: "Export flattened project…", icon: "package", checkCallback: withView((v) => void this.exportFlattened(v)) });
    this.addCommand({ id: "clean", name: "Clean build files", icon: "trash-2", checkCallback: withView((v) => void this.cleanBuild(v)) });
    this.addCommand({ id: "reveal-pdf", name: "Reveal PDF in file manager", icon: "folder-open", checkCallback: withView((v) => this.revealPdf(v)) });
    this.addCommand({
      id: "toggle-auto-compile",
      name: "Toggle auto-compile",
      icon: "zap",
      callback: async () => {
        this.settings.autoCompile = !this.settings.autoCompile;
        await this.saveSettings();
        new Notice(`TeXPane: auto-compile ${this.settings.autoCompile ? "on" : "off"}`);
      },
    });
    this.addCommand({ id: "new-project", name: "New LaTeX project", icon: "folder-plus", callback: () => this.newLatexProject(this.defaultFolder()) });
    this.addCommand({ id: "new-file", name: "New LaTeX file", icon: "file-plus", callback: () => void this.newLatexFile(this.defaultFolder()) });
    this.addCommand({ id: "open-outline", name: "Open LaTeX outline", icon: "list-tree", callback: () => void this.openOutline() });
    this.addCommand({
      id: "recheck-toolchain",
      name: "Re-check TeX installation",
      icon: "stethoscope",
      callback: async () => {
        const t = await this.detectToolchain();
        new Notice(t.found ? `TeXPane: latexmk ${t.latexmk?.version} found in ${t.binDir}` : "TeXPane: latexmk not found");
      },
    });
  }

  private defaultFolder(): TFolder {
    const f = this.app.workspace.getActiveFile();
    return f?.parent ?? this.app.vault.getRoot();
  }

  async openOutline() {
    const existing = this.app.workspace.getLeavesOfType(OUTLINE_TYPE)[0];
    const leaf: WorkspaceLeaf | null = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type: OUTLINE_TYPE, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }

  // ------------------------------------------------------------------ new files / projects
  private uniquePath(folder: TFolder, base: string, ext: string): string {
    const dir = folder.isRoot() ? "" : folder.path + "/";
    let p = normalizePath(`${dir}${base}.${ext}`);
    for (let i = 1; this.app.vault.getAbstractFileByPath(p); i++) p = normalizePath(`${dir}${base} ${i}.${ext}`);
    return p;
  }

  async newLatexFile(folder: TFolder) {
    const f = await this.app.vault.create(this.uniquePath(folder, "Untitled", "tex"), ARTICLE_TEMPLATE);
    await this.app.workspace.getLeaf("tab").openFile(f);
  }

  newLatexProject(folder: TFolder) {
    new PromptModal(this.app, "New LaTeX project", "Project name", "My Paper", "Create", async (name) => {
      const clean = name.replace(/[\\/:*?"<>|]/g, "-").trim();
      const dir = normalizePath((folder.isRoot() ? "" : folder.path + "/") + clean);
      if (this.app.vault.getAbstractFileByPath(dir)) {
        new Notice(`TeXPane: "${dir}" already exists`);
        return;
      }
      await this.app.vault.createFolder(dir);
      const main = await this.app.vault.create(`${dir}/main.tex`, PROJECT_MAIN(clean));
      await this.app.vault.create(`${dir}/refs.bib`, PROJECT_BIB);
      await this.app.workspace.getLeaf("tab").openFile(main);
    }).open();
  }

  // ------------------------------------------------------------------ misc actions
  async exportFlattened(v: LatexWorkspaceView) {
    const s = v.getSession();
    if (!s) return;
    await this.saveDirtyViews();
    const base = this.notes.basePath();
    const cwd = s.project.cwd;
    const name = path.basename(s.project.rootAbsPath).replace(/\.tex$/i, "");
    const out = path.resolve(cwd) === path.resolve(base) ? path.join(base, "TeXPane export", name) : path.join(path.dirname(cwd), `${path.basename(cwd)} (flat)`);
    try {
      const r = await exportFlattened({ rootAbs: s.project.rootAbsPath, cwd, outDir: out, notes: this.notes, vaultBase: base, wikilinkFootnote: this.settings.wikilinkFootnote, highlightEmph: this.settings.highlightAsEmph });
      new Notice(`TeXPane: exported ${r.embedded} embedded note(s) to ${out}${r.warnings.length ? `\n${r.warnings.length} warning(s): ${r.warnings[0]}` : ""}`, 10000);
    } catch (e) {
      new Notice(`TeXPane: export failed: ${(e as Error).message}`, 10000);
    }
  }

  async cleanBuild(v: LatexWorkspaceView) {
    const s = v.getSession();
    if (!s) return;
    s.cancel();
    try {
      await fsp.rm(s.project.buildDir, { recursive: true, force: true });
      new Notice("TeXPane: build files removed.");
      void v.recompile();
    } catch (e) {
      new Notice(`TeXPane: could not clean: ${(e as Error).message}`);
    }
  }

  revealPdf(v: LatexWorkspaceView) {
    const pdf = v.getSession()?.last?.pdfPath;
    if (!pdf) {
      new Notice("TeXPane: no PDF yet.");
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron = (window as any).require("electron");
      electron.shell.showItemInFolder(pdf);
    } catch {
      new Notice(`TeXPane: PDF is at ${pdf}`);
    }
  }

  toggleFocus() {
    const ws = this.app.workspace;
    const body = document.body;
    if (this.focusPrev) {
      if (!this.focusPrev.left) ws.leftSplit.expand();
      if (!this.focusPrev.right) ws.rightSplit.expand();
      this.focusPrev = null;
      body.removeClass("texpane-focus");
    } else {
      this.focusPrev = { left: ws.leftSplit.collapsed, right: ws.rightSplit.collapsed };
      ws.leftSplit.collapse();
      ws.rightSplit.collapse();
      body.addClass("texpane-focus");
    }
  }

  /** Markdown note being dragged from the file explorer (shortest unambiguous name), or null. */
  noteFromDrag(ev: DragEvent): string | null {
    const dm = (this.app as any).dragManager;
    const d = dm?.draggable;
    const pick = (f: unknown): string | null => (f instanceof TFile && f.extension === "md" ? this.notes.nameFor(f) : null);
    if (d?.type === "file") return pick(d.file);
    if (d?.type === "files" && Array.isArray(d.files)) for (const f of d.files) {
      const n = pick(f);
      if (n) return n;
    }
    const text = ev.dataTransfer?.getData("text/plain") ?? "";
    const m = /^obsidian:\/\/open\?.*[?&]file=([^&]+)/.exec(text);
    if (m) {
      const p = decodeURIComponent(m[1]);
      const f = this.app.vault.getAbstractFileByPath(p) ?? this.app.vault.getAbstractFileByPath(p + ".md");
      return pick(f);
    }
    return null;
  }
}
