import { ItemView, WorkspaceLeaf } from "obsidian";
import * as path from "node:path";
import type TexPanePlugin from "../main";
import type { SessionEvent } from "../session";
import type { LatexWorkspaceView } from "./LatexWorkspaceView";

export const OUTLINE_TYPE = "texpane-outline";

export class OutlineView extends ItemView {
  private unlisten: (() => void) | null = null;
  private timer: number | null = null;
  constructor(leaf: WorkspaceLeaf, private plugin: TexPanePlugin) {
    super(leaf);
  }
  getViewType() {
    return OUTLINE_TYPE;
  }
  getDisplayText() {
    return "LaTeX outline";
  }
  getIcon() {
    return "list-tree";
  }
  async onOpen() {
    this.contentEl.addClass("tp-outline");
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
    this.refresh();
  }
  async onClose() {
    this.unlisten?.();
    if (this.timer) window.clearTimeout(this.timer);
  }

  private bound: LatexWorkspaceView | null = null;
  refresh() {
    const v = this.plugin.activeLatexView();
    if (v !== this.bound) {
      this.unlisten?.();
      this.bound = v;
      const s = v?.getSession();
      if (s) {
        const l = (e: SessionEvent) => {
          if (e.type === "result") this.schedule();
        };
        s.listeners.add(l);
        this.unlisten = () => s.listeners.delete(l);
      }
    }
    this.drawOutline();
  }
  schedule() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.drawOutline(), 300);
  }
  private drawOutline() {
    const el = this.contentEl;
    el.empty();
    const v = this.bound;
    const s = v?.getSession();
    if (!v || !s) {
      el.createDiv({ cls: "pane-empty", text: "Open a .tex file to see its outline." });
      return;
    }
    const items = s.index.projectOutline();
    if (!items.length) {
      el.createDiv({ cls: "pane-empty", text: "No sections found." });
      return;
    }
    const minDepth = Math.min(...items.map((i) => i.item.depth));
    const list = el.createDiv({ cls: "tp-outline-list" });
    for (const { file, item } of items) {
      const row = list.createDiv({ cls: "tree-item" });
      const self = row.createDiv({ cls: "tree-item-self is-clickable" });
      self.style.paddingLeft = `${8 + (item.depth - minDepth) * 14}px`;
      self.createDiv({ cls: "tree-item-inner", text: item.title.replace(/\\[a-zA-Z]+\*?/g, "").replace(/[{}]/g, "").trim() || item.kind });
      if (path.resolve(file) !== path.resolve(s.project.rootAbsPath)) self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair", text: path.basename(file) });
      self.addEventListener("click", () => void v.openLocation({ file, line: item.line }));
    }
  }
}
