import { describe, expect, it } from "vitest";
import { nodesByLeanName, parseBlueprint } from "../src/core/blueprint";

const one = (text: string, file = "content.tex") => parseBlueprint([{ file, text }]);

describe("parseBlueprint: statements", () => {
  it("parses a lemma with label, title, lean names, uses, line numbers", () => {
    const nodes = one(
      [
        "\\section{Basics}", // 1
        "", // 2
        "\\begin{lemma}[Bound]", // 3
        "  \\label{lem:bound}", // 4
        "  \\lean{Foo.bound, Foo.bound_aux}", // 5
        "  \\uses{def:x, lem:y}", // 6
        "  For all $n$, $n \\le n$.", // 7
        "\\end{lemma}", // 8
      ].join("\n"),
    );
    expect(nodes.length).toBe(1);
    expect(nodes[0]).toMatchObject({
      label: "lem:bound",
      env: "lemma",
      title: "Bound",
      file: "content.tex",
      line: 3,
      endLine: 8,
      lean: ["Foo.bound", "Foo.bound_aux"],
      leanok: false,
      mathlibok: false,
      notready: false,
      uses: ["def:x", "lem:y"],
      proofUses: [],
      proofLeanok: false,
    });
  });

  it("recognises theorem lemma proposition corollary definition (and only those by default)", () => {
    const text = ["theorem", "lemma", "proposition", "corollary", "definition"].map((e, i) => `\\begin{${e}}\\label{l${i}}\\end{${e}}`).join("\n") + "\n\\begin{remark}\\label{r}\\end{remark}\n\\begin{equation}\\label{eq:1}x\\end{equation}\n";
    expect(one(text).map((n) => n.env)).toEqual(["theorem", "lemma", "proposition", "corollary", "definition"]);
  });

  it("flags: \\leanok, \\mathlibok, \\notready belong to the statement when inside it", () => {
    const [n] = one("\\begin{definition}\\label{def:a}\\lean{A}\\leanok\\mathlibok\\notready\\end{definition}");
    expect(n).toMatchObject({ leanok: true, mathlibok: true, notready: true, proofLeanok: false });
  });

  it("multi-line macro arguments and odd spacing", () => {
    const [n] = one("\\begin{theorem}\n\\label{thm:x}\n\\lean{ A.b ,\n   C.d,\n   «E f» }\n\\uses{ a,\n b }\n\\end{theorem}");
    expect(n.lean).toEqual(["A.b", "C.d", "«E f»"]);
    expect(n.uses).toEqual(["a", "b"]);
  });

  it("ignores comments (including commented-out macros) but not escaped percent signs", () => {
    const [n] = one("\\begin{lemma}\\label{lem:c} % \\lean{Wrong}\n\\lean{Right} % \\leanok\n50\\% of \\uses{u1} % \\uses{u2}\n\\end{lemma}");
    expect(n.lean).toEqual(["Right"]);
    expect(n.leanok).toBe(false);
    expect(n.uses).toEqual(["u1"]);
  });

  it("a statement without a label is skipped; duplicate macros accumulate without duplicates", () => {
    const nodes = one("\\begin{lemma}\\lean{X}\\end{lemma}\n\\begin{lemma}\\label{a}\\lean{X}\\lean{X, Y}\\uses{p}\\uses{p,q}\\end{lemma}");
    expect(nodes.length).toBe(1);
    expect(nodes[0].lean).toEqual(["X", "Y"]);
    expect(nodes[0].uses).toEqual(["p", "q"]);
  });

  it("starred environments are not blueprint nodes; nested environments inside a statement are fine", () => {
    const nodes = one("\\begin{lemma*}\\label{s}\\end{lemma*}\n\\begin{lemma}\\label{n}\n\\begin{itemize}\\item a\\end{itemize}\n\\lean{N}\n\\end{lemma}");
    expect(nodes.map((n) => n.label)).toEqual(["n"]);
    expect(nodes[0].lean).toEqual(["N"]);
    expect(nodes[0].endLine).toBe(5);
  });
});

