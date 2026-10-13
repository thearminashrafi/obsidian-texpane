import type { Diagnostic } from "../types";

export interface ParseLogOptions {
  /** File name to attribute errors to when the file stack is empty */
  defaultFile?: string;
  maxEntries?: number;
}

const FILE_LIKE = /(\/|\\|\.[A-Za-z0-9]{1,5}$)/;
const SKIP_PAREN_LINE = /^(!|l\.\d|LaTeX |Package |Class |Overfull|Underfull|\([A-Za-z0-9@_-]+\)|\S+:\d+:|Runaway|Missing|<|File:|Output written|Document Class|Transcript|\\)/;
const NOISE_MSG = /^\s*(Emergency stop\.?|==> Fatal error occurred.*|Fatal error occurred.*)\s*$/;
const NOISE_WARN = /^(There were (undefined references|undefined citations)\.?|Label\(s\) may have changed\. Rerun.*|Please \(re\)run .*|Rerun to get .*)$/;

function cleanFile(f: string): string {
  let s = f.trim();
  if (/^".*"$/.test(s)) s = s.slice(1, -1);
  return s.replace(/^(\.[\\/])+/, "");
}

/** Update the file stack with the parentheses on this line. */
function scanParens(line: string, stack: Array<string | null>): void {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "(") {
      let tok = "";
      let j = i + 1;
      if (line[j] === '"') {
        const e = line.indexOf('"', j + 1);
        if (e > 0) {
          tok = line.slice(j, e + 1);
          j = e + 1;
        }
      } else {
        while (j < line.length && !/[\s()]/.test(line[j])) tok += line[j++];
      }
      if (tok && FILE_LIKE.test(tok) && !/^[A-Za-z]+$/.test(tok)) stack.push(cleanFile(tok));
      else stack.push(null);
      i = j - 1;
    } else if (c === ")") {
      if (stack.length) stack.pop();
    }
  }
}

function top(stack: Array<string | null>): string | null {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i];
  return null;
}

