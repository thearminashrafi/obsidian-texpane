import { loadPdfJs, setIcon } from "obsidian";

export interface PdfCallbacks {
  onInverse(page: number, x: number, y: number): void;
}

type ScaleMode = "fit-width" | "fit-page" | "custom";
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const PAD = 16;

interface Pages {
  el: HTMLElement;
  doc: any;
  sizes: Array<{ w: number; h: number }>;
  pageEls: HTMLElement[];
  dead: boolean;
  tasks: Map<number, any>;
}

/** pdf.js based, double-buffered, lazily rendered PDF viewer. */
export class PdfPane {
  readonly el: HTMLElement;
  private scrollEl: HTMLElement;
  private overlayEl: HTMLElement;
  private footer: HTMLElement;
  private pageLabel!: HTMLElement;
  private zoomSelect!: HTMLSelectElement;
  private pdfjs: any = null;
  private cur: Pages | null = null;
  private mode: ScaleMode = "fit-width";
  private scale = 1;
  private observer: IntersectionObserver | null = null;
  private resizeObs: ResizeObserver;
  private zoomTimer: number | null = null;
  private resizeTimer: number | null = null;
  private scrollRaf = 0;
  private loading: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(parent: HTMLElement, private cb: PdfCallbacks) {
    this.el = parent.createDiv({ cls: "tp-pdf" });
    this.scrollEl = this.el.createDiv({ cls: "tp-pdf-scroll" });
    this.overlayEl = this.el.createDiv({ cls: "tp-pdf-overlay" });
    this.footer = this.el.createDiv({ cls: "tp-pdf-footer" });
    this.buildFooter();
    this.scrollEl.addEventListener("scroll", () => {
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = 0;
        this.updatePageLabel();
      });
    });
    this.scrollEl.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        this.zoomBy(Math.exp(-e.deltaY * 0.0125), true);
      },
      { passive: false },
    );
    this.scrollEl.addEventListener("dblclick", (e) => this.handleDblClick(e));
    this.resizeObs = new ResizeObserver(() => {
      if (this.mode === "custom" || !this.cur) return;
      if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.applyScale(this.computeScale(this.cur!.sizes), false), 120);
    });
    this.resizeObs.observe(this.scrollEl);
  }

  // ---------- footer ----------
  private buildFooter() {
    const f = this.footer;
    const btn = (icon: string, label: string, fn: () => void) => {
      const b = f.createDiv({ cls: "clickable-icon tp-pdf-btn", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.addEventListener("click", fn);
      return b;
    };
    this.pageLabel = f.createSpan({ cls: "tp-pdf-page", text: "" });
    f.createDiv({ cls: "tp-spacer" });
    btn("zoom-out", "Zoom out", () => this.zoomBy(1 / 1.2, true));
    this.zoomSelect = f.createEl("select", { cls: "dropdown tp-pdf-zoom" });
    this.zoomSelect.createEl("option", { value: "fit-width", text: "Fit width" });
    this.zoomSelect.createEl("option", { value: "fit-page", text: "Fit page" });
    for (const z of ZOOM_STEPS) this.zoomSelect.createEl("option", { value: String(z), text: `${Math.round(z * 100)}%` });
    this.zoomSelect.createEl("option", { value: "custom", text: "Custom" }).hide();
    this.zoomSelect.addEventListener("change", () => {
      const v = this.zoomSelect.value;
      if (v === "fit-width" || v === "fit-page") this.setMode(v);
      else this.setCustom(Number(v));
    });
    btn("zoom-in", "Zoom in", () => this.zoomBy(1.2, true));
  }

  private updateZoomUi() {
    if (this.mode === "custom") {
      const match = ZOOM_STEPS.find((z) => Math.abs(z - this.scale) < 0.005);
      if (match) this.zoomSelect.value = String(match);
      else {
        const opt = this.zoomSelect.querySelector<HTMLOptionElement>('option[value="custom"]')!;
        opt.show();
        opt.textContent = `${Math.round(this.scale * 100)}%`;
        this.zoomSelect.value = "custom";
      }
    } else this.zoomSelect.value = this.mode;
  }

  // ---------- state helpers ----------
  setBuilding(b: boolean) {
    this.el.toggleClass("is-building", b);
  }
  setStale(b: boolean) {
    this.el.toggleClass("is-stale", b);
  }
  setDark(b: boolean) {
    this.el.toggleClass("is-dark", b);
  }
  hasDocument(): boolean {
    return !!this.cur;
  }
  /** Mount a card (or clear with null) over the viewer. */
  showCard(content: HTMLElement | null) {
    this.overlayEl.empty();
    if (!content) {
      this.overlayEl.removeClass("is-visible");
      return;
    }
    this.overlayEl.appendChild(content);
    this.overlayEl.addClass("is-visible");
  }
  overlayRoot(): HTMLElement {
    return this.overlayEl;
  }

  // ---------- loading ----------
  load(bytes: Uint8Array): Promise<void> {
    this.loading = this.loading.then(() => this.doLoad(bytes)).catch((e) => console.error("[TeXPane] PDF load failed", e));
    return this.loading;
  }

  private async doLoad(bytes: Uint8Array): Promise<void> {
    if (this.disposed) return;
    this.pdfjs ??= await loadPdfJs();
    const doc = await this.pdfjs.getDocument({ data: bytes }).promise;
    if (this.disposed) {
      doc.destroy();
      return;
    }
    const sizes: Array<{ w: number; h: number }> = new Array(doc.numPages);
    for (let i = 0; i < doc.numPages; i += 24) {
      await Promise.all(
        Array.from({ length: Math.min(24, doc.numPages - i) }, async (_, k) => {
          const p = await doc.getPage(i + k + 1);
          const vp = p.getViewport({ scale: 1 });
          sizes[i + k] = { w: vp.width, h: vp.height };
        }),
      );
    }
    const old = this.cur;
    const pos = old ? this.capturePosition() : null;
    const scale = this.mode === "custom" ? this.scale : this.computeScale(sizes);
    const next = this.buildPages(doc, sizes, scale);
    next.el.addClass("is-next");
    this.scrollEl.appendChild(next.el);
    // target scroll position
    let target = 0;
    if (pos && pos.index < sizes.length) target = next.pageEls[pos.index].offsetTop + pos.offsetPts * scale;
    // pre-render visible pages into the hidden buffer
    const vh = this.scrollEl.clientHeight || 800;
    const visible: number[] = [];
    next.pageEls.forEach((p, i) => {
      if (p.offsetTop + p.offsetHeight >= target && p.offsetTop <= target + vh) visible.push(i);
    });
    await Promise.all(visible.slice(0, 6).map((i) => this.renderPage(next, i, scale)));
    if (this.disposed || next.dead) return;
    // swap
    if (old) this.retire(old);
    next.el.removeClass("is-next");
    this.cur = next;
    this.scale = scale;
    this.scrollEl.scrollTop = target;
    this.observe(next);
    this.updatePageLabel();
    this.updateZoomUi();
  }

  private retire(p: Pages) {
    p.dead = true;
    for (const t of p.tasks.values()) {
      try {
        t.cancel();
      } catch {
        /* ignore */
      }
    }
    p.tasks.clear();
    this.observer?.disconnect();
    p.el.remove();
    try {
      p.doc.destroy();
    } catch {
      /* ignore */
    }
  }

  private buildPages(doc: any, sizes: Array<{ w: number; h: number }>, scale: number): Pages {
    const el = createDiv({ cls: "tp-pdf-pages" });
    const pageEls = sizes.map((s, i) => {
      const pe = el.createDiv({ cls: "tp-page" });
      pe.dataset.page = String(i);
      pe.style.width = `${s.w * scale}px`;
      pe.style.height = `${s.h * scale}px`;
      return pe;
    });
    return { el, doc, sizes, pageEls, dead: false, tasks: new Map() };
  }

  private observe(p: Pages) {
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        if (p.dead) return;
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) void this.renderPage(p, i, this.scale);
          else this.release(p, i);
        }
      },
      { root: this.scrollEl, rootMargin: "150% 0px 150% 0px" },
    );
    p.pageEls.forEach((pe) => this.observer!.observe(pe));
  }

  private release(p: Pages, i: number) {
    const pe = p.pageEls[i];
    const t = p.tasks.get(i);
    if (t) {
      try {
        t.cancel();
      } catch {
        /* ignore */
      }
      p.tasks.delete(i);
    }
    const c = pe.querySelector("canvas");
    if (c) {
      c.width = 0;
      c.height = 0;
      c.remove();
    }
    delete pe.dataset.rs;
  }

  private async renderPage(p: Pages, i: number, scale: number, force = false): Promise<void> {
    const pe = p.pageEls[i];
    if (!pe || p.dead) return;
    const key = scale.toFixed(4) + "@" + (window.devicePixelRatio || 1);
    if (!force && pe.dataset.rs === key) return;
    if (p.tasks.has(i)) {
      if (!force && pe.dataset.rsPending === key) return;
      try {
        p.tasks.get(i).cancel();
      } catch {
        /* ignore */
      }
      p.tasks.delete(i);
    }
    pe.dataset.rsPending = key;
    try {
      const page = await p.doc.getPage(i + 1);
      if (p.dead) return;
      const vp = page.getViewport({ scale });
      let ratio = window.devicePixelRatio || 1;
      while (vp.width * vp.height * ratio * ratio > 24e6 && ratio > 1) ratio -= 0.25;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(vp.width * ratio));
      canvas.height = Math.max(1, Math.floor(vp.height * ratio));
      canvas.style.width = `${vp.width}px`;
      canvas.style.height = `${vp.height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const task = page.render({ canvasContext: ctx, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      p.tasks.set(i, task);
      await task.promise;
      p.tasks.delete(i);
      if (p.dead) return;
      const prev = pe.querySelector("canvas");
      pe.insertBefore(canvas, pe.firstChild);
      prev?.remove();
      pe.dataset.rs = key;
      delete pe.dataset.rsPending;
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name !== "RenderingCancelledException") console.warn("[TeXPane] render failed", e);
    }
  }

  // ---------- geometry ----------
  private computeScale(sizes: Array<{ w: number; h: number }>): number {
    if (!sizes.length) return 1;
    const maxW = Math.max(...sizes.map((s) => s.w));
    const availW = Math.max(100, this.scrollEl.clientWidth - 2 * PAD);
    const fw = availW / maxW;
    if (this.mode === "fit-page") {
      const availH = Math.max(100, this.scrollEl.clientHeight - 2 * PAD);
      return Math.max(0.1, Math.min(fw, availH / sizes[0].h));
    }
    return Math.max(0.1, fw);
  }

  private capturePosition(): { index: number; offsetPts: number } | null {
    const c = this.cur;
    if (!c) return null;
    const top = this.scrollEl.scrollTop;
    for (let i = 0; i < c.pageEls.length; i++) {
      const pe = c.pageEls[i];
      if (pe.offsetTop + pe.offsetHeight > top) return { index: i, offsetPts: (top - pe.offsetTop) / this.scale };
    }
    return { index: c.pageEls.length - 1, offsetPts: 0 };
  }

  private applyScale(scale: number, immediateRender: boolean) {
    const c = this.cur;
    if (!c || Math.abs(scale - this.scale) < 1e-4) {
      this.updateZoomUi();
      return;
    }
    const pos = this.capturePosition();
    this.scale = scale;
    c.sizes.forEach((s, i) => {
      const pe = c.pageEls[i];
      pe.style.width = `${s.w * scale}px`;
      pe.style.height = `${s.h * scale}px`;
      const cv = pe.querySelector("canvas");
      if (cv) {
        cv.style.width = `${s.w * scale}px`;
        cv.style.height = `${s.h * scale}px`;
      }
      delete pe.dataset.rs;
    });
    if (pos) this.scrollEl.scrollTop = c.pageEls[pos.index].offsetTop + pos.offsetPts * scale;
    this.updateZoomUi();
    if (this.zoomTimer) window.clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => this.renderVisible(), immediateRender ? 0 : 150);
  }

  private renderVisible() {
    const c = this.cur;
    if (!c) return;
    const top = this.scrollEl.scrollTop;
    const vh = this.scrollEl.clientHeight;
    c.pageEls.forEach((pe, i) => {
      if (pe.offsetTop + pe.offsetHeight >= top - vh && pe.offsetTop <= top + 2 * vh) void this.renderPage(c, i, this.scale, true);
    });
  }

  setMode(m: "fit-width" | "fit-page") {
    this.mode = m;
    if (this.cur) this.applyScale(this.computeScale(this.cur.sizes), false);
    this.updateZoomUi();
  }
  setCustom(scale: number) {
    this.mode = "custom";
    this.applyScale(Math.min(4, Math.max(0.25, scale)), false);
  }
  zoomBy(factor: number, custom: boolean) {
    if (custom) this.mode = "custom";
    this.applyScale(Math.min(4, Math.max(0.25, this.scale * factor)), false);
  }

  private updatePageLabel() {
    const c = this.cur;
    if (!c) {
      this.pageLabel.setText("");
      return;
    }
    const probe = this.scrollEl.scrollTop + this.scrollEl.clientHeight / 3;
    let idx = 0;
    for (let i = 0; i < c.pageEls.length; i++) {
      if (c.pageEls[i].offsetTop <= probe) idx = i;
      else break;
    }
    this.pageLabel.setText(`${idx + 1} / ${c.pageEls.length}`);
  }

  // ---------- sync ----------
  private handleDblClick(e: MouseEvent) {
    const pe = (e.target as HTMLElement).closest<HTMLElement>(".tp-page");
    if (!pe || !this.cur) return;
    const r = pe.getBoundingClientRect();
    this.cb.onInverse(Number(pe.dataset.page) + 1, (e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale);
  }

  /** Scroll to a SyncTeX box and flash it. Coordinates are PDF points, origin top-left. */
  flash(page: number, h: number, v: number, W: number, H: number) {
    const c = this.cur;
    const pe = c?.pageEls[page - 1];
    if (!c || !pe) return;
    const s = this.scale;
    const top = pe.offsetTop + (v - H) * s;
    this.scrollEl.scrollTo({ top: Math.max(0, top - this.scrollEl.clientHeight / 3), behavior: "smooth" });
    pe.querySelectorAll(".tp-sync-flash").forEach((n) => n.remove());
    const box = pe.createDiv({ cls: "tp-sync-flash" });
    box.style.left = `${h * s}px`;
    box.style.top = `${(v - H) * s}px`;
    box.style.width = `${Math.max(W * s, 10)}px`;
    box.style.height = `${Math.max(H * s, 10)}px`;
    window.setTimeout(() => box.remove(), 1600);
  }

  dispose() {
    this.disposed = true;
    this.resizeObs.disconnect();
    this.observer?.disconnect();
    if (this.zoomTimer) window.clearTimeout(this.zoomTimer);
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    if (this.cur) this.retire(this.cur);
    this.cur = null;
    this.el.remove();
  }
}
