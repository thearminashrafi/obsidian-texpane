import { describe, it, expect } from "vitest";
import { serializeMarkdown } from "../src/core/md2latex/serialize";
import { makeWikilink, makeEmbed, HL_OPEN, HL_CLOSE } from "../src/core/md2latex/sentinels";
import type { ConvertOptions, SerializeContext, WikiTarget } from "../src/types";

function mk(over: Partial<ConvertOptions> = {}, hooks: Partial<SerializeContext> = {}) {
  const warnings: string[] = [];
  const embeds: Array<{ t: WikiTarget; levelIndex: number; line: number }> = [];
  const options: ConvertOptions = { level: "section", title: false, noteTitle: "My Note", wikilinkFootnote: false, highlightEmph: true, amssymbLoaded: false, listingsLoaded: false, ...over };
  const ctx: SerializeContext = {
    options,
    embedNote: (t, c) => { embeds.push({ t, levelIndex: c.levelIndex, line: c.line }); return t.note === "Missing" ? null : `\\input{emb-${t.note}}`; },
    resolveImage: (ref) => (ref.includes("nope") ? null : "img-" + ref.replace(/[^A-Za-z0-9.]/g, "_")),
    warn: (m) => warnings.push(m),
    ...hooks,
  };
  return { ctx, warnings, embeds };
}
const ser = (md: string, over: Partial<ConvertOptions> = {}) => { const m = mk(over); return { r: serializeMarkdown(md, m.ctx), ...m }; };

describe("headings", () => {
  it("maps relative to level; top heading becomes the level; deeper follow", () => {
    expect(ser("# A\n\n## B\n\n### C\n").r.latex).toBe("\\section{A}\n\n\\subsection{B}\n\n\\subsubsection{C}\n");
    expect(ser("## A\n\n### B\n", { level: "subsection" }).r.latex).toBe("\\subsection{A}\n\n\\subsubsection{B}\n");
    const deep = ser("# a\n## b\n### c\n#### d\n##### e\n###### f\n", { level: "subsubsection" }).r.latex;
    expect(deep).toContain("\\subsubsection{a}");
    expect(deep).toContain("\\paragraph{b}");
    expect(deep).toContain("\\subparagraph{c}");
    expect(deep).toContain("\\subparagraph{f}"); // clamps
  });
  it("title option emits the note name first and nests the note's headings one level deeper", () => {
    const l = ser("# Intro\n\ntext\n", { title: true, noteTitle: "Lit & review" }).r.latex;
    expect(l.startsWith("\\section{Lit \\& review}\n")).toBe(true);
    expect(l).toContain("\\subsection{Intro}");
  });
  it("inline formatting in headings", () => { expect(ser("# A **b** `c`\n").r.latex).toContain("\\section{A \\textbf{b} \\texttt{c}}"); });
});

