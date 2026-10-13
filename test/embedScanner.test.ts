import { describe, it, expect } from "vitest";
import { scanEmbeds, substituteEmbeds, parseEmbedTarget } from "../src/core/embedScanner";

describe("parseEmbedTarget", () => {
  it("splits note / heading / block", () => {
    expect(parseEmbedTarget("Note")).toEqual({ note: "Note" });
    expect(parseEmbedTarget("Folder/Note#Some Heading")).toEqual({ note: "Folder/Note", heading: "Some Heading" });
    expect(parseEmbedTarget("Note#^abc-12")).toEqual({ note: "Note", blockId: "abc-12" });
    expect(parseEmbedTarget("  Note  ")).toEqual({ note: "Note" });
    expect(parseEmbedTarget("Note.md")).toEqual({ note: "Note.md" });
  });
});

describe("scanEmbeds", () => {
  it("finds simple and optioned macros with lines", () => {
    const t = "a\n\\obsidian{Lit review}\nb \\obsidian[level=subsection, title=true]{Folder/Note#Intro} c\n";
    const r = scanEmbeds(t);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ line: 2, endLine: 2, target: "Lit review", note: "Lit review", options: {} });
    expect(t.slice(r[0].start, r[0].end)).toBe("\\obsidian{Lit review}");
    expect(r[1]).toMatchObject({ line: 3, note: "Folder/Note", heading: "Intro", options: { level: "subsection", title: "true" } });
  });
  it("ignores comments, escaped percent, other macros with the same prefix, and verbatim-ish code", () => {
    const t = "% \\obsidian{no}\n\\obsidianfoo{no}\n100\\% \\obsidian{yes}\n\\obsidiannote{no}\n\\obsidian {spaced}\n";
    const r = scanEmbeds(t);
    expect(r.map((x) => x.target)).toEqual(["yes", "spaced"]);
  });
  it("multi-line macro keeps endLine", () => {
    const t = "x \\obsidian[level=section]{Multi\n  Line}\ny";
    const r = scanEmbeds(t);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ line: 1, endLine: 2, target: "Multi Line" });
  });
  it("block id and heading with special characters", () => {
    const r = scanEmbeds("\\obsidian{N#A (b), c: d}\\obsidian{N#^id}");
    expect(r[0].heading).toBe("A (b), c: d");
    expect(r[1].blockId).toBe("id");
  });
  it("skips an escaped \\\\obsidian, verbatim environments and \\verb", () => {
    const t = "a\\\\obsidian{no1} \\\\\\obsidian{yes1}\n\\begin{verbatim}\n\\obsidian{no2}\n\\end{verbatim}\n\\begin{lstlisting}x \\obsidian{no3}\\end{lstlisting} \\verb|\\obsidian{no4}| \\verb*+\\obsidian{no5}+ \\obsidian{yes2}\n% \\begin{verbatim}\n\\obsidian{yes3}";
    expect(scanEmbeds(t).map((x) => x.target)).toEqual(["yes1", "yes2", "yes3"]);
  });
  it("returns [] for no embeds", () => { expect(scanEmbeds("\\documentclass{article}")).toEqual([]); });
});

describe("substituteEmbeds", () => {
  it("replaces on the same line, preserving line count and surrounding text", () => {
    const t = "a\nfoo \\obsidian{A} bar \\obsidian[level=subsection]{B}\nz\n";
    const out = substituteEmbeds(t, (ref, i) => `\\input{emb${i}}`);
    expect(out).toBe("a\nfoo \\input{emb0} bar \\input{emb1}\nz\n");
    expect(out.split("\n").length).toBe(t.split("\n").length);
  });
  it("multi-line macro: appends newlines so following text stays on its original line", () => {
    const t = "L1 \\obsidian{Multi\n  Line} tail\nL3";
    const out = substituteEmbeds(t, () => "\\input{x}");
    expect(out).toBe("L1 \\input{x}\n tail\nL3");
    expect(out.split("\n").length).toBe(t.split("\n").length);
    expect(out.split("\n")[2]).toBe("L3");
  });
  it("null from the replacer keeps the original text", () => {
    expect(substituteEmbeds("a \\obsidian{X} b", () => null)).toBe("a \\obsidian{X} b");
  });
  it("replacement containing newlines is the caller's problem but does not corrupt offsets of later refs", () => {
    const out = substituteEmbeds("\\obsidian{A}\\obsidian{B}", (r) => (r.note === "A" ? "<<A>>" : "<<B>>"));
    expect(out).toBe("<<A>><<B>>");
  });
});

describe("documentClassEnd", () => {
  it("handles options over several lines with comments, and comments before the class name", async () => {
    const { documentClassEnd } = await import("../src/core/buildPipeline");
    const t = "% \\documentclass{x}\n\\documentclass[a,\n% b]\n c]% note\n{article}\nX";
    expect(t.slice(0, documentClassEnd(t))).toBe("% \\documentclass{x}\n\\documentclass[a,\n% b]\n c]% note\n{article}");
    expect(documentClassEnd("\\documentclass{article}%c\n")).toBe(23);
    expect(documentClassEnd("\\begin{document}")).toBe(-1);
  });
});
