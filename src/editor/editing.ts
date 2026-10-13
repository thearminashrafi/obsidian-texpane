import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export function toggleComment(view: EditorView): boolean {
  const { state } = view;
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  const arr = [...lines].map((n) => state.doc.line(n));
  const nonEmpty = arr.filter((l) => l.text.trim() !== "");
  const allCommented = nonEmpty.length > 0 && nonEmpty.every((l) => /^\s*%/.test(l.text));
  const changes = arr.flatMap((l) => {
    if (l.text.trim() === "") return [];
    if (allCommented) {
      const m = /^(\s*)%\s?/.exec(l.text)!;
      return [{ from: l.from + m[1].length, to: l.from + m[0].length, insert: "" }];
    }
    const indent = /^\s*/.exec(l.text)![0].length;
    return [{ from: l.from + indent, insert: "% " }];
  });
  if (changes.length) view.dispatch({ changes, userEvent: "input.comment" });
  return true;
}

export function wrapSelection(view: EditorView, open: string, close: string): boolean {
  const { state } = view;
  const tr = state.changeByRange((r) => {
    if (r.empty) {
      return { changes: { from: r.from, insert: open + close }, range: EditorSelection.cursor(r.from + open.length) };
    }
    const sel = state.sliceDoc(r.from, r.to);
    if (sel.startsWith(open) && sel.endsWith(close) && sel.length >= open.length + close.length) {
      return { changes: { from: r.from, to: r.to, insert: sel.slice(open.length, sel.length - close.length) }, range: EditorSelection.range(r.from, r.to - open.length - close.length) };
    }
    return { changes: [{ from: r.from, insert: open }, { from: r.to, insert: close }], range: EditorSelection.range(r.from + open.length, r.to + open.length) };
  });
  view.dispatch(tr, { userEvent: "input" });
  return true;
}
export const bold = (v: EditorView) => wrapSelection(v, "\\textbf{", "}");
export const italic = (v: EditorView) => wrapSelection(v, "\\emph{", "}");
