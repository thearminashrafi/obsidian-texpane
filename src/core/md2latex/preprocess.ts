import { HL_CLOSE, HL_OPEN, makeEmbed, makeWikilink } from "./sentinels";

function newlines(s: string): string {
  return s.replace(/[^\n]/g, "");
}

/**
 * Normalise Obsidian-only syntax into private-use sentinels / removals.
 * Strictly line-preserving: the number of "\n" never changes.
 */
export function preprocessObsidian(input: string): string {
  let md = input.replace(/\r\n?/g, "\n");
  // front matter (only at the very top)
  const fm = /^---[ \t]*\n(?:[\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(md);
  if (fm) md = newlines(fm[0]) + md.slice(fm[0].length);
  return process(md, true);
}

function process(s: string, topLevel: boolean): string {
  let out = "";
  let i = 0;
  const n = s.length;
  const atLineStart = () => i === 0 || s[i - 1] === "\n";
  while (i < n) {
    const c = s[i];

    if (topLevel && atLineStart()) {
      const f = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(s.slice(i, i + 400));
      if (f) {
        const fence = f[1];
        // find closing fence line
        let j = i + f[0].length;
        let end = n;
        while (j <= n) {
          const nl = s.indexOf("\n", j);
          const lineEnd = nl < 0 ? n : nl;
          const line = s.slice(j, lineEnd);
          if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`).test(line)) {
            end = lineEnd;
            break;
          }
          if (nl < 0) break;
          j = nl + 1;
        }
        out += s.slice(i, end);
        i = end;
        continue;
      }
    }

    if (c === "\\" && i + 1 < n) {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (c === "`") {
      let k = i;
      while (s[k] === "`") k++;
      const run = s.slice(i, k);
      const close = findRun(s, k, run.length);
      if (close >= 0) {
        out += s.slice(i, close + run.length);
        i = close + run.length;
      } else {
        out += run;
        i = k;
      }
      continue;
    }

    if (c === "$") {
      if (s[i + 1] === "$") {
        const close = s.indexOf("$$", i + 2);
        if (close >= 0) {
          out += s.slice(i, close + 2);
          i = close + 2;
          continue;
        }
        out += "$$";
        i += 2;
        continue;
      }
      const eol = s.indexOf("\n", i + 1);
      const lineEnd = eol < 0 ? n : eol;
      let j = i + 1;
      let found = -1;
      while (j < lineEnd) {
        if (s[j] === "\\") j += 2;
        else if (s[j] === "$") {
          found = j;
          break;
        } else j++;
      }
      if (found > i + 1 && !/^\s/.test(s[i + 1]) && !/\s$/.test(s.slice(i + 1, found))) {
        out += s.slice(i, found + 1);
        i = found + 1;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    if (c === "%" && s[i + 1] === "%") {
      const close = s.indexOf("%%", i + 2);
      if (close >= 0) {
        out += newlines(s.slice(i, close + 2));
        i = close + 2;
        continue;
      }
    }

    if ((c === "[" && s[i + 1] === "[") || (c === "!" && s[i + 1] === "[" && s[i + 2] === "[")) {
      const embed = c === "!";
      const open = i + (embed ? 3 : 2);
      const eol = s.indexOf("\n", open);
      const lineEnd = eol < 0 ? n : eol;
      const close = s.indexOf("]]", open);
      if (close >= 0 && close < lineEnd && close > open) {
        const inner = s.slice(open, close).replace(/\\\|/g, "|");
        const bar = inner.indexOf("|");
        const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
        const extra = bar < 0 ? "" : inner.slice(bar + 1).trim();
        if (target || !embed) {
          out += embed ? makeEmbed(target, extra) : makeWikilink(target, extra);
          i = close + 2;
          continue;
        }
      }
    }

    if (c === "=" && s[i + 1] === "=" && s[i + 2] !== "=" && s[i + 2] !== " " && s[i + 2] !== "\n" && s[i + 2] !== undefined) {
      const eol = s.indexOf("\n", i + 2);
      const lineEnd = eol < 0 ? n : eol;
      const close = s.indexOf("==", i + 2);
      if (close > i + 2 && close < lineEnd && s[close - 1] !== " ") {
        out += HL_OPEN + process(s.slice(i + 2, close), false) + HL_CLOSE;
        i = close + 2;
        continue;
      }
    }

    if (c === "#" && s[i + 1] !== "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      const m = /^#([A-Za-z0-9_/-]+)/.exec(s.slice(i, i + 200));
      if (m && /[^0-9/-]/.test(m[1])) {
        i += m[0].length;
        continue;
      }
    }

    if (c === "^" && (i === 0 || /\s/.test(s[i - 1]))) {
      const eol = s.indexOf("\n", i);
      const lineEnd = eol < 0 ? n : eol;
      if (/^\^[A-Za-z0-9-]+[ \t]*$/.test(s.slice(i, lineEnd))) {
        out = out.replace(/[ \t]+$/, "");
        i = lineEnd;
        continue;
      }
    }

    out += c;
    i++;
  }
  return out;
}

function findRun(s: string, from: number, len: number): number {
  let i = from;
  while (i < s.length) {
    if (s[i] === "`") {
      let k = i;
      while (s[k] === "`") k++;
      if (k - i === len) return i;
      i = k;
    } else i++;
  }
  return -1;
}
