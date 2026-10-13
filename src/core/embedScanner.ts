import type { EmbedRef } from "../types";

export function parseEmbedTarget(target: string): { note: string; heading?: string; blockId?: string } {
  const t = target.trim();
  const i = t.indexOf("#");
  if (i < 0) return { note: t };
  const note = t.slice(0, i).trim();
  const rest = t.slice(i + 1).trim();
  if (rest.startsWith("^")) return { note, blockId: rest.slice(1).trim() };
  return rest ? { note, heading: rest } : { note };
}

function parseOptions(s: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const part of s.split(",")) {
    const m = /^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(part);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

const VERBATIM_ENVS = /^\\begin\{(verbatim\*?|Verbatim\*?|BVerbatim|LVerbatim|lstlisting|minted|comment|filecontents\*?)\}/;

/** Offsets where a macro must not be recognised: TeX comments, verbatim environments, \verb, and a backslash escaped by another one. */
function commentMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  let inComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") inComment = false;
    else if (!inComment && c === "\\") {
      const env = VERBATIM_ENVS.exec(text.slice(i, i + 40));
      const verb = /^\\verb\*?([^A-Za-z*\s])/.exec(text.slice(i, i + 8));
      let end = -1;
      if (env) {
        const close = text.indexOf(`\\end{${env[1]}}`, i + env[0].length);
        end = close < 0 ? text.length : close;
      } else if (verb) {
        const close = text.indexOf(verb[1], i + verb[0].length);
        const eol = text.indexOf("\n", i);
        end = close < 0 || (eol >= 0 && close > eol) ? (eol < 0 ? text.length : eol) : close + 1;
      }
      if (end > i) {
        mask.fill(true, i + 1, end);
        i = end - 1;
        continue;
      }
      if (i + 1 < text.length) mask[i + 1] = true;
      i++;
      continue;
    } else if (!inComment && c === "%") inComment = true;
    if (inComment) mask[i] = true;
  }
  return mask;
}

export function scanEmbeds(content: string): EmbedRef[] {
  const out: EmbedRef[] = [];
  if (!content.includes("\\obsidian")) return out;
  const mask = commentMask(content);
  const re = /\\obsidian(?![A-Za-z@])\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (mask[m.index]) continue;
    const start = m.index;
    const end = start + m[0].length;
    const target = m[2].replace(/\s+/g, " ").trim();
    const p = parseEmbedTarget(target);
    const line = content.slice(0, start).split("\n").length;
    const endLine = line + (m[0].match(/\n/g)?.length ?? 0);
    out.push({ start, end, line, endLine, raw: m[0], target, note: p.note, heading: p.heading, blockId: p.blockId, options: m[1] ? parseOptions(m[1]) : {} });
  }
  return out;
}

/**
 * Replace each embed using `replacer(ref, index)`; null keeps the original text.
 * Multi-line macros get as many newlines appended as they spanned, so following text keeps its line number.
 */
export function substituteEmbeds(content: string, replacer: (ref: EmbedRef, index: number) => string | null): string {
  const refs = scanEmbeds(content);
  let out = "";
  let last = 0;
  refs.forEach((r, i) => {
    out += content.slice(last, r.start);
    const rep = replacer(r, i);
    if (rep === null) out += r.raw;
    else out += rep + "\n".repeat(r.endLine - r.line);
    last = r.end;
  });
  return out + content.slice(last);
}
