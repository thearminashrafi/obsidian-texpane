/**
 * Blueprint (leanblueprint-style) parser. Pure. TASK: docs/tasks in the LeanPane repo (11-blueprint-parser.md).
 */
import { stripComment } from "./indexers";

export interface BlueprintNode {
  label: string;
  /** theorem | lemma | proposition | corollary | definition */
  env: string;
  title?: string;
  file: string;
  /** 1-based line of \begin{env} */
  line: number;
  /** 1-based line of \end{env} */
  endLine: number;
  lean: string[];
  leanok: boolean;
  mathlibok: boolean;
  notready: boolean;
  /** \uses inside the statement */
  uses: string[];
  /** \uses inside the attached proof */
  proofUses: string[];
  proofLeanok: boolean;
  proofLine?: number;
  proofEndLine?: number;
}
export interface BlueprintSource {
  file: string;
  text: string;
}

const STATEMENT_ENVS = ["theorem", "lemma", "proposition", "corollary", "definition"];
const LEANOK_RE = /\\leanok(?![A-Za-z])/;
const MATHLIBOK_RE = /\\mathlibok(?![A-Za-z])/;
const NOTREADY_RE = /\\notready(?![A-Za-z])/;
const LABEL_RE = /\\label\s*\{([^}]*)\}/;
const LEAN_RE = /\\lean\s*\{([^}]*)\}/g;
const USES_RE = /\\uses\s*\{([^}]*)\}/g;
const PROVES_RE = /\\proves\s*\{([^}]*)\}/;

/** One \begin..\end pair (end is undefined when the environment is never closed). */
interface Span {
  name: string;
  begin: number;
  headerEnd: number;
  end?: number;
}

interface Layout {
  /** All sources, comment-stripped, joined by newlines into one document. */
  doc: string;
  /** Offset in `doc` of each global line. */
  lineStart: number[];
  /** 1-based line number within the line's own file. */
  localLine: number[];
  /** Index into the sources of each global line. */
  fileOf: number[];
  /** Per source: its last 1-based line. */
  lastLine: number[];
}

function buildLayout(sources: BlueprintSource[]): Layout {
  const parts: string[] = [];
  const lineStart: number[] = [];
  const localLine: number[] = [];
  const fileOf: number[] = [];
  const lastLine: number[] = [];
  let offset = 0;
  sources.forEach((src, f) => {
    const lines = src.text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    lastLine.push(lines.length);
    lines.forEach((raw, i) => {
      const text = stripComment(raw);
      lineStart.push(offset);
      localLine.push(i + 1);
      fileOf.push(f);
      parts.push(text);
      offset += text.length + 1;
    });
  });
  return { doc: parts.join("\n"), lineStart, localLine, fileOf, lastLine };
}

/** Index of the global line containing `offset` (binary search). */
function lineIndex(lineStart: number[], offset: number): number {
  let lo = 0;
  let hi = lineStart.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStart[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Scan every \begin / \end once and pair them by name, nesting-aware. */
function findSpans(doc: string): Span[] {
  const spans: Span[] = [];
  const stack: Span[] = [];
  const re = /\\(begin|end)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc))) {
    const name = m[2].trim();
    if (m[1] === "begin") {
      stack.push({ name, begin: m.index, headerEnd: m.index + m[0].length });
      continue;
    }
    let k = stack.length - 1;
    while (k >= 0 && stack[k].name !== name) k--;
    if (k < 0) continue;
    // Close the matching environment and any inner ones it implicitly ends.
    for (let j = stack.length - 1; j >= k; j--) {
      stack[j].end = m.index;
      spans.push(stack[j]);
    }
    stack.length = k;
  }
  spans.push(...stack);
  spans.sort((a, b) => a.begin - b.begin);
  return spans;
}

/** Optional [Title] immediately after \begin{env} (whitespace allowed). */
function parseTitle(doc: string, from: number, to: number): { title?: string; bodyStart: number } {
  let i = from;
  while (i < to && /\s/.test(doc[i])) i++;
  if (i >= to || doc[i] !== "[") return { bodyStart: from };
  let depth = 0;
  for (let j = i; j < to; j++) {
    const c = doc[j];
    if (c === "\\") {
      j++;
    } else if (c === "[" || c === "{") {
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
      if (c === "]" && depth === 0) {
        const title = doc.slice(i + 1, j).trim();
        return { title: title || undefined, bodyStart: j + 1 };
      }
    }
  }
  return { bodyStart: from };
}

