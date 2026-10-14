import { ItemView, Notice, WorkspaceLeaf, setIcon, type ViewStateResult } from "obsidian";
import type TexPanePlugin from "../main";
import type { PanelData } from "../integration/leanIntegration";
import { FILTER_LABEL, STATUS_LABEL, filterGraph, graphEdges, matchesFilter, progress, type GraphFilter, type GraphNode, type VisualStatus } from "../core/blueprintModel";
import { layoutGraph } from "../core/blueprintGraph";

export const BLUEPRINT_TYPE = "texpane-blueprint";

const SVG_NS = "http://www.w3.org/2000/svg";
const NARROW_PX = 480;
const NODE_W = 150;
const NODE_H = 34;
const PAD = 16;
const FILTERS: GraphFilter[] = ["all", "ready", "blocked", "unformalized"];
const LEGEND: VisualStatus[] = ["proved", "mathlib", "sorry-deps", "stated", "error", "missing", "none"];

let arrowSeq = 0;

function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent.appendChild(el);
  return el;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Blueprint progress: dependency graph of the project's theorems and definitions, coloured by what Lean says.
 * Note: private helpers must not reuse names of Obsidian View internals (open, close, load, unload, render, ...).
 */
export class BlueprintView extends ItemView {
  private root: string | null = null;
  private panelData: PanelData | null = null;
  private filter: GraphFilter = "all";
  private forced: "graph" | "list" | null = null;
  private zoom = 1;
  private bodyEl!: HTMLElement;
  private headEl!: HTMLElement;
  private resizeObs: ResizeObserver | null = null;
  private reloadTimer: number | null = null;
  private fetchToken = 0;
  private clickTimer: number | null = null;
  private loading = false;
  private arrowId = `tp-bp-arrow-${arrowSeq++}`;

