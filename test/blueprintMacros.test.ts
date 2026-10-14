import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { BLUEPRINT_MACROS, blueprintFallbackMacros, usesBlueprintMacros } from "../src/core/blueprintMacros";
import { documentClassEnd, runBuild, supportMacros } from "../src/core/buildPipeline";
import { resolveProject, type ResolverFs } from "../src/core/projectResolver";
import { buildEnv, detectToolchain } from "../src/core/toolchain";
import type { BuildResult, ToolchainInfo } from "../src/types";

describe("blueprintFallbackMacros", () => {
  const none = new Set<string>();
  it("is empty for documents that do not use the macros", () => {
    expect(blueprintFallbackMacros(["\\documentclass{article}\\begin{document}Hi \\leaning\\end{document}"], none)).toBe("");
    expect(usesBlueprintMacros("% \\lean{x}\n\\section{A}")).toBe(false);
  });
  it("provides every macro when none is defined, in one line", () => {
    const m = blueprintFallbackMacros(["\\documentclass{article}\n\\begin{document}\\lean{A.b}\\end{document}"], none);
    expect(m).not.toContain("\n");
    expect(m.startsWith("\\AtBeginDocument{")).toBe(true);
    for (const mac of BLUEPRINT_MACROS) expect(m).toContain(`\\providecommand{\\${mac.name}}${mac.args ? `[${mac.args}]` : ""}{}`);
  });
  it("leaves out macros the document defines (newcommand, def, NewDocumentCommand, in any file)", () => {
    const m = blueprintFallbackMacros(["\\newcommand{\\lean}[1]{}\n\\def\\leanok{}\n\\usepackage{x}\\lean{a}", "\\NewDocumentCommand{\\uses}{m}{}"], none);
    expect(m).not.toContain("\\lean}");
    expect(m).not.toContain("{\\leanok}");
    expect(m).not.toContain("{\\uses}");
    expect(m).toContain("{\\mathlibok}");
    expect(m).toContain("{\\discussion}");
  });
  it("does nothing when everything is defined or the blueprint package is used", () => {
    const all = BLUEPRINT_MACROS.map((x) => `\\newcommand{\\${x.name}}{}`).join("\n") + "\\lean{a}";
    expect(blueprintFallbackMacros([all], none)).toBe("");
    expect(blueprintFallbackMacros(["\\usepackage{blueprint}\\lean{a}"], new Set(["blueprint"]))).toBe("");
  });
  it("ignores definitions in comments", () => {
    expect(blueprintFallbackMacros(["% \\newcommand{\\lean}[1]{}\n\\lean{a}"], none)).toContain("\\providecommand{\\lean}[1]{}");
  });
  it("supportMacros puts it first and keeps the other macros", () => {
    const bp = "\\AtBeginDocument{\\providecommand{\\lean}[1]{}}";
    expect(supportMacros({ graphics: true, links: false, hasGraphicx: false, blueprint: bp })).toBe(bp + "\\usepackage{graphicx}");
    expect(supportMacros({ graphics: false, links: false, hasGraphicx: false })).toBe("");
  });
});

// ------------------------------------------------------------------ real pdflatex
let tmp: string;
let tc: ToolchainInfo;
const nodeFs: ResolverFs = {
  readFile: async (p) => { try { return await fsp.readFile(p, "utf8"); } catch { return null; } },
  exists: async (p) => { try { await fsp.access(p); return true; } catch { return false; } },
};

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "texpane-bp-"));
  tc = await detectToolchain();
});
afterAll(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

async function project(files: Record<string, string>): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(tmp, "p-"));
  for (const [name, text] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fsp.writeFile(path.join(dir, name), text, "utf8");
  }
  return dir;
}
async function build(dir: string, main = "main.tex"): Promise<BuildResult> {
  const info = await resolveProject({ filePath: path.join(dir, main), vaultBase: dir, defaultEngine: "pdflatex", buildFolder: ".texpane/build", fs: nodeFs });
  return runBuild(
    { project: info, shellEscape: false, extraArgs: [], timeoutMs: 120000, texBinDir: tc.binDir, force: false, vaultBase: dir },
    { latexmkPath: tc.latexmk!.path, env: buildEnv(tc, process.env) },
  );
}
const pdfText = (r: BuildResult) => execFileSync("pdftotext", ["-layout", r.pdfPath!, "-"], { encoding: "utf8" });
const errors = (r: BuildResult) => r.diagnostics.filter((d) => d.severity === "error");