/** Text of [from, to) with the given (sorted) ranges blanked out. */
function bodyText(doc: string, from: number, to: number, masks: Array<[number, number]>): string {
  let out = "";
  let cur = from;
  for (const [a, b] of masks) {
    if (a > cur) out += doc.slice(cur, a);
    cur = Math.max(cur, b);
  }
  if (cur < to) out += doc.slice(cur, to);
  return out;
}

/** All comma-separated names of one macro, trimmed, de-duplicated, in order. */
function names(text: string, re: RegExp): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) {
    for (const part of m[1].split(",")) {
      const n = part.trim();
      if (n) seen.add(n);
    }
  }
  return [...seen];
}

function addUnique(target: string[], items: string[]): void {
  for (const item of items) if (!target.includes(item)) target.push(item);
}

/** Parse the sources (in document order) into blueprint statement nodes, in order of appearance. */
export function parseBlueprint(sources: BlueprintSource[], opts?: { extraEnvs?: string[] }): BlueprintNode[] {
  if (sources.length === 0) return [];
  const layout = buildLayout(sources);
  const { doc, lineStart, localLine, fileOf, lastLine } = layout;
  const envs = new Set([...STATEMENT_ENVS, ...(opts?.extraEnvs ?? [])]);
  const relevant = findSpans(doc).filter((s) => envs.has(s.name) || s.name === "proof");

  const nodes: BlueprintNode[] = [];
  const byLabel = new Map<string, BlueprintNode>();
  // Most recent statement; null when it had no label (it then produces no node).
  let last: BlueprintNode | null = null;

  for (let i = 0; i < relevant.length; i++) {
    const s = relevant[i];
    const bodyEnd = s.end ?? doc.length;
    const startIdx = lineIndex(lineStart, s.begin);
    const fileIdx = fileOf[startIdx];
    const line = localLine[startIdx];
    const endLine = s.end !== undefined ? localLine[lineIndex(lineStart, s.end)] : lastLine[fileIdx];

    // Nested statements and proofs are masked out of this body: their macros belong to them.
    const masks: Array<[number, number]> = [];
    for (let j = i + 1; j < relevant.length && relevant[j].begin < bodyEnd; j++) {
      const inner = relevant[j];
      masks.push([inner.begin, Math.min(inner.end ?? doc.length, bodyEnd)]);
    }

    if (s.name === "proof") {
      const text = bodyText(doc, s.headerEnd, bodyEnd, masks);
      const provesLabel = PROVES_RE.exec(text)?.[1].trim();
      const target = provesLabel !== undefined ? byLabel.get(provesLabel) : last;
      if (!target) continue;
      addUnique(target.proofUses, names(text, USES_RE));
      if (LEANOK_RE.test(text)) target.proofLeanok = true;
      if (target.proofLine === undefined) {
        target.proofLine = line;
        target.proofEndLine = endLine;
      }
      continue;
    }

    const { title, bodyStart } = parseTitle(doc, s.headerEnd, bodyEnd);
    const text = bodyText(doc, bodyStart, bodyEnd, masks);
    const label = LABEL_RE.exec(text)?.[1].trim() ?? "";
    if (!label) {
      last = null;
      continue;
    }
    const node: BlueprintNode = {
      label,
      env: s.name,
      file: sources[fileIdx].file,
      line,
      endLine,
      lean: names(text, LEAN_RE),
      leanok: LEANOK_RE.test(text),
      mathlibok: MATHLIBOK_RE.test(text),
      notready: NOTREADY_RE.test(text),
      uses: names(text, USES_RE),
      proofUses: [],
      proofLeanok: false,
    };
    if (title !== undefined) node.title = title;
    nodes.push(node);
    if (!byLabel.has(label)) byLabel.set(label, node);
    last = node;
  }
  return nodes;
}

/** Lean name -> nodes mentioning it, in document order. */
export function nodesByLeanName(nodes: BlueprintNode[]): Map<string, BlueprintNode[]> {
  const map = new Map<string, BlueprintNode[]>();
  for (const node of nodes) {
    for (const name of node.lean) {
      const list = map.get(name);
      if (list) list.push(node);
      else map.set(name, [node]);
    }
  }
  return map;
}
