import { setDiagnostics, lintGutter, type Diagnostic as CMDiagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import type { Diagnostic } from "../types";

export const diagnosticsGutter = () => lintGutter();

export function toCMDiagnostics(view: EditorView, diags: Diagnostic[]): CMDiagnostic[] {
  const doc = view.state.doc;
  const out: CMDiagnostic[] = [];
  for (const d of diags) {
    if (!d.line || d.line < 1 || d.line > doc.lines) continue;
    const line = doc.line(d.line);
    const lead = /^\s*/.exec(line.text)![0].length;
    let from = line.from + lead;
    let to = Math.max(from + 1, line.to);
    if (d.col !== undefined && d.endCol !== undefined && d.endCol > d.col) {
      from = line.from + Math.min(d.col, line.length);
      to = line.from + Math.min(d.endCol, line.length);
    }
    const cm: CMDiagnostic = { from: Math.min(from, line.to), to: Math.max(Math.min(from, line.to), Math.min(to, doc.length)), severity: d.severity, message: d.message, source: d.source === "embed" ? "TeXPane" : d.source === "lean" ? "Lean" : "TeX" };
    if (d.fixes?.length) cm.actions = d.fixes.map((f) => ({ name: f.label, apply: () => void f.run() }));
    out.push(cm);
  }
  return out;
}

export function applyDiagnostics(view: EditorView, diags: Diagnostic[]): void {
  view.dispatch(setDiagnostics(view.state, toCMDiagnostics(view, diags)));
}