const BLUEPRINT_DOC = [
  "\\documentclass{article}", // 1
  "\\usepackage{amsthm}", // 2
  "\\newtheorem{lemma}{Lemma}", // 3
  "\\newtheorem{definition}{Definition}", // 4
  "\\begin{document}", // 5
  "\\begin{definition}", // 6
  "  \\label{def:a}\\lean{Foo.A_b}\\leanok\\mathlibok", // 7
  "  A thing, with a plain name.", // 8
  "\\end{definition}", // 9
  "\\begin{lemma}[Bound]", // 10
  "  \\label{lem:bound} \\lean{Foo.bound, Foo.bound_aux}", // 11
  "  \\uses{def:a}", // 12
  "  \\notready", // 13
  "  For all $n$, $n \\le n$.", // 14
  "\\end{lemma}", // 15
  "\\begin{proof}", // 16
  "  \\leanok \\uses{def:a} \\proves{lem:bound}\\discussion{12}", // 17
  "  Trivial.", // 18
  "\\end{proof}", // 19
  "\\end{document}", // 20
].join("\n");

describe("blueprint macro fallbacks: real pdflatex", () => {
  it("a document that uses the macros without defining them compiles, and the macros print nothing", async () => {
    expect(tc.found).toBe(true);
    const d = await project({ "main.tex": BLUEPRINT_DOC });
    const r = await build(d);
    expect(r.status).toBe("ok");
    expect(errors(r)).toEqual([]);
    const t = pdfText(r);
    expect(t).toContain("Trivial.");
    expect(t).toContain("A thing, with a plain name.");
    expect(t).not.toContain("Foo.bound");
    expect(t).not.toContain("def:a");
    // compiled through the shadow copy, which is where the fallbacks live
    expect(r.mapping.shadowDir).not.toBeNull();
    expect(await fsp.readFile(r.mapping.compiledRoot, "utf8")).toContain("\\AtBeginDocument{\\providecommand{\\lean}[1]{}");
  });

  it("keeps line numbers: the fallbacks sit on the \\documentclass line", async () => {
    const lines = BLUEPRINT_DOC.split("\n");
    lines.splice(13, 0, "  Oops \\thisisundefined here."); // line 14
    const d = await project({ "main.tex": lines.join("\n") });
    const r = await build(d);
    const e = errors(r).find((x) => /Undefined control sequence/.test(x.message));
    expect(e).toBeTruthy();
    expect(e!.line).toBe(14);
    expect(path.resolve(e!.file!)).toBe(path.join(d, "main.tex"));
    // and the shadow root has exactly as many lines as the original
    const shadow = await fsp.readFile(r.mapping.compiledRoot, "utf8");
    expect(shadow.split("\n").length).toBe(lines.length);
    expect(documentClassEnd(shadow)).toBeGreaterThan(0);
  });

  it("works across \\input files", async () => {
    const d = await project({
      "main.tex": "\\documentclass{article}\n\\usepackage{amsthm}\n\\newtheorem{lemma}{Lemma}\n\\begin{document}\n\\input{chapters/one}\n\\end{document}\n",
      "chapters/one.tex": "\\begin{lemma}\\label{l}\\lean{X}\\uses{a,b}Chapter text.\\end{lemma}\\begin{proof}\\leanok Done.\\end{proof}\n",
    });
    const r = await build(d);
    expect(r.status).toBe("ok");
    expect(errors(r)).toEqual([]);
    expect(pdfText(r)).toContain("Chapter text.");
  });

  it("does not clash with the document's own definitions (preamble or \\input macros file)", async () => {
    const d = await project({
      "main.tex": [
        "\\documentclass{article}",
        "\\input{macros}",
        "\\newcommand{\\lean}[1]{[Lean: #1]}",
        "\\renewcommand{\\leanok}{[ok]}",
        "\\begin{document}",
        "\\lean{Foo.bar} \\leanok \\uses{x} \\mathlibok \\notready \\proves{y} \\discussion{3}",
        "\\end{document}",
      ].join("\n"),
      "macros.tex": "\\newcommand{\\uses}[1]{}\\providecommand{\\leanok}{}\n",
    });
    const r = await build(d);
    expect(r.status).toBe("ok");
    expect(errors(r)).toEqual([]);
    const t = pdfText(r);
    expect(t).toContain("[Lean: Foo.bar]");
    expect(t).toContain("[ok]");
  });

  it("leaves ordinary documents alone: no shadow copy", async () => {
    const d = await project({ "main.tex": "\\documentclass{article}\n\\begin{document}\nPlain.\n\\end{document}\n" });
    const r = await build(d);
    expect(r.status).toBe("ok");
    expect(r.mapping.shadowDir).toBeNull();
    expect(r.mapping.compiledRoot).toBe(path.join(d, "main.tex"));
  });
});
