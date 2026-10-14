/**
 * Blueprint x Lean: status of blueprint nodes, dependency graph, progress, filters and the
 * \leanok mismatch checks with their quick-fix edits. Pure; Lean statuses come in as plain data.
 */
import type { DeclState, DeclStatus } from "../integration/api-types";
import type { BlueprintNode, BlueprintSource } from "./blueprint";
import { LineIndex, findLeanSites } from "./leanMacros";
import { stripComment } from "./indexers";

export type StatusMap = ReadonlyMap<string, DeclStatus>;

/** How a declaration or a blueprint node is drawn (leanblueprint semantics, see styles.css for the colours). */
export type VisualStatus = "proved" | "mathlib" | "sorry-deps" | "stated" | "error" | "missing" | "unknown" | "none";

export const VISUAL_STATUSES: readonly VisualStatus[] = ["proved", "mathlib", "sorry-deps", "stated", "error", "missing", "unknown", "none"];

export const STATUS_LABEL: Record<VisualStatus, string> = {
  proved: "Proved",
  mathlib: "In Mathlib",
  "sorry-deps": "Proved, but depends on sorry",
  stated: "Stated (proof is sorry)",
  error: "Lean reports an error",
  missing: "Not found in Lean",
  unknown: "Status unknown",
  none: "Not formalized",
};

export function visualOf(state: DeclState | undefined): VisualStatus {
  switch (state) {
    case "proved":
      return "proved";
    case "mathlib":
      return "mathlib";
    case "proved-with-sorry-deps":
      return "sorry-deps";
    case "stated":
      return "stated";
    case "error":
      return "error";
    case "missing":
      return "missing";
    default:
      return "unknown";
  }
}

export const isDone = (v: VisualStatus): boolean => v === "proved" || v === "mathlib";

/** Worst first. */
const SEVERITY: VisualStatus[] = ["error", "missing", "stated", "sorry-deps", "unknown"];

/** Status of a node from the Lean status of everything its \lean{..} names. */
export function nodeStatus(node: Pick<BlueprintNode, "lean" | "mathlibok">, statuses: StatusMap): VisualStatus {
  if (node.lean.length === 0) return node.mathlibok ? "mathlib" : "none";
  const each = node.lean.map((n) => visualOf(statuses.get(n)?.state));
  for (const s of SEVERITY) if (each.includes(s)) return s;
  return each.every((s) => s === "mathlib") ? "mathlib" : "proved";
}

// ------------------------------------------------------------------ graph

export interface GraphNode {
  id: string;
  node: BlueprintNode;
  status: VisualStatus;
  /** Labels this node depends on (statement and proof \uses), existing nodes only, no self reference */
  deps: string[];
  done: boolean;
  /** Not done, and every dependency is done */
  ready: boolean;
  /** Not done, and some dependency is not done */
  blocked: boolean;
}

export function buildGraph(nodes: readonly BlueprintNode[], statuses: StatusMap): GraphNode[] {
  const byLabel = new Map<string, BlueprintNode>();
  for (const n of nodes) if (!byLabel.has(n.label)) byLabel.set(n.label, n);
  const status = new Map<string, VisualStatus>();
  for (const [label, n] of byLabel) status.set(label, nodeStatus(n, statuses));
  const out: GraphNode[] = [];
  for (const [label, n] of byLabel) {
    const deps = [...new Set([...n.uses, ...n.proofUses])].filter((d) => d !== label && byLabel.has(d));
    const st = status.get(label)!;
    const done = isDone(st);
    const depsDone = deps.every((d) => isDone(status.get(d)!));
    out.push({ id: label, node: n, status: st, deps, done, ready: !done && depsDone, blocked: !done && !depsDone });
  }
  return out;
}

/** Edges prerequisite -> dependent. */
export function graphEdges(g: readonly GraphNode[]): Array<[string, string]> {
  return g.flatMap((n) => n.deps.map((d): [string, string] => [d, n.id]));
}

export type GraphFilter = "all" | "ready" | "blocked" | "unformalized";
export const FILTER_LABEL: Record<GraphFilter, string> = { all: "All", ready: "Ready to prove", blocked: "Blocked", unformalized: "Not formalized" };

export function matchesFilter(n: GraphNode, f: GraphFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "ready":
      return n.ready;
    case "blocked":
      return n.blocked;
    case "unformalized":
      return n.status === "none" || n.status === "missing";
  }
}
export function filterGraph(g: readonly GraphNode[], f: GraphFilter): GraphNode[] {
  return g.filter((n) => matchesFilter(n, f));
}

export interface Progress {
  total: number;
  done: number;
  counts: Record<VisualStatus, number>;
  text: string;
}
export function progress(g: readonly GraphNode[]): Progress {
  const counts = Object.fromEntries(VISUAL_STATUSES.map((s) => [s, 0])) as Record<VisualStatus, number>;
  let done = 0;
  for (const n of g) {
    counts[n.status]++;
    if (n.done) done++;
  }
  return { total: g.length, done, counts, text: `${done} of ${g.length} proved` };
}

