import { EditorSelection } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";

/** Enter after `\begin{env}` inserts a matching `\end{env}` (when the environment is not closed yet). */
export function envEnter(view: EditorView): boolean {
  const sel = view.state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return false;
  const pos = sel.main.head;
  const line = view.state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const after = line.text.slice(pos - line.from);
  if (after.trim() !== "") return false;
  const m = /\\begin\{([A-Za-z*]+)\}(?:\[[^\]]*\]|\{[^}]*\})*\s*$/.exec(before);
  if (!m) return false;
  const name = m[1];
  const text = view.state.doc.toString();
  const esc = name.replace(/\*/g, "\\*");
  const begins = (text.match(new RegExp(`\\\\begin\\{${esc}\\}`, "g")) ?? []).length;
  const ends = (text.match(new RegExp(`\\\\end\\{${esc}\\}`, "g")) ?? []).length;
  if (ends >= begins) return false;
  const indent = /^\s*/.exec(line.text)![0];
  const unit = view.state.facet(indentUnit);
  const insert = `\n${indent}${unit}\n${indent}\\end{${name}}`;
  const cursor = pos + 1 + indent.length + unit.length;
  view.dispatch({ changes: { from: pos, insert }, selection: EditorSelection.cursor(cursor), scrollIntoView: true, userEvent: "input" });
  return true;
}

export const envAutoClose = keymap.of([{ key: "Enter", run: envEnter }]);
