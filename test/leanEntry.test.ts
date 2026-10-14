import { describe, it, expect } from "vitest";
import { blueprintEntryChange } from "../src/core/blueprintEntry";
import { applyChanges } from "../src/core/blueprintModel";
import { parseBlueprint } from "../src/core/blueprint";
import { collectBlueprintSources } from "../src/core/blueprintSources";
import { BlueprintStore } from "../src/integration/blueprintStore";

const req = { env: "lemma", label: "lem:x", leanName: "Foo.x", statement: "For all $n$,\n$n \\le n$." };
const add = (t: string) => {
  const { change, line } = blueprintEntryChange(t, req);
  return { text: applyChanges(t, [change]), line };
};

describe("addBlueprintEntry text", () => {
  it("inserts before \\end{document}, and parses back as a node at the reported line", () => {
    const t = "\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n";
    const { text, line } = add(t);
    const [n] = parseBlueprint([{ file: "f", text }]);
    expect(n).toMatchObject({ label: "lem:x", env: "lemma", lean: ["Foo.x"], line });
    expect(text.endsWith("\\end{document}\n")).toBe(true);
    expect(text.split("\n")[line - 1]).toBe("\\begin{lemma}");
    expect(text).toContain("  $n \\le n$.");
  });
  it("appends to a file without \\end{document} (with or without final newline) and to an empty file", () => {
    for (const t of ["\\section{A}\n", "\\section{A}", "", "a\nb\n\n"]) {
      const { text, line } = add(t);
      const [n] = parseBlueprint([{ file: "f", text }]);
      expect(n.line).toBe(line);
      expect(n.label).toBe("lem:x");
      expect(text.startsWith(t.trimEnd() ? t.trimEnd().slice(0, 3) : "\\begin")).toBe(true);
    }
  });
  it("uses CRLF when the file does", () => {
    const { text } = add("\\section{A}\r\n");
    expect(text).not.toMatch(/[^\r]\n/);
  });
  it("falls back to theorem for a strange environment name", () => {
    const { text } = add("");
    expect(blueprintEntryChange(text, { ...req, env: "x}\\evil" }).change.insert).toContain("\\begin{theorem}");
  });
});

describe("collectBlueprintSources", () => {
  const files: Record<string, string> = {
    "bp/main.tex": "\\input{chapters/one}\n\\include{two}\n\\input{chapters/one}\n\\input{../../escape}",
    "bp/chapters/one.tex": "\\input{sub/deep}",
    "bp/chapters/sub/deep.tex": "deep",
    "bp/two.tex": "two",
    "../escape.tex": "no",
  };
  const read = async (p: string) => files[p] ?? null;
  it("walks \\input / \\include depth first, each file once, inside the vault only", async () => {
    const got = await collectBlueprintSources("bp/main.tex", read);
    expect(got.map((s) => s.file)).toEqual(["bp/main.tex", "bp/chapters/one.tex", "bp/chapters/sub/deep.tex", "bp/two.tex"]);
  });
  it("missing files are skipped, a missing root gives nothing", async () => {
    expect(await collectBlueprintSources("nope.tex", read)).toEqual([]);
  });
});

describe("BlueprintStore", () => {
  it("parses once per root until invalidated, and tells listeners", async () => {
    let reads = 0;
    let text = "\\begin{lemma}\\label{a}\\lean{A}\\end{lemma}";
    const store = new BlueprintStore(async () => (reads++, text));
    const a = await store.get("m.tex");
    await store.get("m.tex");
    expect(reads).toBe(1);
    expect(a.nodes.map((n) => n.label)).toEqual(["a"]);
    let heard = 0;
    store.onChange(() => heard++);
    text = "\\begin{lemma}\\label{b}\\end{lemma}";
    store.invalidate();
    expect(heard).toBe(1);
    expect((await store.get("m.tex")).nodes.map((n) => n.label)).toEqual(["b"]);
    store.dispose();
  });
});
