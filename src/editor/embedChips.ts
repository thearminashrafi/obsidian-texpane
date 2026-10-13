import { RangeSetBuilder, StateEffect, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { setIcon } from "obsidian";
import { parseEmbedTarget } from "../core/embedScanner";
import { stripComment } from "../core/indexers";

export interface ChipHost {
  exists(note: string): boolean;
  open(note: string, newTab: boolean): void;
  hover(ev: MouseEvent, el: HTMLElement, linktext: string): void;
  /** Return the markdown note path being dragged, or null */
  dragNote(ev: DragEvent): string | null;
}

export const refreshChips = StateEffect.define<null>();

const MACRO = /\\obsidian(?![A-Za-z@])\s*(?:\[([^\]\n]*)\])?\s*\{([^}\n]*)\}/g;

class ChipWidget extends WidgetType {
  constructor(
    private target: string,
    private opts: string,
    private exists: boolean,
    private host: ChipHost,
    private from: number,
  ) {
    super();
  }
  eq(o: ChipWidget) {
    return o.target === this.target && o.opts === this.opts && o.exists === this.exists && o.from === this.from;
  }
  toDOM(view: EditorView): HTMLElement {
    const p = parseEmbedTarget(this.target);
    const el = document.createElement("span");
    el.className = "tp-embed-chip" + (this.exists ? "" : " is-unresolved");
    const ic = el.createSpan({ cls: "tp-embed-chip-icon" });
    setIcon(ic, this.exists ? "file-text" : "file-question");
    let label = p.note || "(empty)";
    if (p.heading) label += ` > ${p.heading}`;
    if (p.blockId) label += ` > ^${p.blockId}`;
    el.createSpan({ cls: "tp-embed-chip-label", text: label });
    if (this.opts.trim()) el.createSpan({ cls: "tp-embed-chip-opts", text: this.opts.trim() });
    el.setAttr("aria-label", this.exists ? `Mod+click to open ${p.note}` : `Note not found: ${p.note}`);
    el.addEventListener("mouseover", (e) => {
      if (this.exists) this.host.hover(e, el, this.target);
    });
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const mod = e.metaKey || e.ctrlKey;
      if (mod) {
        if (this.exists) this.host.open(p.note, e.altKey);
        return;
      }
      // reveal raw text for editing
      view.dispatch({ selection: { anchor: this.from + 1 } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

export interface ChipRange {
  from: number;
  to: number;
  target: string;
  opts: string;
  exists: boolean;
}

/** \obsidian{...} macros to show as chips, sorted by position. Each line is scanned once even when
 * several visible ranges fall on it (CodeMirror splits very long lines with line gaps). */
export function scanChips(state: EditorState, ranges: readonly { from: number; to: number }[], exists: (note: string) => boolean): ChipRange[] {
  const out: ChipRange[] = [];
  const sel = state.selection.ranges;
  let next = 0;
  for (const { from, to } of ranges) {
    let pos = Math.max(from, next);
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      if (line.text.includes("\\obsidian")) {
        MACRO.lastIndex = 0;
        const codeLen = stripComment(line.text).length;
        let m: RegExpExecArray | null;
        while ((m = MACRO.exec(line.text))) {
          if (m.index >= codeLen) continue; // inside a comment
          if ((/\\*$/.exec(line.text.slice(0, m.index))?.[0].length ?? 0) % 2) continue; // \\obsidian: escaped backslash
          const a = line.from + m.index;
          const z = a + m[0].length;
          if (sel.some((r) => r.from <= z && r.to >= a)) continue;
          const target = m[2].trim();
          const note = parseEmbedTarget(target).note;
          out.push({ from: a, to: z, target, opts: m[1] ?? "", exists: note !== "" && exists(note) });
        }
      }
      pos = next = line.to + 1;
    }
  }
  return out;
}

export function embedChips(host: ChipHost): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decos: DecorationSet = Decoration.none;
      constructor(view: EditorView) {
        this.decos = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(refreshChips)))) this.decos = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const b = new RangeSetBuilder<Decoration>();
        for (const c of scanChips(view.state, view.visibleRanges, (n) => host.exists(n))) {
          b.add(c.from, c.to, Decoration.replace({ widget: new ChipWidget(c.target, c.opts, c.exists, host, c.from) }));
        }
        return b.finish();
      }
    },
    {
      decorations: (v) => v.decos,
      provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.decos ?? Decoration.none),
    },
  );
  const drop = EditorView.domEventHandlers({
    dragover(ev) {
      if (host.dragNote(ev)) {
        ev.preventDefault();
        return true;
      }
      return false;
    },
    drop(ev, view) {
      const note = host.dragNote(ev);
      if (!note) return false;
      ev.preventDefault();
      const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY }) ?? view.state.selection.main.head;
      const ins = `\\obsidian{${note}}`;
      view.dispatch({ changes: { from: pos, insert: ins }, selection: { anchor: pos + ins.length }, userEvent: "input.drop" });
      view.focus();
      return true;
    },
  });
  return [plugin, drop];
}
