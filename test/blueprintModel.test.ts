import { describe, it, expect } from "vitest";
import type { DeclState, DeclStatus } from "../src/integration/api-types";
import { parseBlueprint, type BlueprintSource } from "../src/core/blueprint";
import {
  applyEdits,
  buildGraph,
  detectMismatches,
  editsToChanges,
  filterGraph,
  graphEdges,
  nodeStatus,
  progress,
  statementText,
  visualOf,
  type StatusMap,
} from "../src/core/blueprintModel";
import { findLeanSites, splitNames } from "../src/core/leanMacros";
import { isValidLeanName, leanNameFromLabel, parseLeanMagic, resolveVaultRelative } from "../src/core/leanProject";

const st = (name: string, state: DeclState): DeclStatus => ({ name, state, source: "live", updatedAt: 0 });
const statuses = (o: Record<string, DeclState>): StatusMap => new Map(Object.entries(o).map(([k, v]) => [k, st(k, v)]));

const FILE = "bp/content.tex";
const SRC = (text: string): BlueprintSource[] => [{ file: FILE, text }];

describe("visual status mapping (leanblueprint semantics)", () => {
  it("maps every Lean state", () => {
    expect(visualOf("proved")).toBe("proved");
    expect(visualOf("mathlib")).toBe("mathlib");
    expect(visualOf("proved-with-sorry-deps")).toBe("sorry-deps");
    expect(visualOf("stated")).toBe("stated");
    expect(visualOf("error")).toBe("error");
    expect(visualOf("missing")).toBe("missing");
    expect(visualOf("unknown")).toBe("unknown");
    expect(visualOf(undefined)).toBe("unknown");
  });
  it("node status: worst of its names; none without \\lean; mathlibok", () => {
    const n = (lean: string[], mathlibok = false) => ({ lean, mathlibok });
    expect(nodeStatus(n([]), statuses({}))).toBe("none");
    expect(nodeStatus(n([], true), statuses({}))).toBe("mathlib");
    expect(nodeStatus(n(["a"]), statuses({ a: "proved" }))).toBe("proved");
    expect(nodeStatus(n(["a", "b"]), statuses({ a: "proved", b: "stated" }))).toBe("stated");
    expect(nodeStatus(n(["a", "b"]), statuses({ a: "proved-with-sorry-deps", b: "proved" }))).toBe("sorry-deps");
    expect(nodeStatus(n(["a", "b"]), statuses({ a: "error", b: "missing" }))).toBe("error");
    expect(nodeStatus(n(["a", "b"]), statuses({ a: "proved", b: "missing" }))).toBe("missing");
    expect(nodeStatus(n(["a", "b"]), statuses({ a: "mathlib", b: "mathlib" }))).toBe("mathlib");
    expect(nodeStatus(n(["a", "b"]), statuses({ a: "mathlib", b: "proved" }))).toBe("proved");
    expect(nodeStatus(n(["a"]), statuses({}))).toBe("unknown");
  });
});

const GRAPH_TEX = [
  "\\begin{definition}\\label{def:a}\\lean{A}\\end{definition}",
  "\\begin{lemma}\\label{lem:b}\\lean{B}\\uses{def:a}\\end{lemma}\\begin{proof}\\uses{nope}\\end{proof}",
  "\\begin{lemma}\\label{lem:c}\\lean{C}\\uses{def:a}\\end{lemma}",
  "\\begin{theorem}\\label{thm:d}\\lean{D}\\end{theorem}\\begin{proof}\\uses{lem:b, lem:c, thm:d}\\end{proof}",
  "\\begin{theorem}\\label{thm:e}\\end{theorem}\\begin{proof}\\uses{thm:d}\\end{proof}",
  "\\begin{proposition}\\label{prop:f}\\mathlibok\\end{proposition}",
].join("\n");