describe("inline", () => {
  it("emphasis, strong, strike, code, highlight", () => {
    const l = ser("**b** *i* _j_ ~~s~~ `c_d` plain\n").r.latex;
    expect(l).toContain("\\textbf{b}");
    expect(l).toContain("\\emph{i}");
    expect(l).toContain("\\emph{j}");
    expect(l).toContain(" s ");
    expect(l).not.toContain("~~");
    expect(l).toContain("\\texttt{c\\_d}");
    const h = serializeMarkdown(`a ${HL_OPEN}hi${HL_CLOSE} b\n`, mk().ctx).latex;
    expect(h).toContain("\\emph{hi}");
    const h2 = serializeMarkdown(`a ${HL_OPEN}hi${HL_CLOSE} b\n`, mk({ highlightEmph: false }).ctx).latex;
    expect(h2).toContain("a hi b");
    expect(h2).not.toContain("emph");
  });
  it("escapes special characters", () => {
    const l = ser("a & b % c $ d # e _ f { g } h ~ i ^ j \\ k < l > m | n\n").r.latex;
    for (const s of ["\\&", "\\%", "\\$", "\\#", "\\_", "\\{", "\\}", "\\textasciitilde{}", "\\textasciicircum{}", "\\textbackslash{}", "\\textless{}", "\\textgreater{}", "\\textbar{}"]) expect(l, s).toContain(s);
  });
  it("math passes through raw", () => {
    const l = ser("inline $a_1 + b^2 & c$ and\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nsingle-line $$x_1$$ here\n").r.latex;
    expect(l).toContain("$a_1 + b^2 & c$");
    expect(l).toContain("\\[\n\\int_0^1 x\\,dx\n\\]");
    expect(l).toContain("\\[x_1\\]");
  });
  it("math env inside $$ is passed raw without \\[ \\]", () => {
    const l = ser("$$\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n$$\n").r.latex;
    expect(l).toContain("\\begin{align}");
    expect(l).not.toContain("\\[");
    const l2 = ser("$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$\n").r.latex;
    expect(l2).toContain("\\[");
  });
  it("links and bare URLs", () => {
    const m = ser("[text _x_](https://a.b/c?d=1&e=2#f) and https://example.com/p_q now\n");
    expect(m.r.latex).toContain("\\href{https://a.b/c?d=1\\&e=2\\#f}{text \\emph{x}}");
    expect(m.r.latex).toContain("\\url{https://example.com/p_q}");
    expect(m.r.usesLinks).toBe(true);
    expect(ser("no links").r.usesLinks).toBe(false);
  });
  it("soft breaks become newlines, hard breaks \\\\", () => {
    expect(ser("line one\nline two\n").r.latex).toBe("line one\nline two\n");
    expect(ser("a  \nb\n").r.latex).toContain("a\\\\\nb");
  });
  it("wikilinks render display text; footnote mode appends footnote", () => {
    const md = `see ${makeWikilink("Note")} and ${makeWikilink("Folder/Note#Head", "alias")} and ${makeWikilink("N2#Sec")}\n`;
    const l = ser(md).r.latex;
    expect(l).toContain("see Note and alias and N2 \\textgreater{} Sec");
    const f = serializeMarkdown(md, mk({ wikilinkFootnote: true }).ctx).latex;
    expect(f).toContain("Note\\footnote{Note}");
  });
  it("footnotes", () => {
    const l = ser("Claim[^1] more.\n\n[^1]: The *source* text.\n").r.latex;
    expect(l).toContain("Claim\\footnote{The \\emph{source} text.} more.");
    expect(l).not.toContain("[^1]");
  });
});

describe("blocks", () => {
  it("lists: bullets, ordered, nested, tasks", () => {
    const l = ser("- a\n- b\n  1. x\n  2. y\n- c\n").r.latex;
    expect(l).toContain("\\begin{itemize}");
    expect(l).toContain("\\item a");
    expect(l).toContain("\\begin{enumerate}");
    expect(l).toContain("\\item x");
    expect((l.match(/\\end\{itemize\}/g) ?? []).length).toBe(1);
    expect(l.indexOf("\\item x")).toBeGreaterThan(l.indexOf("\\item b"));
    expect(l.indexOf("\\item c")).toBeGreaterThan(l.indexOf("\\end{enumerate}"));
  });
  it("task lists with and without amssymb", () => {
    const md = "- [ ] todo\n- [x] done\n";
    const a = ser(md).r.latex;
    expect(a).toContain("\\item[{[ ]}] todo");
    expect(a).toContain("\\item[{[x]}] done");
    const b = ser(md, { amssymbLoaded: true }).r.latex;
    expect(b).toContain("\\item[$\\square$] todo");
    expect(b).toContain("\\item[$\\checkmark$] done");
  });
  it("GFM table with alignment and hline under header", () => {
    const l = ser("| Name | Qty | Note |\n|:-----|----:|:----:|\n| a & b | 1 | **x** |\n| c | 2 | y |\n").r.latex;
    expect(l).toContain("\\begin{tabular}{lrc}");
    expect(l).toMatch(/Name & Qty & Note \\\\\s*\n\\hline/);
    expect(l).toContain("a \\& b & 1 & \\textbf{x} \\\\");
    expect(l).toContain("\\end{tabular}");
  });
  it("code blocks: verbatim, lstlisting when listings loaded, unsupported fences", () => {
    expect(ser("```py\nprint('x') # $\n```\n").r.latex).toContain("\\begin{verbatim}\nprint('x') # $\n\\end{verbatim}");
    expect(ser("```py\nx\n```\n", { listingsLoaded: true }).r.latex).toContain("\\begin{lstlisting}");
    const d = ser("```dataview\nTABLE x\n```\n");
    expect(d.r.latex).toContain("\\texttt{[unsupported: dataview");
    expect(d.r.warnings.length).toBe(1);
    expect(d.r.latex).not.toContain("verbatim");
  });
  it("quotes and callouts", () => {
    expect(ser("> quoted *text*\n").r.latex).toContain("\\begin{quote}\nquoted \\emph{text}\n\\end{quote}");
    const c = ser("> [!note] My Title\n> body line\n").r.latex;
    expect(c).toContain("\\begin{quote}");
    expect(c).toContain("\\textbf{My Title}");
    expect(c).toContain("body line");
    expect(c).not.toContain("[!note]");
    const d = ser("> [!warning]-\n> careful\n").r.latex;
    expect(d).toContain("\\textbf{Warning}");
  });
  it("thematic break and html", () => {
    expect(ser("a\n\n---\n\nb\n").r.latex).toContain("\\rule{\\linewidth}{0.4pt}");
    const h = ser("<div class=x>hi</div>\n");
    expect(h.r.latex).toContain("\\texttt{[unsupported: html]}");
    expect(h.r.warnings).toHaveLength(1);
    expect(ser("<!-- comment -->\n\ntext\n").r.latex.trim()).toBe("text");
  });
});

