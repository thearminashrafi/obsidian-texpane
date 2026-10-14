import { ItemView, Keymap, Menu, Notice, TFile, TFolder, WorkspaceLeaf, setIcon } from "obsidian";
import type TexPanePlugin from "../main";
import type { LatexProject } from "../core/projectIndex";
import { formatRelativeTime } from "../core/projectStatus";
import { LatexWorkspaceView } from "./LatexWorkspaceView";

export const PROJECTS_TYPE = "texpane-projects";

const STATE_LABEL = { ok: "Last build succeeded", error: "Last build had errors", building: "Building", none: "Not built in this session" } as const;

function fileIcon(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "tex") return "file-code";
  if (ext === "bib") return "book-open";
  if (ext === "sty" || ext === "cls") return "file-cog";
  if (ext === "pdf") return "file-text";
  if (["png", "jpg", "jpeg", "svg", "eps"].includes(ext)) return "image";
  return "file";
}

/** Sidebar panel listing every LaTeX project in the vault. */
export class ProjectsView extends ItemView {
  /** Main-file paths of expanded projects (kept in the view state, so it survives reloads). */
  private expanded = new Set<string>();
  private filter = "";
  private listEl!: HTMLElement;
  private renderTimer: number | null = null;

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

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("tp-projects");

    const header = root.createDiv({ cls: "nav-header" });
    const btns = header.createDiv({ cls: "nav-buttons-container" });
    this.headerButton(btns, "folder-plus", "New LaTeX project", () => void this.plugin.newProjectInHome());
    this.headerButton(btns, "chevrons-down-up", "Collapse all", () => {
      this.expanded.clear();
      this.changed();
    });
    this.headerButton(btns, "refresh-cw", "Refresh", () => void this.plugin.rebuildProjects());

    const row = root.createDiv({ cls: "search-row" });
    const box = row.createDiv({ cls: "search-input-container" });
    const input = box.createEl("input", { attr: { type: "text", placeholder: "Filter projects…", spellcheck: "false", "aria-label": "Filter projects" } });
    const clear = box.createDiv({ cls: "search-input-clear-button", attr: { "aria-label": "Clear filter" } });
    clear.hide();
    input.addEventListener("input", () => {
      this.filter = input.value;
      clear.toggle(this.filter !== "");
      this.render();
    });
    clear.addEventListener("click", () => {
      input.value = "";
      this.filter = "";
      clear.hide();
      this.render();
      input.focus();
    });

    this.listEl = root.createDiv({ cls: "nav-files-container tp-projects-list" });

    this.register(this.plugin.onProjectsChanged(() => this.schedule()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.schedule()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.schedule()));
    this.registerInterval(window.setInterval(() => this.render(), 30_000)); // keeps "5 min ago" fresh
    this.render();
  }

  async onClose() {
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    this.renderTimer = null;
  }

  private headerButton(parent: HTMLElement, icon: string, label: string, onClick: () => void) {
    const b = parent.createDiv({ cls: "clickable-icon nav-action-button", attr: { "aria-label": label } });
    setIcon(b, icon);
    b.addEventListener("click", onClick);
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

  private toggle(p: LatexProject) {
    if (!this.expanded.delete(p.main)) this.expanded.add(p.main);
    this.changed();
  }

  render() {
    if (!this.listEl) return;
    const el = this.listEl;
    const scroll = el.scrollTop;
    el.empty();
    const all = this.plugin.projects();
    const q = this.filter.trim().toLowerCase();
    const shown = q ? all.filter((p) => p.name.toLowerCase().includes(q) || p.root.toLowerCase().includes(q)) : all;

    if (all.length === 0) {
      const empty = el.createDiv({ cls: "pane-empty tp-projects-empty" });
      empty.createDiv({ text: "No LaTeX projects yet. A project is a folder with a .tex file that has \\documentclass." });
      const btn = empty.createEl("button", { text: "New LaTeX project", cls: "mod-cta" });
      btn.addEventListener("click", () => void this.plugin.newProjectInHome());
      return;
    }
    if (shown.length === 0) {
      el.createDiv({ cls: "pane-empty", text: "No matching projects." });
      return;
    }

    const activePath = this.app.workspace.getActiveFile()?.path ?? null;
    const activeProject = activePath ? all.find((p) => p.files.includes(activePath)) ?? null : null;
    const now = Date.now();

    for (const p of shown) {
      const open = this.expanded.has(p.main);
      const item = el.createDiv({ cls: "tree-item tp-project" });
      const self = item.createDiv({ cls: "tree-item-self is-clickable mod-collapsible" });
      if (activeProject === p) self.addClass("is-active");
      self.toggleClass("is-collapsed", !open);
      self.setAttr("aria-label", p.root || "Vault root");
      const chev = self.createDiv({ cls: "tree-item-icon collapse-icon" });
      chev.toggleClass("is-collapsed", !open);
      setIcon(chev, "right-triangle");
      const st = this.plugin.projectStatus(p);
      self.createSpan({ cls: `tp-dot is-${st.state}`, attr: { "aria-label": STATE_LABEL[st.state] } });
      self.createDiv({ cls: "tree-item-inner", text: p.name });
      if (st.lastBuild) self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair tp-time", text: formatRelativeTime(st.lastBuild, now) });

      chev.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggle(p);
      });
      self.addEventListener("click", (e) => this.open(p.main, e));
      self.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.projectMenu(p, e);
      });

      if (!open) continue;
      const kids = item.createDiv({ cls: "tree-item-children" });
      for (const f of p.files) {
        const rel = p.root ? f.slice(p.root.length + 1) : f;
        const fi = kids.createDiv({ cls: "tree-item" });
        const fs = fi.createDiv({ cls: "tree-item-self is-clickable tp-file" });
        if (f === activePath) fs.addClass("is-active");
        setIcon(fs.createDiv({ cls: "tree-item-icon tp-file-icon" }), fileIcon(f));
        fs.createDiv({ cls: "tree-item-inner", text: rel, attr: { title: f } });
        fs.addEventListener("click", (e) => this.open(f, e));
        fs.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.fileMenu(f, e);
        });
      }
    }
    el.scrollTop = scroll;
  }

  private projectMenu(p: LatexProject, e: MouseEvent) {
    const m = new Menu();
    m.addItem((i) => i.setTitle("Open").setIcon("file-code").onClick(() => this.open(p.main, null)));
    m.addItem((i) =>
      i.setTitle("Open PDF").setIcon("file-text").onClick(() =>
        this.open(p.main, null, (leaf) => {
          const v = leaf.view;
          if (v instanceof LatexWorkspaceView) v.setLayout("pdf");
        }),
      ),
    );
    m.addItem((i) => i.setTitle("Reveal in file explorer").setIcon("folder-search").onClick(() => this.reveal(p.root || p.main)));
    const live = this.plugin.viewForProject(p);
    if (live) m.addItem((i) => i.setTitle("Recompile").setIcon("refresh-cw").onClick(() => void live.recompile()));
    m.addSeparator();
    m.addItem((i) =>
      i.setTitle("New file in project").setIcon("file-plus").onClick(() => {
        const folder = this.app.vault.getAbstractFileByPath(p.root || "/");
        void this.plugin.newLatexFile(folder instanceof TFolder ? folder : this.app.vault.getRoot());
      }),
    );
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
