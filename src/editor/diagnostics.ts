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
    const from = line.from + lead;
    const to = Math.max(from + 1, line.to);
    out.push({ from: Math.min(from, line.to), to: Math.min(to, doc.length), severity: d.severity, message: d.message, source: d.source === "embed" ? "TeXPane" : "TeX" });
  }
  return out;
}

export function applyDiagnostics(view: EditorView, diags: Diagnostic[]): void {
  view.dispatch(setDiagnostics(view.state, toCMDiagnostics(view, diags)));
}