describe("dependency graph, filters, progress", () => {
  const nodes = parseBlueprint(SRC(GRAPH_TEX));
  const g = buildGraph(nodes, statuses({ A: "proved", B: "proved", C: "stated", D: "missing" }));
  const by = (id: string) => g.find((n) => n.id === id)!;

  it("builds nodes with statuses and existing dependencies only (proof \\uses included, self and unknown dropped)", () => {
    expect(g.map((n) => n.id)).toEqual(["def:a", "lem:b", "lem:c", "thm:d", "thm:e", "prop:f"]);
    expect(by("lem:b").deps).toEqual(["def:a"]);
    expect(by("thm:d").deps).toEqual(["lem:b", "lem:c"]);
    expect(by("thm:e").deps).toEqual(["thm:d"]);
    expect(by("def:a").status).toBe("proved");
    expect(by("lem:c").status).toBe("stated");
    expect(by("thm:d").status).toBe("missing");
    expect(by("thm:e").status).toBe("none");
    expect(by("prop:f").status).toBe("mathlib");
    expect(graphEdges(g)).toContainEqual(["lem:c", "thm:d"]);
  });
  it("ready = not done and all dependencies done; blocked = not done and some dependency not done", () => {
    expect(by("def:a")).toMatchObject({ done: true, ready: false, blocked: false });
    expect(by("lem:c")).toMatchObject({ done: false, ready: true, blocked: false });
    expect(by("thm:d")).toMatchObject({ ready: false, blocked: true }); // lem:c is not proved
    expect(by("thm:e")).toMatchObject({ ready: false, blocked: true });
    expect(by("prop:f")).toMatchObject({ done: true });
  });
  it("filters", () => {
    expect(filterGraph(g, "all").length).toBe(6);
    expect(filterGraph(g, "ready").map((n) => n.id)).toEqual(["lem:c"]);
    expect(filterGraph(g, "blocked").map((n) => n.id)).toEqual(["thm:d", "thm:e"]);
    expect(filterGraph(g, "unformalized").map((n) => n.id)).toEqual(["thm:d", "thm:e"]); // missing in Lean + no \lean
  });
  it("progress text and counts", () => {
    const p = progress(g);
    expect(p.text).toBe("3 of 6 proved");
    expect(p).toMatchObject({ total: 6, done: 3 });
    expect(p.counts).toMatchObject({ proved: 2, mathlib: 1, stated: 1, missing: 1, none: 1 });
  });
  it("a dependency cycle does not hang and nothing in it is ready", () => {
    const cyc = buildGraph(parseBlueprint(SRC("\\begin{lemma}\\label{x}\\lean{X}\\uses{y}\\end{lemma}\\begin{lemma}\\label{y}\\lean{Y}\\uses{x}\\end{lemma}")), statuses({ X: "stated", Y: "stated" }));
    expect(cyc.every((n) => n.blocked)).toBe(true);
  });
});

describe("\\lean macro sites", () => {
  it("splitNames keeps offsets", () => {
    expect(splitNames(" A.b ,C, ", 10)).toEqual([
      { name: "A.b", from: 11, to: 14 },
      { name: "C", from: 16, to: 17 },
    ]);
  });
  it("finds \\lean and \\leanok, skipping comments, \\\\lean and \\leanokay", () => {
    const t = "\\lean{A, B} % \\lean{No}\n\\\\lean{x} \\leanok \\leanokay\n\\lean{\n C}";
    const s = findLeanSites(t);
    expect(s.map((x) => x.macro)).toEqual(["lean", "leanok", "lean"]);
    expect(s[0].names.map((n) => n.name)).toEqual(["A", "B"]);
    expect(s[2].names.map((n) => n.name)).toEqual(["C"]);
    expect(t.slice(s[1].from, s[1].to)).toBe("\\leanok");
  });
});

const MISMATCH_TEX = [
  "\\begin{definition}", // 1
  "  \\label{def:a}", // 2
  "  \\lean{A}", // 3
  "\\end{definition}", // 4
  "\\begin{lemma}", // 5
  "  \\label{lem:b} \\lean{B}", // 6
  "\\end{lemma}", // 7
  "\\begin{proof}", // 8
  "  \\leanok", // 9
  "  Easy.", // 10
  "\\end{proof}", // 11
  "\\begin{lemma}", // 12
  "  \\label{lem:c}", // 13
  "  \\lean{C1, C2}", // 14
  "\\end{lemma}", // 15
  "\\begin{proof}", // 16
  "  Hard.", // 17
  "\\end{proof}", // 18
  "\\begin{lemma}\\label{lem:d}\\lean{D}\\end{lemma}", // 19
  "\\begin{proof}\\leanok text\\end{proof}", // 20
  "\\begin{theorem}\\label{thm:e}\\lean{E}\\leanok\\end{theorem}", // 21 (no proof environment)
].join("\n");

