import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseLog, parseBlg } from "../src/core/logParser";
import type { Diagnostic } from "../src/types";

const dir = join(__dirname, "fixtures", "logs");
const log = (n: string) => readFileSync(join(dir, n + ".log"), "utf8");
const blg = (n: string) => readFileSync(join(dir, n + ".blg"), "utf8");
const sel = (d: Diagnostic[], s: Diagnostic["severity"]) => d.filter((x) => x.severity === s);

describe("parseLog (real fixture logs)", () => {
  it("clean log has no errors or warnings", () => {
    const d = parseLog(log("clean"));
    expect(sel(d, "error")).toEqual([]);
    expect(sel(d, "warning")).toEqual([]);
  });

  it("undefined control sequence", () => {
    const e = sel(parseLog(log("undefined-command")), "error");
    expect(e).toHaveLength(1);
    expect(e[0].file).toBe("main.tex");
    expect(e[0].line).toBe(4);
    expect(e[0].message).toContain("Undefined control sequence");
    expect(e[0].raw).toContain("l.4");
  });

  it("missing $ (two errors, no ghost warnings from (Font) lines)", () => {
    const d = parseLog(log("missing-dollar"));
    const e = sel(d, "error");
    expect(e.map((x) => [x.file, x.line])).toEqual([["main.tex", 3], ["main.tex", 4]]);
    expect(e[0].message).toContain("Missing $ inserted");
    expect(sel(d, "warning")).toEqual([]);
  });

  it("undefined reference and citation warnings, summary line dropped", () => {
    const w = sel(parseLog(log("undefined-refs")), "warning");
    expect(w).toHaveLength(2);
    expect(w[0].message).toContain("Reference `sec:nope' on page 1 undefined");
    expect(w[0].line).toBe(3);
    expect(w[0].file).toBe("main.tex");
    expect(w[1].message).toContain("Citation `ghost'");
    expect(w[1].line).toBe(3);
  });

  it("overfull hbox is info with line", () => {
    const d = parseLog(log("overfull-underfull"));
    const i = sel(d, "info");
    expect(i.length).toBeGreaterThanOrEqual(1);
    expect(i[0].message).toContain("Overfull \\hbox");
    expect(i[0].line).toBe(3);
    expect(i[0].file).toBe("main.tex");
    expect(sel(d, "error")).toEqual([]);
  });

  it("overfull in paragraph uses first line of the range", () => {
    const i = sel(parseLog(log("overfull-paragraph")), "info");
    expect(i.some((x) => x.line === 5 && /Overfull/.test(x.message))).toBe(true);
  });

  it("missing \\input file reports the LaTeX error on the right line, not Emergency stop noise", () => {
    const e = sel(parseLog(log("missing-input")), "error");
    expect(e.length).toBeGreaterThanOrEqual(1);
    expect(e[0].message).toContain("File `nonexistent-chapter.tex' not found");
    expect(e[0].file).toBe("main.tex");
    expect(e[0].line).toBe(4);
    expect(e.some((x) => /Emergency stop|Fatal error/.test(x.message))).toBe(false);
  });

  it("missing package", () => {
    const e = sel(parseLog(log("missing-package")), "error");
    expect(e[0].message).toContain("nonexistentpkg.sty' not found");
    expect(e[0].file).toBe("main.tex");
    // TeX reports the fatal terminal-read at \begin{document} (l.3), not at the \usepackage line
    expect(e[0].line).toBe(3);
  });

  it("environment mismatch", () => {
    const e = sel(parseLog(log("env-mismatch")), "error");
    expect(e).toHaveLength(1);
    expect(e[0].line).toBe(5);
    expect(e[0].message).toContain("\\begin{itemize} on input line 3 ended by \\end{document}");
  });

  it("runaway argument: error without a file falls back to defaultFile", () => {
    const e = sel(parseLog(log("runaway"), { defaultFile: "main.tex" }), "error");
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("File ended while scanning use of \\textbf");
    expect(e[0].file).toBe("main.tex");
  });

  it("math errors", () => {
    const e = sel(parseLog(log("math-errors"), { defaultFile: "main.tex" }), "error");
    expect(e.map((x) => x.line).slice(0, 2)).toEqual([3, 5]);
    expect(e[0].message).toContain("Double superscript");
    expect(e[1].message).toContain("Too many }'s");
    expect(e).toHaveLength(3);
  });

  it("package warnings join (pkg) continuation lines and are de-duplicated", () => {
    const w = sel(parseLog(log("package-warning")), "warning");
    expect(w).toHaveLength(2);
    expect(w[0].message).toContain("Package hyperref Warning: Token not allowed in a PDF string (Unicode):");
    expect(w[0].message).toContain("removing `math shift' on input line 4.");
    expect(w[0].line).toBe(4);
    expect(w[1].message).toContain("removing `\\alpha'");
  });

  it("package warning without 'on input line' still gets the current file", () => {
    const w = sel(parseLog(log("fancyhdr-warning")), "warning");
    expect(w.length).toBeGreaterThanOrEqual(1);
    expect(w[0].message).toContain("headheight is too small");
    expect(w[0].message).toContain("Make it at least 12.0pt");
    expect(w[0].file).toBe("main.tex");
  });

  it("nested input: error attributed to the included file", () => {
    const e = sel(parseLog(log("nested-input-error")), "error");
    expect(e).toHaveLength(1);
    expect(e[0].file).toBe("chapters/one.tex");
    expect(e[0].line).toBe(3);
  });

  it("non-ASCII paths", () => {
    const e = sel(parseLog(log("unicode-path-error")), "error");
    expect(e[0].file).toBe("sec/einführung.tex");
    expect(e[0].line).toBe(2);
  });

  it("xelatex and lualatex logs", () => {
    for (const n of ["xelatex-undefined", "lualatex-undefined"]) {
      const e = sel(parseLog(log(n)), "error");
      const hit = e.find((x) => x.message.includes("Undefined control sequence"));
      expect(hit, n).toBeTruthy();
      expect(hit!.file).toBe("main.tex");
      expect(hit!.line).toBe(3);
    }
  });

  it("citation warning in log with bibtex", () => {
    const w = sel(parseLog(log("bibtex-warnings")), "warning");
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain("Citation `missing'");
  });

  it("caps at 200 entries and de-duplicates across passes", () => {
    let big = "";
    for (let i = 0; i < 300; i++) big += `(./main.tex\n./main.tex:${i + 1}: Undefined control sequence.\nl.${i + 1} \\foo\n\n)\n`;
    expect(parseLog(big)).toHaveLength(200);
    const twice = log("undefined-command") + log("undefined-command");
    expect(sel(parseLog(twice), "error")).toHaveLength(1);
  });

  it("handles CRLF and empty input", () => {
    expect(parseLog("")).toEqual([]);
    const crlf = log("undefined-command").replace(/\n/g, "\r\n");
    expect(sel(parseLog(crlf), "error")).toHaveLength(1);
  });

  it("is fast on a large log", () => {
    const base = log("package-warning");
    const huge = base.repeat(200);
    const t = Date.now();
    parseLog(huge);
    expect(Date.now() - t).toBeLessThan(1500);
  });
});

