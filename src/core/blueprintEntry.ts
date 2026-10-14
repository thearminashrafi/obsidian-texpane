/** Text for a new blueprint entry (used by LeanPane's "Add to blueprint"). Pure. */
import { stripComment } from "./indexers";
import { LineIndex } from "./leanMacros";
import type { ChangeSpec } from "./blueprintModel";

export interface EntryRequest {
  env: string;
  label: string;
  leanName: string;
  statement: string;
}

const ENV_OK = /^[A-Za-z]+\*?$/;

/**
 * Where and what to insert: before \end{document} when the file has one, else at the end.
 * `line` is the 1-based line of the new \begin{env} in the text after the change.
 */
export function blueprintEntryChange(text: string, req: EntryRequest): { change: ChangeSpec; line: number } {
  const env = ENV_OK.test(req.env) ? req.env : "theorem";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = req.statement
    .trim()
    .split(/\r?\n/)
    .map((l) => (l.trim() ? "  " + l.trimEnd() : ""))
    .join(eol);
  const block = [`\\begin{${env}}`, `  \\label{${req.label}}`, `  \\lean{${req.leanName}}`, ...(body ? [body] : []), `\\end{${env}}`].join(eol);

  const lines = text.split(/\r?\n/);
  const idx = new LineIndex(text);
  let endDoc = -1;
  lines.forEach((l, i) => {
    if (/\\end\s*\{document\}/.test(stripComment(l))) endDoc = i + 1;
  });
  if (endDoc > 0) {
    const at = idx.lineStart(endDoc);
    const prev = endDoc > 1 ? lines[endDoc - 2] : "";
    const gap = prev.trim() === "" ? "" : eol;
    return { change: { from: at, to: at, insert: gap + block + eol + eol }, line: endDoc + (gap ? 1 : 0) };
  }
  const trailing = text === "" || text.endsWith("\n") ? "" : eol;
  const blank = text.trim() === "" ? "" : eol;
  const nLines = text === "" ? 0 : text.endsWith("\n") ? lines.length - 1 : lines.length;
  return { change: { from: text.length, to: text.length, insert: trailing + blank + block + eol }, line: nLines + (blank ? 2 : 1) };
}