  constructor(leaf: WorkspaceLeaf, private plugin: TexPanePlugin) {
    super(leaf);
  }
  getViewType() {
    return BLUEPRINT_TYPE;
  }
  getDisplayText() {
    return "Blueprint progress";
  }
  getIcon() {
    return "git-fork";
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), root: this.root, filter: this.filter, forced: this.forced };
  }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const st = (state ?? {}) as { root?: unknown; filter?: unknown; forced?: unknown };
    if (typeof st.root === "string") this.root = st.root;
    if (typeof st.filter === "string" && (FILTERS as string[]).includes(st.filter)) this.filter = st.filter as GraphFilter;
    if (st.forced === "graph" || st.forced === "list") this.forced = st.forced;
    await super.setState(state, result);
    if (this.bodyEl) this.scheduleFetch(0);
  }

  async onOpen() {
    const el = this.contentEl;
    el.empty();
    el.addClass("tp-bp");
    this.headEl = el.createDiv({ cls: "tp-bp-head" });
    this.bodyEl = el.createDiv({ cls: "tp-bp-body" });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.followActive()));
    this.register(this.plugin.lean.onUpdated(() => this.scheduleFetch(250)));
    this.resizeObs = new ResizeObserver(() => this.drawAll());
    this.resizeObs.observe(el);
    this.followActive(true);
  }
  async onClose() {
    this.resizeObs?.disconnect();
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
    if (this.clickTimer) window.clearTimeout(this.clickTimer);
    this.fetchToken++;
  }

  /** Show the project of the LaTeX file being edited. */
  private followActive(force = false) {
    const active = this.plugin.lean.activeRoot();
    if (active && (active !== this.root || force)) {
      this.root = active;
      this.scheduleFetch(0);
    } else if (force) this.scheduleFetch(0);
  }

  private scheduleFetch(delay: number, refresh = false) {
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      void this.fetchData(refresh);
    }, delay);
  }

  private async fetchData(refresh: boolean) {
    const token = ++this.fetchToken;
    if (!this.plugin.lean.available() || !this.root) {
      this.panelData = null;
      this.loading = false;
      this.drawAll();
      return;
    }
    this.loading = true;
    this.drawHead();
    try {
      const data = await this.plugin.lean.panelData(this.root, refresh);
      if (token !== this.fetchToken) return;
      this.panelData = data;
    } catch (e) {
      if (token !== this.fetchToken) return;
      console.warn("[TeXPane] blueprint panel failed", e);
      this.panelData = null;
    }
    this.loading = false;
    this.drawAll();
  }

  // ---------------------------------------------------------------- drawing
  private mode(): "graph" | "list" {
    if (this.forced) return this.forced;
    return this.contentEl.clientWidth > 0 && this.contentEl.clientWidth < NARROW_PX ? "list" : "graph";
  }

  private drawAll() {
    if (!this.bodyEl) return;
    this.drawHead();
    this.drawBody();
  }

  private note(parent: HTMLElement, text: string) {
    parent.createDiv({ cls: "pane-empty tp-bp-note", text });
  }

  private drawHead() {
    const h = this.headEl;
    h.empty();
    const d = this.panelData;
    const bar = h.createDiv({ cls: "tp-bp-bar" });
    bar.createDiv({ cls: "tp-bp-title", text: d ? d.name : "Blueprint progress" });
    bar.createDiv({ cls: "tp-spacer" });
    const mode = this.mode();
    const btn = (icon: string, label: string, fn: () => void, cls = "") => {
      const b = bar.createDiv({ cls: `clickable-icon tp-bp-btn ${cls}`, attr: { "aria-label": label } });
      setIcon(b, icon);
      b.addEventListener("click", fn);
      return b;
    };
    if (mode === "graph" && d && d.graph.length) {
      btn("zoom-out", "Zoom out", () => this.setZoom(this.zoom / 1.25));
      btn("zoom-in", "Zoom in", () => this.setZoom(this.zoom * 1.25));
    }
    btn(mode === "graph" ? "list" : "network", mode === "graph" ? "Show as list" : "Show as graph", () => {
      this.forced = mode === "graph" ? "list" : "graph";
      this.drawAll();
      this.app.workspace.requestSaveLayout();
    });
    btn("refresh-cw", "Ask Lean again", () => this.scheduleFetch(0, true), this.loading ? "is-spinning" : "");
    if (!d || !d.graph.length) return;

    const p = progress(d.graph);
    const prog = h.createDiv({ cls: "tp-bp-progress" });
    const track = prog.createDiv({ cls: "tp-bp-track" });
    const seg = (cls: string, n: number) => {
      if (!n) return;
      const s = track.createDiv({ cls: `tp-bp-seg ${cls}` });
      s.style.width = `${(n / p.total) * 100}%`;
    };
    seg("is-proved", p.counts.proved);
    seg("is-mathlib", p.counts.mathlib);
    seg("is-sorry-deps", p.counts["sorry-deps"]);
    seg("is-stated", p.counts.stated);
    seg("is-error", p.counts.error);
    const ready = d.graph.filter((n) => n.ready).length;
    const blocked = d.graph.filter((n) => n.blocked).length;
    prog.createDiv({ cls: "tp-bp-total", text: p.text });
    prog.createDiv({ cls: "tp-bp-sub", text: `${ready} ready to prove · ${blocked} blocked` });

    const fl = h.createDiv({ cls: "tp-bp-filters" });
    for (const f of FILTERS) {
      const n = filterGraph(d.graph, f).length;
      const b = fl.createDiv({ cls: "tp-bp-filter" + (this.filter === f ? " is-active" : ""), text: `${FILTER_LABEL[f]} ${n}` });
      b.addEventListener("click", () => {
        this.filter = f;
        this.drawAll();
        this.app.workspace.requestSaveLayout();
      });
    }

    const lg = h.createDiv({ cls: "tp-bp-legend" });
    for (const s of LEGEND) {
      const it = lg.createDiv({ cls: "tp-bp-legend-item" });
      it.createSpan({ cls: `tp-bp-swatch is-${s}` });
      it.createSpan({ text: STATUS_LABEL[s].replace("Proved, but depends on sorry", "Uses sorry").replace("Stated (proof is sorry)", "Stated").replace("Lean reports an error", "Error") });
    }
    const r = lg.createDiv({ cls: "tp-bp-legend-item", attr: { "aria-label": "Not proved yet, and everything it uses is proved" } });
    r.createSpan({ cls: "tp-bp-swatch is-ring-ready" });
    r.createSpan({ text: "Ready" });
    const b = lg.createDiv({ cls: "tp-bp-legend-item", attr: { "aria-label": "Not proved yet, and something it uses is not proved" } });
    b.createSpan({ cls: "tp-bp-swatch is-ring-blocked" });
    b.createSpan({ text: "Blocked" });
  }

  private drawBody() {
    const el = this.bodyEl;
    el.empty();
    if (!this.plugin.lean.available()) {
      this.note(el, "LeanPane isn't installed or isn't enabled. Install and enable it to see Lean progress for a blueprint.");
      return;
    }
    if (!this.root) {
      this.note(el, "Open a LaTeX file to see its blueprint.");
      return;
    }
    const d = this.panelData;
    if (!d) {
      this.note(el, this.loading ? "Reading the blueprint…" : "Could not read the blueprint of this project.");
      return;
    }
    if (!d.graph.length) {
      this.note(el, "No theorem, lemma, proposition, corollary or definition with a \\label found in this project.");
      return;
    }
    if (!d.info) this.note(el, 'No Lean project found. Put the blueprint inside a Lean project, or add "% !LEAN project = <folder>" to the root .tex file. Statuses below are unknown.');
    if (this.mode() === "list") this.drawList(el, d);
    else this.drawGraph(el, d);
  }

  private setZoom(z: number) {
    this.zoom = Math.min(2.5, Math.max(0.3, z));
    this.drawBody();
  }

  private tooltip(n: GraphNode): string {
    const nd = n.node;
    const lines = [`${nd.label}${nd.title ? ` (${nd.title})` : ""}`, `${nd.env}, ${STATUS_LABEL[n.status]}`];
    if (nd.lean.length) lines.push(`Lean: ${nd.lean.join(", ")}`);
    if (n.deps.length) lines.push(`Uses: ${n.deps.join(", ")}`);
    if (n.ready) lines.push("Ready to prove");
    if (n.blocked) lines.push("Blocked by something not yet proved");
    lines.push("Click: show in LaTeX. Double-click: open in Lean.");
    return lines.join("\n");
  }

  private statusClasses(n: GraphNode): string {
    return `is-${n.status}${n.ready ? " is-ready" : ""}${n.blocked ? " is-blocked" : ""}`;
  }

  private drawGraph(parent: HTMLElement, d: PanelData) {
    const scroll = parent.createDiv({ cls: "tp-bp-scroll" });
    const ids = d.graph.map((n) => n.id);
    const layout = layoutGraph(ids, graphEdges(d.graph), { nodeW: NODE_W, nodeH: NODE_H });
    const byId = new Map(d.graph.map((n) => [n.id, n]));
    const w = layout.width + PAD * 2;
    const h = layout.height + PAD * 2;
    const root = svg(scroll, "svg", { class: "tp-bp-svg", viewBox: `0 0 ${w} ${h}`, width: Math.round(w * this.zoom), height: Math.round(h * this.zoom), role: "img", "aria-label": "Blueprint dependency graph" });
    const defs = svg(root, "defs");
    const marker = svg(defs, "marker", { id: this.arrowId, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto" });
    svg(marker, "path", { d: "M0,0 L8,4 L0,8 z", class: "tp-bp-arrowhead" });
    const g = svg(root, "g", { transform: `translate(${PAD},${PAD})` });

    const shown = new Set(d.graph.filter((n) => matchesFilter(n, this.filter)).map((n) => n.id));
    const edgeEls: Array<{ el: SVGElement; from: string; to: string }> = [];
    for (const e of layout.edges) {
      const dim = !(shown.has(e.from) && shown.has(e.to));
      const el = svg(g, "path", { d: e.d, class: `tp-bp-edge${e.back ? " is-back" : ""}${dim ? " is-dim" : ""}`, "marker-end": `url(#${this.arrowId})` });
      edgeEls.push({ el, from: e.from, to: e.to });
    }
    for (const p of layout.nodes) {
      const n = byId.get(p.id)!;
      const grp = svg(g, "g", { class: `tp-bp-node ${this.statusClasses(n)}${shown.has(n.id) ? "" : " is-dim"}`, transform: `translate(${p.x},${p.y})`, tabindex: 0 });
      svg(grp, "title").textContent = this.tooltip(n);
      svg(grp, "rect", { width: p.w, height: p.h, rx: n.node.env === "definition" ? 6 : p.h / 2, class: "tp-bp-box" });
      const text = svg(grp, "text", { x: p.w / 2, y: p.h / 2, class: "tp-bp-label", "text-anchor": "middle", "dominant-baseline": "central" });
      text.textContent = clip(n.id, 22);
      grp.addEventListener("click", () => this.nodeClick(n));
      grp.addEventListener("dblclick", () => this.nodeDouble(n));
      grp.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Enter") this.nodeClick(n);
      });
      grp.addEventListener("mouseenter", () => {
        for (const e of edgeEls) if (e.from === n.id || e.to === n.id) e.el.classList.add("is-hot");
      });
      grp.addEventListener("mouseleave", () => {
        for (const e of edgeEls) e.el.classList.remove("is-hot");
      });
    }
  }

  private drawList(parent: HTMLElement, d: PanelData) {
    const list = parent.createDiv({ cls: "tp-bp-list" });
    const rows = filterGraph(d.graph, this.filter);
    if (!rows.length) {
      this.note(list, "Nothing matches this filter.");
      return;
    }
    for (const n of rows) {
      const row = list.createDiv({ cls: "tree-item" });
      const self = row.createDiv({ cls: "tree-item-self is-clickable tp-bp-row", attr: { "aria-label": this.tooltip(n), "aria-label-classes": "tp-lean-tip" } });
      self.createSpan({ cls: `tp-bp-swatch ${this.statusClasses(n)}` });
      const inner = self.createDiv({ cls: "tree-item-inner" });
      inner.createSpan({ cls: "tp-bp-row-label", text: n.id });
      inner.createSpan({ cls: "tp-bp-row-env", text: ` ${n.node.env}${n.node.title ? " · " + n.node.title : ""}` });
      const flair = self.createDiv({ cls: "tree-item-flair-outer" });
      flair.createSpan({ cls: "tree-item-flair", text: STATUS_LABEL[n.status].replace("Proved, but depends on sorry", "Uses sorry") });
      self.addEventListener("click", () => this.nodeClick(n));
      self.addEventListener("dblclick", () => this.nodeDouble(n));
    }
  }

  // ---------------------------------------------------------------- actions
  private nodeClick(n: GraphNode) {
    // wait a moment: a double-click is "open in Lean", not "jump twice, then open"
    if (this.clickTimer) window.clearTimeout(this.clickTimer);
    this.clickTimer = window.setTimeout(() => {
      this.clickTimer = null;
      void this.plugin.lean.api.openLocation(n.node.file, n.node.line).catch((e) => new Notice(`TeXPane: ${(e as Error).message}`));
    }, 220);
  }
  private nodeDouble(n: GraphNode) {
    if (this.clickTimer) window.clearTimeout(this.clickTimer);
    this.clickTimer = null;
    const info = this.panelData?.info;
    const name = n.node.lean[0];
    if (!name) {
      new Notice(`TeXPane: ${n.id} has no \\lean{..} name yet. Use "Formalize this" in the editor.`);
      return;
    }
    if (!info) {
      new Notice("TeXPane: no Lean project found for this blueprint.");
      return;
    }
    void this.plugin.lean.openDeclarationIn(info.root, name);
  }
}
