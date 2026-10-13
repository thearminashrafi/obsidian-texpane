import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { extractLabels, extractBibEntries, extractInputs, extractSections, extractBibResources, detectPackages, ProjectIndex, type IndexFs } from "../src/core/indexers";

describe("extractLabels", () => {
  it("finds labels with lines, ignores comments", () => {
    const t = "\\section{A}\\label{sec:a}\n% \\label{commented}\nText \\% \\label{after-escaped-percent}\n\\begin{equation}\\label{eq:1}\\end{equation}\n";
    expect(extractLabels(t, "m.tex")).toEqual([
      { label: "sec:a", file: "m.tex", line: 1 },
      { label: "after-escaped-percent", file: "m.tex", line: 3 },
      { label: "eq:1", file: "m.tex", line: 4 },
    ]);
  });
});

describe("extractBibEntries", () => {
  it("parses keys, types, titles; skips @comment/@string/@preamble", () => {
    const bib = `@string{foo = "bar"}
@comment{x}
@Article{knuth84,
  author = {Knuth},
  title = {The {TeX}book},
  year = 1984
}
@book{lamport,
  title = "LaTeX: A Document Preparation System",
}
@preamble{"\\foo"}
`;
    const e = extractBibEntries(bib, "refs.bib");
    expect(e.map((x) => x.key)).toEqual(["knuth84", "lamport"]);
    expect(e[0]).toMatchObject({ type: "article", title: "The {TeX}book", file: "refs.bib", line: 3 });
    expect(e[1].title).toBe("LaTeX: A Document Preparation System");
  });
});

describe("extractInputs / bib resources / packages", () => {
  it("collects \\input \\include \\subfile \\import, skipping comments", () => {
    const t = "\\input{a}\n% \\input{no}\n\\include{ch/b} \\subfile{c.tex}\n\\input{\"with space\"}\n";
    expect(extractInputs(t)).toEqual(["a", "ch/b", "c.tex", "with space"]);
  });
  it("bibliography resources", () => {
    expect(extractBibResources("\\bibliography{a,b/c}\n\\addbibresource{x.bib}\n% \\bibliography{no}")).toEqual(["a", "b/c", "x.bib"]);
  });
  it("detectPackages handles lists, options, comments", () => {
    const p = detectPackages("\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amsmath, amssymb}\n% \\usepackage{listings}\n\\RequirePackage{graphicx}");
    expect([...p].sort()).toEqual(["amsmath", "amssymb", "graphicx", "inputenc"]);
  });
});

describe("extractSections", () => {
  it("outline with depth, starred and line", () => {
    const t = "\\chapter{One}\n\\section*{Intro \\emph{x}}\n% \\section{no}\n\\subsection[short]{Long title}\n\\paragraph{p}\n";
    const s = extractSections(t);
    expect(s.map((x) => [x.kind, x.depth, x.title, x.line, x.starred])).toEqual([
      ["chapter", 1, "One", 1, false],
      ["section", 2, "Intro \\emph{x}", 2, true],
      ["subsection", 3, "Long title", 4, false],
      ["paragraph", 5, "p", 5, false],
    ]);
  });
});

describe("ProjectIndex", () => {
  const R = path.resolve("/proj");
  function memFs(files: Record<string, string>): IndexFs & { files: Record<string, string> } {
    const m: Record<string, string> = {};
    for (const [k, v] of Object.entries(files)) m[path.resolve(k)] = v;
    return {
      files: m,
      readFile: async (p) => m[path.resolve(p)] ?? null,
      listBibFiles: async (dir) => Object.keys(m).filter((k) => path.dirname(k) === path.resolve(dir) && k.endsWith(".bib")),
    };
  }
  it("builds from root following \\input, finds labels, bib keys (from \\bibliography), outline per file", async () => {
    const fs = memFs({
      "/proj/main.tex": "\\documentclass{article}\n\\input{ch/one}\n\\include{two.tex}\n\\bibliography{refs}\n\\label{root}",
      "/proj/ch/one.tex": "\\section{One}\\label{sec:one}",
      "/proj/two.tex": "\\section{Two}\\label{sec:two}",
      "/proj/refs.bib": "@article{k1, title={T1}}",
      "/proj/other.bib": "@article{k2, title={T2}}",
    });
    const idx = new ProjectIndex(fs);
    await idx.build(path.join(R, "main.tex"));
    expect(idx.labels().map((l) => l.label).sort()).toEqual(["root", "sec:one", "sec:two"]);
    expect(idx.bibEntries().map((b) => b.key)).toEqual(["k1"]);
    expect(idx.files().sort()).toEqual([path.join(R, "ch", "one.tex"), path.join(R, "main.tex"), path.join(R, "two.tex")].sort());
    expect(idx.outline(path.join(R, "ch", "one.tex"))[0].title).toBe("One");
  });
  it("falls back to every .bib in the root folder when none declared", async () => {
    const fs = memFs({ "/proj/main.tex": "\\documentclass{article}", "/proj/a.bib": "@book{x, title={X}}", "/proj/b.bib": "@book{y, title={Y}}" });
    const idx = new ProjectIndex(fs);
    await idx.build(path.join(R, "main.tex"));
    expect(idx.bibEntries().map((b) => b.key).sort()).toEqual(["x", "y"]);
  });
  it("update(file) re-indexes just that file (labels removed and added), tolerates cycles", async () => {
    const fs = memFs({ "/proj/main.tex": "\\input{a}", "/proj/a.tex": "\\label{one}\\input{main}" });
    const idx = new ProjectIndex(fs);
    await idx.build(path.join(R, "main.tex"));
    expect(idx.labels().map((l) => l.label)).toEqual(["one"]);
    fs.files[path.join(R, "a.tex")] = "\\label{two}\\label{three}";
    await idx.update(path.join(R, "a.tex"));
    expect(idx.labels().map((l) => l.label).sort()).toEqual(["three", "two"]);
    fs.files[path.join(R, "refs.bib")] = "@misc{z, title={Z}}";
    await idx.update(path.join(R, "refs.bib"));
    expect(idx.bibEntries().map((b) => b.key)).toContain("z");
  });
});
