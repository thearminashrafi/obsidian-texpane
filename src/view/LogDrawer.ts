import { setIcon } from "obsidian";
import type { Diagnostic, Severity } from "../types";

export interface LogDrawerCallbacks {
  onSelect(d: Diagnostic): void;
  /** Absolute file path -> short display label */
  label(file: string): string;
}

const ICONS: Record<Severity, string> = { error: "circle-x", warning: "triangle-alert", info: "info" };

/** Bottom drawer: Problems (tree-item list) and Raw log tabs. Styled with Obsidian's search-results classes. */
export class LogDrawer {
  readonly el: HTMLElement;
  private tabs!: HTMLElement;
  private body: HTMLElement;
  private tab: "problems" | "raw" = "problems";
  private diags: Diagnostic[] = [];
  private raw = "";
  private filters: Record<Severity, boolean> = { error: true, warning: true, info: false };
  private open = false;
  private tabButtons = new Map<string, HTMLElement>();
  private filterButtons = new Map<Severity, HTMLElement>();

  constructor(parent: HTMLElement, private cb: LogDrawerCallbacks) {
    this.el = parent.createDiv({ cls: "tp-log" });
    this.buildHeader();
    this.body = this.el.createDiv({ cls: "tp-log-body" });
    this.setOpen(false);
  }

  private buildHeader() {
    const head = this.el.createDiv({ cls: "tp-log-head" });
    this.tabs = head.createDiv({ cls: "tp-log-tabs" });
    for (const [id, label] of [["problems", "Problems"], ["raw", "Raw log"]] as const) {
      const b = this.tabs.createDiv({ cls: "tp-log-tab", text: label });
      b.addEventListener("click", () => {
        this.tab = id;
        this.render();
      });
      this.tabButtons.set(id, b);
    }
    head.createDiv({ cls: "tp-spacer" });
    const f = head.createDiv({ cls: "tp-log-filters" });
    for (const sev of ["error", "warning", "info"] as Severity[]) {
      const b = f.createDiv({ cls: `tp-log-filter is-${sev}` });
      b.addEventListener("click", () => {
        this.filters[sev] = !this.filters[sev];
        this.render();
      });
      this.filterButtons.set(sev, b);
    }
    const close = head.createDiv({ cls: "clickable-icon tp-log-close", attr: { "aria-label": "Close log" } });
    setIcon(close, "x");
    close.addEventListener("click", () => this.setOpen(false));
  }

  isOpen() {
    return this.open;
  }
  setOpen(o: boolean) {
    this.open = o;
    this.el.toggleClass("is-open", o);
    if (o) this.render();
  }
  toggle() {
    this.setOpen(!this.open);
  }

  counts(): Record<Severity, number> {
    const c = { error: 0, warning: 0, info: 0 };
    for (const d of this.diags) c[d.severity]++;
    return c;
  }

  set(diags: Diagnostic[], raw: string) {
    this.diags = diags;
    this.raw = raw;
    this.render();
  }

  private render() {
    const c = this.counts();
    for (const [sev, b] of this.filterButtons) {
      b.empty();
      const ic = b.createSpan({ cls: "tp-log-filter-icon" });
      setIcon(ic, ICONS[sev]);
      b.createSpan({ text: String(c[sev]) });
      b.toggleClass("is-active", this.filters[sev]);
      b.setAttr("aria-label", `${sev}s`);
    }
    for (const [id, b] of this.tabButtons) b.toggleClass("is-active", id === this.tab);
    if (!this.open) return;
    this.body.empty();
    if (this.tab === "raw") {
      const pre = this.body.createEl("pre", { cls: "tp-log-raw" });
      pre.setText(this.raw ? (this.raw.length > 400000 ? "…\n" + this.raw.slice(-400000) : this.raw) : "No log yet.");
      return;
    }
    const shown = this.diags.filter((d) => this.filters[d.severity]);
    if (!shown.length) {
      this.body.createDiv({ cls: "tp-log-empty", text: this.diags.length ? "No problems match the current filters." : "No problems." });
      return;
    }
    for (const d of shown) {
      const item = this.body.createDiv({ cls: "tree-item tp-log-item" });
      const self = item.createDiv({ cls: `tree-item-self is-clickable tp-sev-${d.severity}` });
      const ic = self.createSpan({ cls: "tp-log-sev" });
      setIcon(ic, ICONS[d.severity]);
      const inner = self.createDiv({ cls: "tree-item-inner" });
      inner.createSpan({ cls: "tp-log-msg", text: d.message });
      if (d.raw && d.severity === "error") inner.createDiv({ cls: "tp-log-ctx", text: d.raw });
      const loc = d.note ? `${d.note.path}${d.note.line ? ":" + d.note.line : ""}` : d.file ? `${this.cb.label(d.file)}${d.line ? ":" + d.line : ""}` : "";
      if (d.fixes?.length) {
        const fx = self.createDiv({ cls: "tp-log-fixes" });
        for (const f of d.fixes) {
          const b = fx.createEl("button", { cls: "tp-log-fix", text: f.label });
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            void Promise.resolve(f.run()).catch((err) => console.error("[TeXPane] quick fix failed", err));
          });
        }
      }
      if (loc) self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair", text: loc });
      self.addEventListener("click", () => this.cb.onSelect(d));
    }
  }
}