// ------------------------------------------------------------------ edits

/** One edit, addressed by file and 1-based line (so it can be applied to an open editor or to the file on disk). */
export type TextEdit =
  | { file: string; line: number; op: "insert-after"; text: string; expect?: string }
  | { file: string; line: number; op: "remove-token"; token: string; expect?: string };

/** Anchor for an edit: the code part (comment stripped, trimmed) of the line it was computed for. */
export const anchorOf = (line: string | undefined): string => stripComment(line ?? "").trim();

/** Does the line still look like the one the edit was computed for? Edits without `expect` are not checked. */
function lineMatches(e: TextEdit, lineText: string): boolean {
  return e.expect === undefined || anchorOf(lineText) === e.expect;
}

export interface ChangeSpec {
  from: number;
  to: number;
  insert: string;
}

/** Minimal text changes for the edits that belong to this text (edits of other files are ignored by the caller). */
export function editsToChanges(text: string, edits: readonly TextEdit[]): ChangeSpec[] {
  const idx = new LineIndex(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out: ChangeSpec[] = [];
  for (const e of edits) {
    if (e.line < 1 || e.line > idx.lineCount) continue;
    const start = idx.lineStart(e.line);
    const end = idx.lineEnd(e.line);
    // the text moved or was edited since the edit was computed: skip it, the next round computes it again
    if (!lineMatches(e, text.slice(start, end))) continue;
    if (e.op === "insert-after") {
      out.push({ from: end, to: end, insert: eol + e.text });
      continue;
    }
    const line = text.slice(start, end);
    const code = stripComment(line);
    const re = new RegExp(e.token.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") + "(?![A-Za-z@])");
    const m = re.exec(code);
    if (!m) continue;
    let a = start + m.index;
    let b = a + m[0].length;
    if (text[a - 1] === " " || text[a - 1] === "\t") a--;
    else if (text[b] === " " || text[b] === "\t") b++;
    const rest = text.slice(start, a) + text.slice(b, end);
    if (rest.trim() === "") {
      // nothing else on the line: remove the line including its break
      const lastLine = e.line === idx.lineCount;
      if (lastLine) out.push({ from: Math.max(0, start - (start > 0 ? eol.length : 0)), to: end, insert: "" });
      else out.push({ from: start, to: idx.lineStart(e.line + 1), insert: "" });
    } else out.push({ from: a, to: b, insert: "" });
  }
  return out;
}

/** Apply changes (computed against the same text) to a string. */
export function applyChanges(text: string, changes: readonly ChangeSpec[]): string {
  const sorted = [...changes].sort((x, y) => y.from - x.from || y.to - x.to);
  let out = text;
  for (const c of sorted) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  return applyChanges(text, editsToChanges(text, edits));
}

// ------------------------------------------------------------------ mismatches

export type MismatchKind = "leanok-not-proved" | "proved-no-leanok" | "lean-missing";

export interface Mismatch {
  kind: MismatchKind;
  label: string;
  file: string;
  /** 1-based line and 0-based column range to underline */
  line: number;
  col: number;
  endCol: number;
  message: string;
  /** Lean name involved */
  name?: string;
  /** Fix labelled for the quick-fix menu; absent when there is nothing sensible to edit */
  fix?: { label: string; edits: TextEdit[] };
  /** The "Sync \leanok automatically" setting may apply the fix without asking */
  auto: boolean;
}

const rangeOf = (n: BlueprintNode, part: "statement" | "proof"): [number, number] | null =>
  part === "statement" ? [n.line, n.endLine] : n.proofLine !== undefined ? [n.proofLine, n.proofEndLine ?? n.proofLine] : null;

/**
 * Does the blueprint claim this node is formalized? Definitions: \leanok in the statement. Theorems and friends:
 * \leanok in the proof. null when there is no proof environment, so the blueprint makes no claim about the proof.
 */
export function claimsProved(n: BlueprintNode): boolean | null {
  if (n.env === "definition") return n.leanok;
  if (n.proofLine === undefined) return null;
  return n.proofLeanok;
}

/** Compare \leanok with what Lean says. Nodes without statuses (Lean has not answered yet) produce nothing. */
export function detectMismatches(nodes: readonly BlueprintNode[], statuses: StatusMap, sources: readonly BlueprintSource[]): Mismatch[] {
  const text = new Map(sources.map((s) => [s.file, s.text]));
  const sites = new Map<string, { idx: LineIndex; sites: ReturnType<typeof findLeanSites> }>();
  const sitesOf = (file: string) => {
    let s = sites.get(file);
    if (!s) {
      const t = text.get(file) ?? "";
      s = { idx: new LineIndex(t), sites: findLeanSites(t) };
      sites.set(file, s);
    }
    return s;
  };
  const lines = new Map<string, string[]>();
  const linesOf = (file: string) => {
    let l = lines.get(file);
    if (!l) lines.set(file, (l = (text.get(file) ?? "").split(/\r?\n/)));
    return l;
  };

  const out: Mismatch[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.label)) continue;
    seen.add(n.label);
    if (n.lean.length === 0) continue;
    const st = nodeStatus(n, statuses);
    const { idx, sites: all } = sitesOf(n.file);

    // \lean{X} missing in Lean
    for (const name of n.lean) {
      if (statuses.get(name)?.state !== "missing") continue;
      let at = { line: n.line, col: 0, endCol: 0 };
      for (const s of all) {
        const hit = s.names.find((x) => x.name === name);
        if (s.macro !== "lean" || !hit) continue;
        const p = idx.locate(hit.from);
        if (p.line < n.line || p.line > n.endLine) continue;
        at = { line: p.line, col: p.col, endCol: p.col + (hit.to - hit.from) };
        break;
      }
      out.push({ kind: "lean-missing", label: n.label, file: n.file, ...at, name, message: `\\lean{${name}}: Lean has no declaration with this name`, auto: false });
    }

    const claim = claimsProved(n);
    if (claim === null || st === "missing" || st === "unknown") continue;
    const part = n.env === "definition" ? "statement" : "proof";
    const range = rangeOf(n, part)!;
    const noun = n.env === "definition" ? "definition" : "proof";

    if (claim && !isDone(st)) {
      // \leanok, but Lean disagrees
      const site = all.find((s) => {
        if (s.macro !== "leanok") return false;
        const p = idx.locate(s.from).line;
        return p >= range[0] && p <= range[1];
      });
      const p = site ? idx.locate(site.from) : { line: range[0], col: 0 };
      const names = n.lean.join(", ");
      out.push({
        kind: "leanok-not-proved",
        label: n.label,
        file: n.file,
        line: p.line,
        col: p.col,
        endCol: site ? p.col + (site.to - site.from) : p.col,
        name: names,
        message: `\\leanok, but Lean says ${names} is not proved yet (${STATUS_LABEL[st].toLowerCase()})`,
        fix: site ? { label: "Remove \\leanok", edits: [{ file: n.file, line: p.line, op: "remove-token", token: "\\leanok", expect: anchorOf(linesOf(n.file)[p.line - 1]) }] } : undefined,
        auto: st === "stated" || st === "sorry-deps",
      });
    } else if (!claim && st === "proved") {
      // proved in Lean, but the blueprint does not say so
      const anchor = part === "proof" ? range[0] : labelLine(linesOf(n.file), n) ?? n.line;
      const indent = /^\s*/.exec(linesOf(n.file)[anchor - 1] ?? "")![0] + (part === "proof" ? "  " : "");
      out.push({
        kind: "proved-no-leanok",
        label: n.label,
        file: n.file,
        line: range[0],
        col: 0,
        endCol: 0,
        name: n.lean.join(", "),
        message: `Lean proves ${n.lean.join(", ")}, but the ${noun} has no \\leanok`,
        fix: { label: "Add \\leanok", edits: [{ file: n.file, line: anchor, op: "insert-after", text: `${indent}\\leanok`, expect: anchorOf(linesOf(n.file)[anchor - 1]) }] },
        auto: true,
      });
    }
  }
  return out;
}

