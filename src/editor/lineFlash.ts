import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

const flashOn = StateEffect.define<number>();
const flashOff = StateEffect.define<null>();

export const lineFlashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashOn)) deco = Decoration.set([Decoration.line({ class: "tp-line-flash" }).range(e.value)]);
      if (e.is(flashOff)) deco = Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function flashLine(view: EditorView, lineNo: number) {
  const n = Math.min(Math.max(1, lineNo), view.state.doc.lines);
  const pos = view.state.doc.line(n).from;
  view.dispatch({ effects: flashOn.of(pos) });
  window.setTimeout(() => {
    try {
      view.dispatch({ effects: flashOff.of(null) });
    } catch {
      /* view destroyed */
    }
  }, 1400);
}
