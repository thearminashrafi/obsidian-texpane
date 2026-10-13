import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { math } from "micromark-extension-math";
import { mathFromMarkdown } from "mdast-util-math";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

function parse(md: string): N {
  return fromMarkdown(md, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
}

function normHeading(s: string): string {
  return s
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/[*_`~=]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function headingSource(lines: string[], node: N): string {
  const l = lines[node.position.start.line - 1] ?? "";
  return l.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\s+#+\s*$/, "");
}

export interface SelectResult {
  /** Same number of lines as the input; lines outside the selection are blanked */
  md: string;
  found: boolean;
}

function mask(lines: string[], from: number, to: number): string {
  return lines.map((l, i) => (i + 1 >= from && i + 1 <= to ? l : "")).join("\n");
}

/** Keep only a heading section (including the heading line) or a single block, blanking everything else. */
export function selectPart(md: string, sel: { heading?: string; blockId?: string }): SelectResult {
  if (!sel.heading && !sel.blockId) return { md, found: true };
  const text = md.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const tree = parse(text);
  const top: N[] = tree.children ?? [];
  if (sel.heading) {
    const want = normHeading(sel.heading.split("#").pop() ?? sel.heading);
    const idx = top.findIndex((n) => n.type === "heading" && normHeading(headingSource(lines, n)) === want);
    if (idx < 0) return { md: text, found: false };
    const h = top[idx];
    let end = lines.length;
    for (let i = idx + 1; i < top.length; i++) {
      if (top[i].type === "heading" && top[i].depth <= h.depth) {
        end = top[i].position.start.line - 1;
        break;
      }
    }
    return { md: mask(lines, h.position.start.line, end), found: true };
  }
  const id = sel.blockId!;
  const re = new RegExp(`(^|\\s)\\^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  // skip fenced code
  let inFence = false;
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{0,3}(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (!inFence && re.test(lines[i])) {
      at = i + 1;
      break;
    }
  }
  if (at < 0) return { md: text, found: false };
  const own = lines[at - 1].trim() === `^${id}`;
  let node: N | undefined;
  if (own) {
    for (const n of top) if (n.position.end.line < at) node = n;
  } else node = top.find((n) => n.position.start.line <= at && n.position.end.line >= at);
  if (!node) return { md: text, found: false };
  return { md: mask(lines, node.position.start.line, node.position.end.line), found: true };
}