describe("parseBlueprint: proofs", () => {
  const src = [
    "\\begin{lemma}\\label{lem:a}\\lean{A}\\end{lemma}", // 1
    "\\begin{proof}", // 2
    "  \\leanok", // 3
    "  \\uses{lem:b, def:c}", // 4
    "  Easy.", // 5
    "\\end{proof}", // 6
  ].join("\n");

  it("a proof attaches to the previous statement: proofUses and proofLeanok", () => {
    const [n] = one(src);
    expect(n.leanok).toBe(false);
    expect(n.proofLeanok).toBe(true);
    expect(n.proofUses).toEqual(["lem:b", "def:c"]);
    expect(n.uses).toEqual([]);
    expect(n).toMatchObject({ proofLine: 2, proofEndLine: 6 });
  });

  it("\\proves{label} attaches to that label instead of the previous statement", () => {
    const nodes = one("\\begin{lemma}\\label{a}\\end{lemma}\n\\begin{lemma}\\label{b}\\end{lemma}\n\\begin{proof}\\proves{a}\\leanok\\uses{b}\\end{proof}");
    expect(nodes[0]).toMatchObject({ label: "a", proofLeanok: true, proofUses: ["b"] });
    expect(nodes[1]).toMatchObject({ label: "b", proofLeanok: false, proofUses: [] });
  });

  it("proofs attach across files in order, and files are kept per node", () => {
    const nodes = parseBlueprint([
      { file: "a.tex", text: "\\begin{lemma}\\label{x}\\end{lemma}\n" },
      { file: "b.tex", text: "\\begin{proof}\\leanok\\end{proof}\n\\begin{lemma}\\label{y}\\end{lemma}\n" },
    ]);
    expect(nodes.map((n) => [n.label, n.file, n.proofLeanok])).toEqual([["x", "a.tex", true], ["y", "b.tex", false]]);
  });

  it("a proof with no preceding statement is ignored; proofs of other envs do not attach to earlier lemmas", () => {
    expect(one("\\begin{proof}\\leanok\\end{proof}")).toEqual([]);
    const [n] = one("\\begin{lemma}\\label{a}\\end{lemma}\n\\begin{remark}x\\end{remark}\n\\begin{proof}\\leanok\\end{proof}");
    expect(n.proofLeanok).toBe(true); // remarks do not detach the proof from the previous statement
  });

  it("the macros inside a proof do not leak into the statement and vice versa", () => {
    const [n] = one("\\begin{lemma}\\label{a}\\uses{s}\\leanok\\end{lemma}\n\\begin{proof}\\uses{p}\\end{proof}");
    expect(n).toMatchObject({ uses: ["s"], proofUses: ["p"], leanok: true, proofLeanok: false });
  });
});

describe("nodesByLeanName", () => {
  it("indexes every Lean name to the nodes that mention it", () => {
    const nodes = one("\\begin{lemma}\\label{a}\\lean{X, Y}\\end{lemma}\n\\begin{lemma}\\label{b}\\lean{Y}\\end{lemma}");
    const m = nodesByLeanName(nodes);
    expect(m.get("X")!.map((n) => n.label)).toEqual(["a"]);
    expect(m.get("Y")!.map((n) => n.label)).toEqual(["a", "b"]);
    expect(m.has("Z")).toBe(false);
  });
});

describe("robustness", () => {
  it("empty and macro-free input", () => {
    expect(parseBlueprint([])).toEqual([]);
    expect(one("Just text.\n\\section{x}\n")).toEqual([]);
  });
  it("unterminated environment at EOF does not throw and still yields the node", () => {
    const nodes = one("\\begin{lemma}\\label{a}\\lean{X}\n");
    expect(nodes.length).toBe(1);
    expect(nodes[0].lean).toEqual(["X"]);
  });
  it("CRLF line endings keep correct line numbers", () => {
    const [n] = one("a\r\nb\r\n\\begin{lemma}\\label{a}\r\n\\end{lemma}\r\n");
    expect(n.line).toBe(3);
    expect(n.endLine).toBe(4);
  });
});