describe("mismatch detection", () => {
  const nodes = parseBlueprint(SRC(MISMATCH_TEX));
  const run = (o: Record<string, DeclState>) => detectMismatches(nodes, statuses(o), SRC(MISMATCH_TEX));

  it("nothing to report when blueprint and Lean agree", () => {
    expect(run({ A: "stated", B: "proved", C1: "stated", C2: "stated", D: "proved", E: "stated" })).toEqual([]);
  });

  it("\\leanok in the proof, but Lean says not proved: warns at the \\leanok, fix removes it", () => {
    const m = run({ A: "stated", B: "stated", C1: "stated", C2: "stated", D: "stated", E: "stated" });
    const b = m.find((x) => x.kind === "leanok-not-proved" && x.label === "lem:b")!;
    expect(b).toMatchObject({ file: FILE, line: 9, col: 2, endCol: 9, auto: true });
    expect(b.message).toContain("B");
    expect(b.fix!.edits).toEqual([{ file: FILE, line: 9, op: "remove-token", token: "\\leanok" }]);
    expect(applyEdits(MISMATCH_TEX, b.fix!.edits).split("\n").slice(7, 10)).toEqual(["\\begin{proof}", "  Easy.", "\\end{proof}"]);
    // lem:d too (inline \leanok)
    const d = m.find((x) => x.label === "lem:d" && x.kind === "leanok-not-proved")!;
    expect(applyEdits(MISMATCH_TEX, d.fix!.edits).split("\n")[19]).toBe("\\begin{proof}text\\end{proof}");
  });
  it("an error is reported but never auto-removed; unknown and missing are not leanok mismatches", () => {
    const err = run({ B: "error" }).find((x) => x.label === "lem:b" && x.kind === "leanok-not-proved")!;
    expect(err.auto).toBe(false);
    expect(run({ B: "unknown" }).some((x) => x.label === "lem:b")).toBe(false);
    const missing = run({ B: "missing" }).filter((x) => x.label === "lem:b");
    expect(missing.map((x) => x.kind)).toEqual(["lean-missing"]);
  });

  it("proved in Lean but no \\leanok: fix inserts it in the proof, indented", () => {
    const m = run({ C1: "proved", C2: "proved" }).find((x) => x.kind === "proved-no-leanok" && x.label === "lem:c")!;
    expect(m.line).toBe(16);
    expect(m.message).toContain("C1, C2");
    expect(m.fix!.edits).toEqual([{ file: FILE, line: 16, op: "insert-after", text: "  \\leanok" }]);
    expect(applyEdits(MISMATCH_TEX, m.fix!.edits).split("\n").slice(15, 19)).toEqual(["\\begin{proof}", "  \\leanok", "  Hard.", "\\end{proof}"]);
  });
  it("one of several names not proved: the node is not proved", () => {
    expect(run({ C1: "proved", C2: "stated" }).some((x) => x.label === "lem:c")).toBe(false);
  });
  it("mathlib declarations get no \\leanok suggestion; definitions use the statement's \\leanok", () => {
    expect(run({ C1: "mathlib", C2: "mathlib" }).some((x) => x.label === "lem:c")).toBe(false);
    const a = run({ A: "proved" }).find((x) => x.label === "def:a")!;
    expect(a.kind).toBe("proved-no-leanok");
    expect(a.fix!.edits).toEqual([{ file: FILE, line: 2, op: "insert-after", text: "  \\leanok" }]);
    expect(applyEdits(MISMATCH_TEX, a.fix!.edits).split("\n").slice(0, 4)).toEqual(["\\begin{definition}", "  \\label{def:a}", "  \\leanok", "  \\lean{A}"]);
  });
  it("a theorem without proof environment makes no claim", () => {
    expect(run({ E: "stated" }).some((x) => x.label === "thm:e")).toBe(false);
    expect(run({ E: "proved" }).some((x) => x.label === "thm:e")).toBe(false);
  });
  it("\\lean{X} missing in Lean: points at the name inside the macro", () => {
    const m = run({ C1: "proved", C2: "missing" }).find((x) => x.kind === "lean-missing")!;
    expect(m).toMatchObject({ label: "lem:c", name: "C2", line: 14, col: 12, endCol: 14 });
    expect(m.message).toContain("C2");
    expect(m.fix).toBeUndefined();
  });
  it("without any status nothing is reported", () => {
    expect(run({})).toEqual([]);
  });
});

