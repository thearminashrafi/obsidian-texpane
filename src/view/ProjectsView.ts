import { ItemView, Keymap, Menu, Notice, TFile, TFolder, WorkspaceLeaf, setIcon } from "obsidian";
import type TexPanePlugin from "../main";
import type { LatexProject } from "../core/projectIndex";
import { formatRelativeTime } from "../core/projectStatus";
import { LatexWorkspaceView } from "./LatexWorkspaceView";

export const PROJECTS_TYPE = "texpane-projects";

const STATE_LABEL = { ok: "Last build succeeded", error: "Last build had errors", building: "Building", none: "Not built since Obsidian started" } as const;
const TREE_EXTS = new Set(["tex", "bib"]);

function fileIcon(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "tex") return "file-code";
  if (ext === "bib") return "book-open";
  if (ext === "sty" || ext === "cls") return "file-cog";
  if (ext === "pdf") return "file-text";
  if (["png", "jpg", "jpeg", "svg", "eps"].includes(ext)) return "image";
  return "file";
}

/**
 * Sidebar panel for LaTeX work: a tree of the projects folder (sub-folders, single-file documents and
 * multi-file projects), plus the projects that live elsewhere in the vault.
 */
export class ProjectsView extends ItemView {
  /** Expanded nodes: "p:<main>" for projects, "d:<folder path>" for folders. Kept in the view state. */
  private expanded = new Set<string>();
  private filter = "";
  private listEl!: HTMLElement;
  private footerEl!: HTMLElement;
  private renderTimer: number | null = null;
  private activePath: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: TexPanePlugin) {
    super(leaf);
  }
  getViewType() {
    return PROJECTS_TYPE;
  }
  getDisplayText() {
    return "LaTeX projects";
  }
  getIcon() {
    return "sigma";
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), expanded: [...this.expanded] };
  }
  async setState(state: unknown, result: Parameters<ItemView["setState"]>[1]): Promise<void> {
    const ex = (state as { expanded?: unknown } | null)?.expanded;
    if (Array.isArray(ex)) this.expanded = new Set(ex.filter((x): x is string => typeof x === "string"));
    await super.setState(state, result);
    if (this.listEl) this.render();
  }

  /** True once onOpen has built the panel (a restored leaf can exist without that). */
  isLive(): boolean {
    return !!this.listEl && this.contentEl.contains(this.listEl);
  }

  async onOpen() {
    try {
      this.build();
    } catch (e) {
      console.error("[TeXPane] projects panel failed to open", e);
      this.contentEl.empty();
      this.contentEl.createDiv({ cls: "tp-projects-note", text: `The LaTeX projects panel failed to load: ${(e as Error).message}` });
    }
  }

  private build() {
    const root = this.contentEl;
    root.empty();
    root.addClass("tp-projects");

    // toolbar: a labelled "New" menu, then collapse / refresh
    const bar = root.createDiv({ cls: "tp-projects-toolbar" });
    const newBtn = bar.createEl("button", { cls: "tp-projects-new mod-cta", attr: { "aria-label": "New project, file or folder" } });
    setIcon(newBtn.createSpan({ cls: "tp-projects-new-icon" }), "plus");
    newBtn.createSpan({ text: "New" });
    setIcon(newBtn.createSpan({ cls: "tp-projects-new-caret" }), "chevron-down");
    newBtn.addEventListener("click", (e) => void this.newMenu(e));
    bar.createDiv({ cls: "tp-projects-spacer" });
    this.iconButton(bar, "chevrons-down-up", "Collapse all", () => {
      this.expanded.clear();
      this.changed();
    });
    this.iconButton(bar, "refresh-cw", "Rescan the vault", () => void this.plugin.rebuildProjects());

    const row = root.createDiv({ cls: "search-row tp-projects-search" });
    const box = row.createDiv({ cls: "search-input-container" });
    const input = box.createEl("input", { attr: { type: "search", placeholder: "Filter…", spellcheck: "false", "aria-label": "Filter projects" } });
    input.addEventListener("input", () => {
      this.filter = input.value;
      this.render();
    });

    this.listEl = root.createDiv({ cls: "tp-projects-list" });
    this.footerEl = root.createDiv({ cls: "tp-projects-footer" });

    this.register(this.plugin.onProjectsChanged(() => this.schedule()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.schedule()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.schedule()));
    // folders are shown even without projects in them, so follow folder changes too
    this.registerEvent(this.app.vault.on("create", () => this.schedule()));
    this.registerEvent(this.app.vault.on("delete", () => this.schedule()));
    this.registerEvent(this.app.vault.on("rename", () => this.schedule()));
    this.registerInterval(window.setInterval(() => this.render(), 30_000)); // keeps "5 min ago" fresh
    this.render();
    // the index may still be empty if this view opened before the first scan finished
    if (this.plugin.projects().length === 0) void this.plugin.rebuildProjects();
  }

  /** Obsidian shows a sidebar view when its tab is clicked; make sure it is built and current. */
  onResize() {
    if (!this.isLive()) void this.onOpen();
  }

  async onClose() {
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    this.renderTimer = null;
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void) {
    const b = parent.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
    setIcon(b, icon);
    b.addEventListener("click", onClick);
  }

  private async newMenu(e: MouseEvent, where?: TFolder) {
    const folder = where ?? (await this.plugin.homeFolder());
    const m = new Menu();
    m.addItem((i) => i.setTitle("New LaTeX project").setIcon("folder-plus").onClick(() => this.plugin.newLatexProject(folder)));
    m.addItem((i) => i.setTitle("New LaTeX file").setIcon("file-plus").onClick(() => this.plugin.newNamedTexFile(folder)));
    m.addItem((i) => i.setTitle("New folder").setIcon("folder").onClick(() => this.plugin.newFolderIn(folder)));
    m.showAtMouseEvent(e);
  }

  private schedule() {
    if (this.renderTimer) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 60);
  }

  private changed() {
    this.app.workspace.requestSaveLayout();
    this.render();
  }

  private open(path: string, e: MouseEvent | KeyboardEvent | boolean | null, then?: (leaf: WorkspaceLeaf) => void) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`TeXPane: ${path} no longer exists`);
      return;
    }
    const newTab = typeof e === "boolean" ? e : e ? !!Keymap.isModEvent(e) : false;
    void this.plugin.openFromPanel(file, newTab).then((leaf) => then?.(leaf));
  }

  private toggle(key: string) {
    if (!this.expanded.delete(key)) this.expanded.add(key);
    this.changed();
  }

  // ------------------------------------------------------------------ rendering
  render() {
    if (!this.listEl) return;
    const el = this.listEl;
    const scroll = el.scrollTop;
    el.empty();
    this.activePath = this.app.workspace.getActiveFile()?.path ?? null;
    const all = this.plugin.projects();
    const home = this.plugin.homePath();
    const homeFolder = home ? this.app.vault.getAbstractFileByPath(home) : null;
    const q = this.filter.trim().toLowerCase();

    if (q) {
      const shown = all.filter((p) => p.name.toLowerCase().includes(q) || p.main.toLowerCase().includes(q));
      if (shown.length === 0) el.createDiv({ cls: "tp-projects-note", text: "No matching projects." });
      for (const p of shown) this.projectRow(el, p, all);
    } else if (home === "") {
      // projects folder = vault root: a tree would be the whole vault, so list projects instead
      if (all.length === 0) this.emptyState(el, null);
      for (const p of all) this.projectRow(el, p, all);
    } else {
      const section = el.createDiv({ cls: "tp-projects-section" });
      const head = section.createDiv({ cls: "tp-projects-section-head" });
      setIcon(head.createSpan({ cls: "tp-projects-section-icon" }), "folder");
      head.createSpan({ text: home });
      head.setAttr("aria-label", "Projects folder (Settings → TeXPane → Projects)");
      head.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (homeFolder instanceof TFolder) this.folderMenu(homeFolder, e);
      });
      if (homeFolder instanceof TFolder && homeFolder.children.length > 0) this.folderChildren(section, homeFolder, all);
      else this.emptyState(section, home);

      const outside = all.filter((p) => !this.plugin.isInHome(p));
      if (outside.length) {
        const sec = el.createDiv({ cls: "tp-projects-section" });
        const h = sec.createDiv({ cls: "tp-projects-section-head" });
        setIcon(h.createSpan({ cls: "tp-projects-section-icon" }), "map-pin");
        h.createSpan({ text: "Elsewhere in the vault" });
        h.setAttr("aria-label", `Projects outside ${home}/. Right-click one to move it into ${home}/.`);
        for (const p of outside) this.projectRow(sec, p, all, true);
      }
    }
    el.scrollTop = scroll;

    const n = all.length;
    this.footerEl.setText(`${n} project${n === 1 ? "" : "s"} · ${this.plugin.scannedTexCount()} .tex file${this.plugin.scannedTexCount() === 1 ? "" : "s"} scanned`);
  }

  private emptyState(parent: HTMLElement, home: string | null) {
    const box = parent.createDiv({ cls: "tp-projects-empty" });
    box.createDiv({ text: home ? `Nothing in ${home}/ yet.` : "No LaTeX projects yet." });
    const btns = box.createDiv({ cls: "tp-projects-empty-buttons" });
    const mk = (icon: string, text: string, fn: () => void) => {
      const b = btns.createEl("button");
      setIcon(b.createSpan({ cls: "tp-btn-icon" }), icon);
      b.createSpan({ text });
      b.addEventListener("click", fn);
    };
    mk("folder-plus", "New project", () => void this.plugin.newProjectInHome());
    mk("file-plus", "New LaTeX file", () => void this.plugin.homeFolder().then((f) => this.plugin.newNamedTexFile(f)));
    mk("folder", "New folder", () => void this.plugin.homeFolder().then((f) => this.plugin.newFolderIn(f)));
  }

  /** The children of a plain folder: sub-folders (projects or plain), then .tex/.bib files. */
  private folderChildren(parent: HTMLElement, folder: TFolder, all: LatexProject[]) {
    const kids = [...folder.children].sort((a, b) => {
      const fa = a instanceof TFolder ? 0 : 1;
      const fb = b instanceof TFolder ? 0 : 1;
      return fa - fb || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
    for (const c of kids) {
      if (c instanceof TFolder) {
        const proj = all.find((p) => p.root === c.path && p.files.length >= 1 && !(p.root === this.plugin.homePath()));
        if (proj && this.isFolderProject(proj, all)) this.projectRow(parent, proj, all);
        else this.folderRow(parent, c, all);
      } else if (c instanceof TFile && TREE_EXTS.has(c.extension.toLowerCase())) {
        const proj = all.find((p) => p.main === c.path);
        if (proj) this.projectRow(parent, proj, all);
        else this.fileRow(parent, c.path, c.name);
      }
    }
  }

  /** A folder project (not a single-file document sitting in a plain folder). */
  private isFolderProject(p: LatexProject, all: LatexProject[]): boolean {
    return all.filter((x) => x.root === p.root).length === 1 && p.root !== "";
  }

  private folderRow(parent: HTMLElement, folder: TFolder, all: LatexProject[]) {
    const key = `d:${folder.path}`;
    const open = this.expanded.has(key);
    const item = parent.createDiv({ cls: "tree-item tp-node" });
    const self = item.createDiv({ cls: "tree-item-self is-clickable mod-collapsible tp-row" });
    const chev = self.createDiv({ cls: "tree-item-icon collapse-icon" });
    chev.toggleClass("is-collapsed", !open);
    setIcon(chev, "right-triangle");
    setIcon(self.createDiv({ cls: "tp-row-icon" }), open ? "folder-open" : "folder");
    self.createDiv({ cls: "tree-item-inner", text: folder.name });
    self.addEventListener("click", () => this.toggle(key));
    self.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.folderMenu(folder, e);
    });
    if (!open) return;
    const kids = item.createDiv({ cls: "tree-item-children" });
    if (folder.children.length === 0) kids.createDiv({ cls: "tp-projects-note", text: "Empty" });
    else this.folderChildren(kids, folder, all);
  }

  private fileRow(parent: HTMLElement, path: string, label: string) {
    const fi = parent.createDiv({ cls: "tree-item tp-node" });
    const fs = fi.createDiv({ cls: "tree-item-self is-clickable tp-row tp-file" });
    if (path === this.activePath) fs.addClass("is-active");
    fs.createDiv({ cls: "tp-chevron-space" });
    setIcon(fs.createDiv({ cls: "tp-row-icon" }), fileIcon(path));
    fs.createDiv({ cls: "tree-item-inner", text: label, attr: { title: path } });
    fs.addEventListener("click", (e) => this.open(path, e));
    fs.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.fileMenu(path, e);
    });
  }

  /** A project: a multi-file folder project (expandable) or a single-file document. */
  private projectRow(parent: HTMLElement, p: LatexProject, all: LatexProject[], showMove = false) {
    const multi = this.isFolderProject(p, all);
    const key = `p:${p.main}`;
    const open = multi && this.expanded.has(key);
    const item = parent.createDiv({ cls: "tree-item tp-node tp-project" });
    const self = item.createDiv({ cls: "tree-item-self is-clickable tp-row" });
    if (this.activePath && p.files.includes(this.activePath)) self.addClass("is-active");
    if (multi) {
      self.addClass("mod-collapsible");
      const chev = self.createDiv({ cls: "tree-item-icon collapse-icon" });
      chev.toggleClass("is-collapsed", !open);
      setIcon(chev, "right-triangle");
      chev.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggle(key);
      });
    } else self.createDiv({ cls: "tp-chevron-space" });
    const st = this.plugin.projectStatus(p);
    const icon = self.createDiv({ cls: "tp-row-icon tp-project-icon", attr: { "aria-label": STATE_LABEL[st.state] } });
    setIcon(icon, multi ? "book-text" : "file-code");
    icon.createSpan({ cls: `tp-dot is-${st.state}` });
    self.createDiv({ cls: "tree-item-inner", text: p.name, attr: { title: p.main } });
    if (st.lastBuild) self.createSpan({ cls: "tp-time", text: formatRelativeTime(st.lastBuild, Date.now()) });
    self.addEventListener("click", (e) => this.open(p.main, e));
    self.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.projectMenu(p, e, showMove || !this.plugin.isInHome(p));
    });
    if (!open) return;
    const kids = item.createDiv({ cls: "tree-item-children" });
    for (const f of p.files) this.fileRow(kids, f, p.root ? f.slice(p.root.length + 1) : f);
  }

  // ------------------------------------------------------------------ menus
  private projectMenu(p: LatexProject, e: MouseEvent, offerMove: boolean) {
    const m = new Menu();
    m.addItem((i) => i.setTitle("Open").setIcon("file-code").onClick(() => this.open(p.main, null)));
    m.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => this.open(p.main, true)));
    m.addItem((i) =>
      i.setTitle("Open PDF").setIcon("file-text").onClick(() =>
        this.open(p.main, null, (leaf) => {
          const v = leaf.view;
          if (v instanceof LatexWorkspaceView) v.setLayout("pdf");
        }),
      ),
    );
    const live = this.plugin.viewForProject(p);
    if (live) m.addItem((i) => i.setTitle("Recompile").setIcon("refresh-cw").onClick(() => void live.recompile()));
    m.addSeparator();
    if (offerMove) {
      const home = this.plugin.homePath();
      m.addItem((i) => i.setTitle(`Move into ${home}/`).setIcon("folder-input").onClick(() => void this.plugin.moveToHome(p)));
    }
    if (this.isFolderProject(p, this.plugin.projects())) {
      const folder = this.app.vault.getAbstractFileByPath(p.root);
      if (folder instanceof TFolder) m.addItem((i) => i.setTitle("New file in project").setIcon("file-plus").onClick(() => this.plugin.newNamedTexFile(folder)));
    }
    m.addItem((i) => i.setTitle("Reveal in file explorer").setIcon("folder-search").onClick(() => this.reveal(this.isFolderProject(p, this.plugin.projects()) ? p.root : p.main)));
    m.showAtMouseEvent(e);
  }

  private folderMenu(folder: TFolder, e: MouseEvent) {
    const m = new Menu();
    m.addItem((i) => i.setTitle("New LaTeX project here").setIcon("folder-plus").onClick(() => this.plugin.newLatexProject(folder)));
    m.addItem((i) => i.setTitle("New LaTeX file here").setIcon("file-plus").onClick(() => this.plugin.newNamedTexFile(folder)));
    m.addItem((i) => i.setTitle("New folder here").setIcon("folder").onClick(() => this.plugin.newFolderIn(folder)));
    m.addSeparator();
    m.addItem((i) => i.setTitle("Reveal in file explorer").setIcon("folder-search").onClick(() => this.reveal(folder.path)));
    m.showAtMouseEvent(e);
  }

  private fileMenu(path: string, e: MouseEvent) {
    const m = new Menu();
    m.addItem((i) => i.setTitle("Open").setIcon("file").onClick(() => this.open(path, null)));
    m.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => this.open(path, true)));
    m.addItem((i) => i.setTitle("Reveal in file explorer").setIcon("folder-search").onClick(() => this.reveal(path)));
    m.showAtMouseEvent(e);
  }

  /** Select a file or folder in the core file explorer (uses its revealInFolder method; undocumented but stable). */
  private reveal(path: string) {
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!target) return;
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (!leaf) {
      new Notice("TeXPane: the file explorer is not open.");
      return;
    }
    void this.app.workspace.revealLeaf(leaf);
    (leaf.view as unknown as { revealInFolder?: (f: unknown) => void }).revealInFolder?.(target);
  }
}