describe("parseBlg", () => {
  it("bibtex warning for missing entry attaches to the .bib database", () => {
    const d = parseBlg(blg("bibtex-warnings"));
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe("warning");
    expect(d[0].source).toBe("bibtex");
    expect(d[0].file).toBe("refs.bib");
    expect(d[0].message).toContain('I didn\'t find a database entry for "missing"');
  });

  it("bibtex syntax error has file and line", () => {
    const d = parseBlg(blg("bibtex-syntax-error"));
    const e = d.filter((x) => x.severity === "error");
    expect(e).toHaveLength(1);
    expect(e[0].file).toBe("refs.bib");
    expect(e[0].line).toBe(3);
    expect(e[0].message).toContain("I was expecting a `,' or a `}'");
    expect(d.filter((x) => x.severity === "warning").length).toBeGreaterThanOrEqual(3);
  });

  it("biber (synthetic) ERROR/WARN lines", () => {
    const d = parseBlg(blg("biber-synthetic"));
    const e = d.filter((x) => x.severity === "error");
    const w = d.filter((x) => x.severity === "warning");
    expect(e).toHaveLength(2);
    expect(w).toHaveLength(2);
    expect(d.every((x) => x.source === "biber")).toBe(true);
    expect(e[0].message).toContain("syntax error");
    expect(e[0].file).toBe("refs.bib");
    expect(e[0].line).toBe(3);
    expect(e[1].message).toContain("Cannot find 'other.bib'");
    expect(w[0].message).toContain("didn't find a database entry for 'ghost'");
  });

  it("empty blg", () => {
    expect(parseBlg("")).toEqual([]);
  });
});

describe("fixtures", () => {
  it("has at least 10 real logs", () => {
    const names = ["clean","undefined-command","missing-dollar","undefined-refs","overfull-underfull","overfull-paragraph","missing-input","missing-package","env-mismatch","runaway","math-errors","package-warning","fancyhdr-warning","nested-input-error","unicode-path-error","xelatex-undefined","lualatex-undefined","bibtex-warnings","bibtex-nofile"];
    expect(names.filter((n) => existsSync(join(dir, n + ".log"))).length).toBe(names.length);
  });
});