describe("edits", () => {
  it("keeps CRLF line endings and handles the last line", () => {
    const t = "a\r\n  \\leanok\r\nb";
    expect(applyEdits(t, [{ file: "f", line: 2, op: "remove-token", token: "\\leanok" }])).toBe("a\r\nb");
    expect(applyEdits("a\r\nb", [{ file: "f", line: 1, op: "insert-after", text: "X" }])).toBe("a\r\nX\r\nb");
    expect(applyEdits("a\n  \\leanok", [{ file: "f", line: 2, op: "remove-token", token: "\\leanok" }])).toBe("a");
  });
  it("removes only the token and one neighbouring space; ignores comments", () => {
    expect(applyEdits("x \\leanok y", [{ file: "f", line: 1, op: "remove-token", token: "\\leanok" }])).toBe("x y");
    expect(applyEdits("% \\leanok\nz", [{ file: "f", line: 1, op: "remove-token", token: "\\leanok" }])).toBe("% \\leanok\nz");
  });
  it("several edits at once (descending application keeps offsets right)", () => {
    const t = "p\n\\leanok\nq\nr";
    const out = applyEdits(t, [
      { file: "f", line: 2, op: "remove-token", token: "\\leanok" },
      { file: "f", line: 3, op: "insert-after", text: "\\leanok" },
    ]);
    expect(out).toBe("p\nq\n\\leanok\nr");
    expect(editsToChanges(t, [{ file: "f", line: 99, op: "insert-after", text: "no" }])).toEqual([]);
  });
});

describe("statement text for the docstring", () => {
  it("drops bookkeeping macros, comments and the environment markers", () => {
    const tex = "\\begin{lemma}[Bound]\n  \\label{lem:bound}\n  \\lean{X} \\leanok\n  \\uses{a, b}\n  For all $n$, % hidden\n  $n \\le n$. -/ end\n\\end{lemma}\n";
    const [n] = parseBlueprint(SRC(tex));
    expect(statementText(SRC(tex), n)).toBe("Bound\n\nFor all $n$,\n$n \\le n$. - / end");
  });
});

describe("Lean names and projects", () => {
  it("name from label", () => {
    expect(leanNameFromLabel("lem:bound")).toBe("lem_bound");
    expect(leanNameFromLabel("thm:main-result.v2")).toBe("thm_main_result_v2");
    expect(leanNameFromLabel("1", "lemma")).toBe("lemma_1");
    expect(leanNameFromLabel("theorem")).toBe("theorem_");
    expect(leanNameFromLabel("::", "definition")).toBe("definition");
    expect(leanNameFromLabel("a  b")).toBe("a_b");
    expect(isValidLeanName("Foo.bar_baz'")).toBe(true);
    expect(isValidLeanName("1abc")).toBe(false);
    expect(isValidLeanName("a b")).toBe(false);
    expect(isValidLeanName("")).toBe(false);
  });
  it("% !LEAN project magic comment", () => {
    expect(parseLeanMagic("% !LEAN project = ../lean/Proj\n\\documentclass{article}")).toEqual({ project: "../lean/Proj" });
    expect(parseLeanMagic("%!lean project=\"My Proj\"")).toEqual({ project: "My Proj" });
    expect(parseLeanMagic("\\documentclass{article}")).toEqual({});
    expect(parseLeanMagic("% !TEX root = main.tex")).toEqual({});
  });
  it("relative to the vault", () => {
    expect(resolveVaultRelative("Proj/blueprint/src/print.tex", "../../")).toBe("Proj");
    expect(resolveVaultRelative("Proj/blueprint/src/print.tex", "../../Lean")).toBe("Proj/Lean");
    expect(resolveVaultRelative("print.tex", "Lean")).toBe("Lean");
    expect(resolveVaultRelative("a/print.tex", "../..")).toBeNull();
    expect(resolveVaultRelative("a/print.tex", "..")).toBe("");
  });
});