describe("images and embeds", () => {
  it("markdown and wiki images become figures; sizes", () => {
    const a = ser("![alt](<pics/a b.png>)\n");
    expect(a.r.latex).toContain("\\begin{figure}[h]\n\\centering\n\\includegraphics[width=\\linewidth]{img-pics_a_b.png}\n\\end{figure}");
    expect(a.r.usesGraphics).toBe(true);
    const b = serializeMarkdown(`${makeEmbed("photo.png", "300")}\n`, mk().ctx);
    expect(b.latex).toContain("\\includegraphics[width=300bp]{img-photo.png}");
    const c = serializeMarkdown(`${makeEmbed("photo.png", "300x200")}\n`, mk().ctx);
    expect(c.latex).toContain("width=300bp,height=200bp");
  });
  it("missing image yields marker + warning", () => {
    const m = ser("![x](nope.png)\n");
    expect(m.r.latex).toContain("\\texttt{[missing image:");
    expect(m.r.warnings).toHaveLength(1);
    expect(m.r.usesGraphics).toBe(false);
  });
  it("note embeds call embedNote with the current level index; unresolved -> marker", () => {
    const m = mk();
    const md = `${makeEmbed("Before")}\n\n# Top\n\n## Sub\n\n${makeEmbed("Nested#Head")}\n\n${makeEmbed("Missing")}\n`;
    const r = serializeMarkdown(md, m.ctx);
    expect(r.latex).toContain("\\input{emb-Before}");
    expect(r.latex).toContain("\\input{emb-Nested}");
    expect(m.embeds[0].levelIndex).toBe(1); // section
    expect(m.embeds[1]).toMatchObject({ t: { note: "Nested", heading: "Head" }, levelIndex: 3 }); // after \subsection -> subsubsection
    expect(r.latex).toContain("[unresolved embed: Missing]");
    expect(m.warnings.length).toBe(1);
    expect(r.warnings.length).toBe(1);
  });
  it("pdf/audio/video embeds are unsupported markers", () => {
    const m = serializeMarkdown(`${makeEmbed("doc.pdf")}\n\n${makeEmbed("clip.mp4")}\n`, mk().ctx);
    expect(m.latex).toContain("[unsupported: doc.pdf]");
    expect(m.latex).toContain("[unsupported: clip.mp4]");
    expect(m.warnings).toHaveLength(2);
  });
});

describe("lineMap", () => {
  it("one entry per output line, pointing at note lines", () => {
    const md = "# Title\n\nPara one\ncontinues here\n\n- item a\n- item b\n\n```\ncode\n```\n";
    const r = ser(md).r;
    const lines = r.latex.split("\n");
    expect(r.lineMap).toHaveLength(lines.length);
    const at = (needle: string) => r.lineMap[lines.findIndex((x) => x.includes(needle))];
    expect(at("\\section{Title}")).toBe(1);
    expect(at("Para one")).toBe(3);
    expect(at("continues here")).toBe(4);
    expect(at("item a")).toBe(6);
    expect(at("item b")).toBe(7);
    expect(at("code")).toBe(10);
  });
  it("empty input", () => {
    const r = ser("").r;
    expect(r.latex.trim()).toBe("");
    expect(r.lineMap).toHaveLength(r.latex.split("\n").length);
  });
});
