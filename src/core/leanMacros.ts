/**
 * Locating \lean{..} and \leanok in LaTeX text. Pure.
 * Positions are offsets into the original text: comment text is blanked with spaces, never removed.
 */
import { stripComment } from "./indexers";

export interface LeanNameSite {
  name: string;
  from: number;
  to: number;
}
export interface MacroSite {
  macro: "lean" | "leanok";
  from: number;
  to: number;
  /** Names inside \lean{..}, with their offsets */
  names: LeanNameSite[];
}

/** Same text with everything from an unescaped % to the end of each line replaced by spaces. */
export function blankComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const code = stripComment(line);
      return code.length === line.length ? line : code + " ".repeat(line.length - code.length);
    })
    .join("\n");
}

/** Split the inside of \lean{..} on commas; offsets are relative to `base`, the offset of the first inner character. */
export function splitNames(inner: string, base = 0): LeanNameSite[] {
  const out: LeanNameSite[] = [];
  let start = 0;
  const push = (end: number) => {
    const raw = inner.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const name = raw.trim();
    if (name) out.push({ name, from: base + start + lead, to: base + start + lead + name.length });
  };
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === ",") {
      push(i);
      start = i + 1;
    }
  }
  push(inner.length);
  return out;
}

/** All \lean{..} and \leanok macros of a document, in order. */
export function findLeanSites(text: string): MacroSite[] {
  const code = blankComments(text);
  const out: MacroSite[] = [];
  const re = /\\(lean|leanok)(?![A-Za-z@])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    // \\lean is a line break followed by text, not the macro
    let bs = 0;
    for (let i = m.index - 1; i >= 0 && code[i] === "\\"; i--) bs++;
    if (bs % 2) continue;
    if (m[1] === "leanok") {
      out.push({ macro: "leanok", from: m.index, to: m.index + m[0].length, names: [] });
      continue;
    }
    const arg = /^\s*\{([^}]*)\}/.exec(code.slice(m.index + m[0].length));
    if (!arg) continue;
    const innerStart = m.index + m[0].length + arg[0].indexOf("{") + 1;
    out.push({ macro: "lean", from: m.index, to: m.index + m[0].length + arg[0].length, names: splitNames(arg[1], innerStart) });
  }
  return out;
}

/** Offset -> 1-based line and 0-based column. */
export class LineIndex {
  private starts: number[] = [0];
  constructor(private text: string) {
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.starts.push(i + 1);
  }
  get lineCount(): number {
    return this.starts.length;
  }
  locate(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.starts[lo] };
  }
  /** Offset of the first character of a 1-based line. */
  lineStart(line: number): number {
    return this.starts[Math.max(0, Math.min(line - 1, this.starts.length - 1))];
  }
  /** Offset just past the last character of a 1-based line (before its line break). */
  lineEnd(line: number): number {
    const next = this.starts[line];
    if (next === undefined) return this.text.length;
    return this.text[next - 2] === "\r" ? next - 2 : next - 1;
  }
}