/** 1-based line of \label{..} of a node, or null. */
export function labelLine(fileLines: readonly string[], n: Pick<BlueprintNode, "label" | "line" | "endLine">): number | null {
  for (let i = n.line; i <= Math.min(n.endLine, fileLines.length); i++) {
    const code = stripComment(fileLines[i - 1] ?? "");
    const m = /\\label\s*\{([^}]*)\}/.exec(code);
    if (m && m[1].trim() === n.label) return i;
  }
  return null;
}

// ------------------------------------------------------------------ statement text

const MACROS_WITH_ARG = /\\(?:label|lean|uses|discussion|proves)\s*\{[^}]*\}/g;
const MACROS_BARE = /\\(?:leanok|mathlibok|notready)(?![A-Za-z@])/g;

/** Plain LaTeX body of a statement without the blueprint bookkeeping macros, for the Lean docstring. */
export function statementText(sources: readonly BlueprintSource[], n: BlueprintNode): string {
  const src = sources.find((s) => s.file === n.file);
  if (!src) return "";
  const lines = src.text.split(/\r?\n/).slice(n.line - 1, n.endLine);
  const code = lines.map(stripComment).join("\n");
  let body = code.replace(new RegExp(`^\\s*\\\\begin\\{${n.env}\\}`), "").replace(new RegExp(`\\\\end\\{${n.env}\\}\\s*$`), "");
  body = body.replace(/^\s*\[[^\]]*\]/, "");
  body = body.replace(MACROS_WITH_ARG, "").replace(MACROS_BARE, "");
  body = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n")
    .trim();
  const head = n.title ? `${n.title}\n\n` : "";
  return (head + body).replace(/-\//g, "- /");
}