export function parseLog(log: string, opts: ParseLogOptions = {}): Diagnostic[] {
  const max = opts.maxEntries ?? 200;
  const lines = log.split(/\r?\n/);
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const stack: Array<string | null> = [];
  const push = (d: Diagnostic) => {
    const key = `${d.severity}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push(d);
  };
  const contextFor = (from: number): { raw: string; line?: number } => {
    for (let k = from; k < Math.min(lines.length, from + 20); k++) {
      const m = /^l\.(\d+)\s?(.*)$/.exec(lines[k]);
      if (m) {
        const next = lines[k + 1] ?? "";
        return { raw: (lines[k] + (next.trim() ? "\n" + next.trim() : "")).trim(), line: Number(m[1]) };
      }
      if (k > from && (/^!/.test(lines[k]) || (/^\S+:\d+: /.test(lines[k]) && !/(Emergency stop|Fatal error)/.test(lines[k])))) break;
    }
    return { raw: "" };
  };

  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i];

    // file-line-error
    let m = /^(.+?):(\d+): (.*)$/.exec(line);
    if (m && !m[1].startsWith("[") && FILE_LIKE.test(m[1]) && !/\s{2,}/.test(m[1])) {
      const msg = m[3].trim();
      if (!NOISE_MSG.test(msg)) {
        const ctx = contextFor(i + 1);
        push({ severity: "error", file: cleanFile(m[1]), line: Number(m[2]), message: msg, raw: ctx.raw || line, source: "tex" });
      }
      continue;
    }

    // classic "! message"
    m = /^!\s*(.*)$/.exec(line);
    if (m) {
      const msg = m[1].trim();
      if (msg && !NOISE_MSG.test(msg) && !/^==>/.test(msg)) {
        const ctx = contextFor(i + 1);
        push({ severity: "error", file: top(stack) ?? opts.defaultFile ?? null, line: ctx.line, message: msg, raw: ctx.raw || line, source: "tex" });
      }
      continue;
    }

    // LaTeX / Package / Class warnings (multi-line)
    m = /^(LaTeX(?: Font)? Warning|(?:Package|Class) (\S+) Warning): ?(.*)$/.exec(line);
    if (m) {
      let text = m[3].trim();
      const pkg = m[2];
      const contRe = pkg ? new RegExp(`^\\(${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\s*(.*)$`) : m[1] === "LaTeX Font Warning" ? /^\(Font\)\s*(.*)$/ : null;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (l.trim() === "") {
          // LaTeX Warning text may continue (indented) until blank line; stop at blank.
          break;
        }
        const cm = contRe ? contRe.exec(l) : null;
        if (cm) text += " " + cm[1].trim();
        else if (!pkg && m[1] === "LaTeX Warning" && /^\s+\S/.test(l)) text += " " + l.trim();
        else break;
        j++;
      }
      i = j - 1;
      text = text.replace(/\s+/g, " ").trim();
      if (!NOISE_WARN.test(text)) {
        const lm = /on input line (\d+)/.exec(text);
        const message = pkg || m[1] === "LaTeX Font Warning" ? `${m[1] === "LaTeX Font Warning" ? "LaTeX Font Warning" : `${/^Class/.test(m[1]) ? "Class" : "Package"} ${pkg} Warning`}: ${text}` : text;
        push({ severity: "warning", file: top(stack) ?? opts.defaultFile ?? null, line: lm ? Number(lm[1]) : undefined, message, source: "tex" });
      }
      continue;
    }

    // Overfull / underfull boxes
    m = /^((?:Overfull|Underfull) \\[hv]box .*)$/.exec(line);
    if (m) {
      const lm = /(?:at lines?|detected at line) (\d+)/.exec(m[1]);
      push({ severity: "info", file: top(stack) ?? opts.defaultFile ?? null, line: lm ? Number(lm[1]) : undefined, message: m[1].trim(), source: "tex" });
      continue;
    }

    if (!SKIP_PAREN_LINE.test(line)) scanParens(line, stack);
  }
  return out;
}

function bibFileFrom(s: string): string | null {
  const m = /([^\s/\\'"]+?\.bib)(?:_[A-Za-z0-9]+\.utf8)?(?=[\s,'":)]|$)/.exec(s);
  return m ? m[1] : null;
}

/** Parse BibTeX (.blg) or Biber logs. */
export function parseBlg(blg: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = blg.split(/\r?\n/);
  const seen = new Set<string>();
  const push = (d: Diagnostic) => {
    const key = `${d.severity}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(key) || out.length >= 200) return;
    seen.add(key);
    out.push(d);
  };
  const isBiber = lines.some((l) => /^\[\d+\] \S+> (INFO|WARN|ERROR) - /.test(l));
  if (isBiber) {
    for (const l of lines) {
      const m = /^\[\d+\] \S+> (WARN|ERROR) - (.*)$/.exec(l);
      if (!m) continue;
      const msg = m[2].trim();
      const lm = /\bline (\d+)\b/.exec(msg);
      push({ severity: m[1] === "ERROR" ? "error" : "warning", file: bibFileFrom(msg), line: lm ? Number(lm[1]) : undefined, message: msg, source: "biber" });
    }
    return out;
  }
  let db: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = /^Database file #\d+: (.+)$/.exec(l);
    if (m) {
      db ??= m[1].trim();
      continue;
    }
    m = /^(.*?)---line (\d+) of file (.+)$/.exec(l);
    if (m) {
      push({ severity: "error", file: m[3].trim(), line: Number(m[2]), message: m[1].trim(), source: "bibtex" });
      continue;
    }
    m = /^Warning--(.*)$/.exec(l);
    if (m) {
      push({ severity: "warning", file: db, message: m[1].trim(), source: "bibtex" });
      continue;
    }
    m = /^(I couldn't open (?:database|style) file .*)$/.exec(l);
    if (m) {
      const fm = /file (\S+)/.exec(m[1]);
      push({ severity: "error", file: fm ? fm[1] : null, message: m[1].trim(), source: "bibtex" });
      continue;
    }
    m = /^(I found no .*)---while reading file (.+)$/.exec(l);
    if (m) push({ severity: "error", file: null, message: `${m[1].trim()} (${m[2].trim()})`, source: "bibtex" });
  }
  return out;
}
