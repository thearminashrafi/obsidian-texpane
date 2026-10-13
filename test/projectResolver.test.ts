import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { resolveProject, parseMagicComments, type ResolverFs } from "../src/core/projectResolver";

function memFs(files: Record<string, string>): ResolverFs {
  const m = new Map(Object.entries(files).map(([k, v]) => [path.resolve(k), v]));
  return {
    readFile: async (p) => (m.has(path.resolve(p)) ? m.get(path.resolve(p))! : null),
    exists: async (p) => m.has(path.resolve(p)),
  };
}
const V = path.resolve("/vault");
const base = { vaultBase: V, defaultEngine: "pdflatex" as const, buildFolder: ".texpane/build" };

describe("parseMagicComments", () => {
  it("parses root and program, case-insensitive, quotes, spaces", () => {
    expect(parseMagicComments("% !TEX root = ../main.tex\n")).toEqual({ root: "../main.tex" });
    expect(parseMagicComments("%!TeX program=XeLaTeX\n\\foo")).toEqual({ program: "xelatex" });
    expect(parseMagicComments("% !TEX TS-program = lualatex\n").program).toBe("lualatex");
    expect(parseMagicComments('% !TEX root = "My Main.tex"\n').root).toBe("My Main.tex");
    expect(parseMagicComments("% !TEX program = latex\n").program).toBeUndefined();
  });
  it("only looks at the first 20 lines", () => {
    const text = "\n".repeat(25) + "% !TEX root = main.tex\n";
    expect(parseMagicComments(text)).toEqual({});
  });
});

describe("resolveProject", () => {
  it("file with \\documentclass is its own root", async () => {
    const fs = memFs({ "/vault/p/main.tex": "\\documentclass{article}" });
    const p = await resolveProject({ ...base, filePath: path.resolve("/vault/p/main.tex"), fs });
    expect(p.rootAbsPath).toBe(path.resolve("/vault/p/main.tex"));
    expect(p.cwd).toBe(path.resolve("/vault/p"));
    expect(p.engine).toBe("pdflatex");
    expect(p.buildDir).toBe(path.join(path.resolve("/vault/p"), ".texpane", "build"));
  });
  it("commented documentclass does not count", async () => {
    const fs = memFs({ "/vault/p/a.tex": "% \\documentclass{article}\nfoo", "/vault/p/main.tex": "\\documentclass{article}" });
    const p = await resolveProject({ ...base, filePath: path.resolve("/vault/p/a.tex"), fs });
    expect(p.rootAbsPath).toBe(path.resolve("/vault/p/main.tex"));
  });
  it("magic root with ../ and no extension, uses unsaved content when given", async () => {
    const fs = memFs({ "/vault/p/main.tex": "\\documentclass{article}\n% !TEX program = xelatex", "/vault/p/ch/c.tex": "old" });
    const p = await resolveProject({ ...base, filePath: path.resolve("/vault/p/ch/c.tex"), content: "% !TEX root = ../main\nhello", fs });
    expect(p.rootAbsPath).toBe(path.resolve("/vault/p/main.tex"));
    expect(p.cwd).toBe(path.resolve("/vault/p"));
    expect(p.engine).toBe("xelatex");
    expect(p.buildDir).toBe(path.join(path.resolve("/vault/p"), ".texpane", "build"));
  });
  it("nearest main.tex upward, stops at vault root", async () => {
    const fs = memFs({ "/vault/thesis/main.tex": "\\documentclass{book}", "/vault/thesis/a/b/c.tex": "text", "/main.tex": "\\documentclass{x}" });
    const p = await resolveProject({ ...base, filePath: path.resolve("/vault/thesis/a/b/c.tex"), fs });
    expect(p.rootAbsPath).toBe(path.resolve("/vault/thesis/main.tex"));
    const fs2 = memFs({ "/vault/x/c.tex": "text", "/main.tex": "\\documentclass{x}" });
    const p2 = await resolveProject({ ...base, filePath: path.resolve("/vault/x/c.tex"), fs: fs2 });
    expect(p2.rootAbsPath).toBe(path.resolve("/vault/x/c.tex"));
  });
  it("engine from settings default and per-file override; spaces and unicode paths", async () => {
    const f = "/vault/My Thesis/Ch 1/einführung.tex";
    const fs = memFs({ [f]: "\\documentclass{article}\n% !TEX program = lualatex" });
    const p = await resolveProject({ ...base, defaultEngine: "xelatex", filePath: path.resolve(f), fs });
    expect(p.engine).toBe("lualatex");
    const fs2 = memFs({ [f]: "\\documentclass{article}" });
    const p2 = await resolveProject({ ...base, defaultEngine: "xelatex", filePath: path.resolve(f), fs: fs2 });
    expect(p2.engine).toBe("xelatex");
    expect(p2.cwd).toBe(path.resolve("/vault/My Thesis/Ch 1"));
  });
  it("root magic comment cycle does not hang", async () => {
    const fs = memFs({ "/vault/a.tex": "% !TEX root = b.tex", "/vault/b.tex": "% !TEX root = a.tex" });
    const p = await resolveProject({ ...base, filePath: path.resolve("/vault/a.tex"), fs });
    expect([path.resolve("/vault/a.tex"), path.resolve("/vault/b.tex")]).toContain(p.rootAbsPath);
  });
  it("magic root pointing to a missing file falls back to rules", async () => {
    const fs = memFs({ "/vault/a.tex": "% !TEX root = gone.tex\n\\documentclass{article}" });
    const p = await resolveProject({ ...base, filePath: path.resolve("/vault/a.tex"), fs });
    expect(p.rootAbsPath).toBe(path.resolve("/vault/a.tex"));
  });
});
