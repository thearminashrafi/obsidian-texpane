import { RangeSetBuilder, StateEffect, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { setIcon } from "obsidian";
import type { DeclStatus } from "../integration/api-types";
import { chipInfo, type LeanAvailability } from "../integration/chipInfo";
import { stripComment } from "../core/indexers";
import { splitNames } from "../core/leanMacros";

export interface LeanChipHost {
  availability(): LeanAvailability;
  /** Cached status; asks for it when unknown */
  status(name: string): DeclStatus | undefined;
  open(name: string, newTab: boolean): void;
}

export const refreshLeanChips = StateEffect.define<null>();

const MACRO = /\\lean(?![A-Za-z@])\s*\{([^}\n]*)\}/g;

export interface LeanChipRange {
  from: number;
  to: number;
  names: string[];
}

/** \lean{..} macros to show as chips (one line each; comments, escaped backslashes and the selection are skipped). */
export function scanLeanChips(state: EditorState, ranges: readonly { from: number; to: number }[]): LeanChipRange[] {
  const out: LeanChipRange[] = [];
  const sel = state.selection.ranges;
  let next = 0;
  for (const { from, to } of ranges) {
    let pos = Math.max(from, next);
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      if (line.text.includes("\\lean")) {
        MACRO.lastIndex = 0;
        const codeLen = stripComment(line.text).length;
        let m: RegExpExecArray | null;
        while ((m = MACRO.exec(line.text))) {
          if (m.index >= codeLen) continue;
          if ((/\\*$/.exec(line.text.slice(0, m.index))?.[0].length ?? 0) % 2) continue;
          const a = line.from + m.index;
          const z = a + m[0].length;
          if (sel.some((r) => r.from <= z && r.to >= a)) continue;
          const names = splitNames(m[1]).map((x) => x.name);
          if (!names.length) continue;
          out.push({ from: a, to: z, names });
        }
      }
      pos = next = line.to + 1;
    }
  }
  return out;
}

class LeanChipWidget extends WidgetType {
  constructor(
    private names: string[],
    private host: LeanChipHost,
    private from: number,
    private key: string,
  ) {
    super();
  }
  eq(o: LeanChipWidget) {
    return o.key === this.key && o.from === this.from;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = "tp-lean-chip";
    const ic = el.createSpan({ cls: "tp-lean-chip-icon" });
    setIcon(ic, "square-function");
    const avail = this.host.availability();
    for (const name of this.names) {
      const info = chipInfo(name, avail, avail === "ready" ? this.host.status(name) : undefined);
      const pill = el.createSpan({ cls: `tp-lean-name is-${info.visual}`, text: name });
      pill.dataset.leanName = name;
      pill.setAttr("aria-label", info.tooltip);
      pill.setAttr("aria-label-classes", "tp-lean-tip");
      pill.setAttr("aria-label-delay", "200");
    }
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        const name = (e.target as HTMLElement).closest<HTMLElement>(".tp-lean-name")?.dataset.leanName ?? this.names[0];
        this.host.open(name, e.altKey);
        return;
      }
      // reveal the raw text for editing
      view.dispatch({ selection: { anchor: this.from + 1 } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/** Chip key: names with what they currently look like, so a changed status redraws the widget. */
function keyOf(names: string[], host: LeanChipHost): string {
  const avail = host.availability();
  return names.map((n) => `${n}:${avail === "ready" ? (host.status(n)?.state ?? "?") : avail}`).join("|");
}

export function leanChips(host: LeanChipHost): Extension {
  return ViewPlugin.fromClass(
    class {
      decos: DecorationSet = Decoration.none;
      constructor(view: EditorView) {
        this.decos = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(refreshLeanChips)))) this.decos = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const b = new RangeSetBuilder<Decoration>();
        for (const c of scanLeanChips(view.state, view.visibleRanges)) {
          b.add(c.from, c.to, Decoration.replace({ widget: new LeanChipWidget(c.names, host, c.from, keyOf(c.names, host)) }));
        }
        return b.finish();
      }
    },
    {
      decorations: (v) => v.decos,
      provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.decos ?? Decoration.none),
    },
  );
}
