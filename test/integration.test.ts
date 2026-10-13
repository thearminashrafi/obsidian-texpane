import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { detectToolchain, buildEnv } from "../src/core/toolchain";
import { resolveProject, type ResolverFs } from "../src/core/projectResolver";
import { runBuild } from "../src/core/buildPipeline";
import { FolderNoteProvider } from "../src/core/folderNotes";
import { forwardSearch, inverseSearch } from "../src/core/syncMap";
import { exportFlattened } from "../src/core/exportFlatten";
import type { BuildRequest, BuildResult, ToolchainInfo } from "../src/types";

const fixtures = path.join(__dirname, "fixtures");
let tmp: string;
let tc: ToolchainInfo;
let haveTex = false;

const nodeFs: ResolverFs = {
  readFile: async (p) => { try { return await fsp.readFile(p, "utf8"); } catch { return null; } },
  exists: async (p) => { try { await fsp.access(p); return true; } catch { return false; } },
};

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "texpane-it-"));
  tc = await detectToolchain();
  haveTex = tc.found && !!tc.synctex;
});
afterAll(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

async function copyProject(name: string): Promise<string> {
  const dst = path.join(tmp, name + "-" + Math.random().toString(36).slice(2, 7));
  await fsp.cp(path.join(fixtures, "projects", name), dst, { recursive: true });
  return dst;
}
async function build(file: string, vaultBase: string, extra: Partial<BuildRequest> = {}, notes?: FolderNoteProvider): Promise<{ r: BuildResult; req: BuildRequest }> {
  const project = await resolveProject({ filePath: file, vaultBase, defaultEngine: "pdflatex", buildFolder: ".texpane/build", fs: nodeFs });
  const req: BuildRequest = { project, shellEscape: false, extraArgs: [], timeoutMs: 120000, texBinDir: tc.binDir, force: false, vaultBase, ...extra };
  const r = await runBuild(req, { latexmkPath: tc.latexmk!.path, env: buildEnv(tc, process.env), notes });
  return { r, req };
}
const text = (pdf: string) => execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" }).normalize("NFC");
const errs = (r: BuildResult) => r.diagnostics.filter((d) => d.severity === "error");

describe("integration: real latexmk", () => {
  it("toolchain is detected", () => {
    expect(haveTex).toBe(true);
    expect(tc.engines.pdflatex).toBeTruthy();
  });

  it("single file", async () => {
    const d = await copyProject("single");
    const { r } = await build(path.join(d, "main.tex"), d);
    expect(r.status).toBe("ok");
    expect(r.pdfUpdated).toBe(true);
    expect(errs(r)).toEqual([]);
    expect(text(r.pdfPath!)).toContain("Hello");
    expect(r.mapping.shadowDir).toBeNull();
  });

  it("multi-file: \\input + \\include + % !TEX root, compiled from a child file", async () => {
    const d = await copyProject("multifile");
    const { r, req } = await build(path.join(d, "chapters", "one.tex"), d);
    expect(req.project.rootAbsPath).toBe(path.join(d, "main.tex"));
    expect(r.status).toBe("ok");
    const t = text(r.pdfPath!);
    expect(t).toContain("Chapter one paragraph");
    expect(t).toContain("Second chapter text");
    // second run resolves cross references
    expect(r.diagnostics.filter((x) => /undefined/.test(x.message))).toEqual([]);
  });

  it("bibtex project resolves citations via latexmk", async () => {
    const d = await copyProject("bibtex");
    const { r } = await build(path.join(d, "main.tex"), d);
    expect(r.status).toBe("ok");
    expect(r.diagnostics.filter((x) => /Citation/.test(x.message))).toEqual([]);
    expect(text(r.pdfPath!)).toContain("Knuth");
  });

  it("deliberately broken file: errors status, PDF still produced, error on the right line", async () => {
    const d = await copyProject("broken");
    const { r } = await build(path.join(d, "main.tex"), d);
    expect(r.status).toBe("errors");
    expect(r.pdfUpdated).toBe(true);
    const e = errs(r);
    expect(e).toHaveLength(1);
    expect(e[0].file).toBe(path.join(d, "main.tex"));
    expect(e[0].line).toBe(4);
    expect(e[0].message).toContain("Undefined control sequence");
    // fixing the file gives a clean build again
    await fsp.writeFile(path.join(d, "main.tex"), "\\documentclass{article}\n\\begin{document}\nFixed.\n\\end{document}\n");
    const again = await build(path.join(d, "main.tex"), d);
    expect(again.r.status).toBe("ok");
    expect(errs(again.r)).toEqual([]);
  });

  it("paths with spaces and non-ASCII characters", async () => {
    const d = await copyProject("unicode");
    const { r, req } = await build(path.join(d, "My Thesis", "Ch 1", "einführung.tex"), d);
    expect(req.project.rootAbsPath).toBe(path.join(d, "My Thesis", "main.tex"));
    expect(r.status).toBe("ok");
    expect(text(r.pdfPath!)).toContain("Einführung text");
    // error mapping with unicode path
    await fsp.writeFile(path.join(d, "My Thesis", "Ch 1", "einführung.tex"), "% !TEX root = ../main.tex\n\\kaputt\n");
    const b = await build(path.join(d, "My Thesis", "main.tex"), d);
    const e = errs(b.r);
    expect(e[0].file).toBe(path.join(d, "My Thesis", "Ch 1", "einführung.tex"));
    expect(e[0].line).toBe(2);
  });

  it("xelatex via magic comment with a system font", async () => {
    const d = await copyProject("xelatex");
    const { r, req } = await build(path.join(d, "main.tex"), d);
    expect(req.project.engine).toBe("xelatex");
    expect(r.status).toBe("ok");
    expect(text(r.pdfPath!)).toContain("XeLaTeX");
  });

  it("forward and inverse SyncTeX across \\input files", async () => {
    const d = await copyProject("multifile");
    const { r, req } = await build(path.join(d, "main.tex"), d);
    expect(r.status).toBe("ok");
    const common = { synctexPath: tc.synctex!.path, mapping: r.mapping, pdfFile: r.pdfPath!, buildDir: req.project.buildDir, env: buildEnv(tc, process.env), cwd: req.project.cwd };
    const f = await forwardSearch({ ...common, texFile: path.join(d, "sections", "two.tex"), line: 2, column: 1 });
    expect(f).toBeTruthy();
    const inv = await inverseSearch({ ...common, page: f!.page, x: f!.h + 5, y: f!.v - 1 });
    expect(inv).toBeTruthy();
    expect(inv!.file).toBe(path.join(d, "sections", "two.tex"));
    expect(inv!.line).toBe(2);
  });
});

describe("integration: \\obsidian embeds", () => {
  async function setup() {
    const d = await copyProject("embed");
    const vault = path.join(tmp, "vault-" + Math.random().toString(36).slice(2, 7));
    await fsp.cp(path.join(fixtures, "vault"), vault, { recursive: true });
    return { d, vault, notes: new FolderNoteProvider(vault) };
  }

  it("compiles a note with headings, math, table, image, nested embed and a cycle", async () => {
    const { d, notes } = await setup();
    const { r } = await build(path.join(d, "main.tex"), d, {}, notes);
    expect(r.status).toBe("ok");
    expect(errs(r)).toEqual([]);
    expect(r.mapping.shadowDir).not.toBeNull();
    const t = text(r.pdfPath!);
    expect(t).toContain("Literature review");
    expect(t).toContain("Prior work by");
    expect(t).toContain("Beta & Co");
    expect(t).toContain("Remember");
    expect(t).toContain("Methods");
    expect(t).toContain("We use a simple pipeline"); // block embed from the chapter file
    expect(t).toContain("Background text.");
    expect(t).not.toContain("Next text.");
    expect(t).not.toContain("private comment");
    const warns = r.diagnostics.filter((x) => x.severity === "warning");
    expect(warns.some((w) => /cycle/i.test(w.message))).toBe(true);
    expect(warns.some((w) => /Does not exist/.test(w.message) && w.line === 4 && w.file === path.join(d, "chapters", "ch.tex"))).toBe(true);
    expect(warns.some((w) => /nothing/.test(w.message) && w.line === 11 && w.file === path.join(d, "main.tex"))).toBe(true);
    // image was copied into the build dir assets
    const assets = await fsp.readdir(path.join(r.mapping.embedsDir!, "assets"));
    expect(assets.some((a) => a.endsWith(".png"))).toBe(true);
    // shadow keeps line numbers
    const shadow = await fsp.readFile(path.join(r.mapping.shadowDir!, "main.tex"), "utf8");
    const orig = await fsp.readFile(path.join(d, "main.tex"), "utf8");
    expect(shadow.split("\n").length).toBe(orig.split("\n").length);
    expect(shadow.split("\n")[6]).toMatch(/^\\input\{tpe-Lit_review-[0-9a-f]{8}\}$/);
    // original untouched
    expect(orig).toContain("\\obsidian{Lit review}");
  });

  it("TeX error inside embedded text maps to the note line and the \\obsidian line", async () => {
    const { d, vault, notes } = await setup();
    await fsp.writeFile(path.join(vault, "Broken.md"), "# Broken\n\nfine\n\n\\badmacro{x} in note line 5\n");
    // raw latex in markdown is escaped, so use a math error instead
    await fsp.writeFile(path.join(vault, "Broken.md"), "# Broken\n\nfine\n\n$\\badmacro{x}$ on note line 5\n");
    await fsp.writeFile(path.join(d, "main.tex"), "\\documentclass{article}\n\\begin{document}\nx\n\\obsidian{Broken}\n\\end{document}\n");
    const { r } = await build(path.join(d, "main.tex"), d, {}, notes);
    const e = errs(r);
    expect(e.length).toBeGreaterThan(0);
    expect(e[0].file).toBe(path.join(d, "main.tex"));
    expect(e[0].line).toBe(4);
    expect(e[0].note).toEqual({ path: "Broken.md", line: 5 });
  });

  it("editing a note updates the PDF (incremental) and unchanged notes are skipped", async () => {
    const { d, vault, notes } = await setup();
    const file = path.join(d, "main.tex");
    const a = await build(file, d, {}, notes);
    const embedFile = a.r.mapping.embeds[0].embedAbsPath;
    const m1 = (await fsp.stat(embedFile)).mtimeMs;
    await new Promise((res) => setTimeout(res, 30));
    const b = await build(file, d, {}, new FolderNoteProvider(vault));
    expect((await fsp.stat(embedFile)).mtimeMs).toBe(m1); // untouched: fresh
    expect(b.r.status).toBe("ok");
    await new Promise((res) => setTimeout(res, 30));
    const note = path.join(vault, "Folder", "Intro.md");
    await fsp.writeFile(note, (await fsp.readFile(note, "utf8")).replace("Background text.", "Edited background sentence."));
    const c = await build(file, d, {}, new FolderNoteProvider(vault));
    expect(text(c.r.pdfPath!)).toContain("Edited background sentence.");
  });

  it("double-click inverse search on embedded text resolves to the note and line; forward search works", async () => {
    const { d, notes } = await setup();
    const { r, req } = await build(path.join(d, "main.tex"), d, {}, notes);
    const common = { synctexPath: tc.synctex!.path, mapping: r.mapping, pdfFile: r.pdfPath!, buildDir: req.project.buildDir, env: buildEnv(tc, process.env), cwd: req.project.cwd };
    // forward from the \obsidian line in main.tex
    const f = await forwardSearch({ ...common, texFile: path.join(d, "main.tex"), line: 5, column: 1 });
    expect(f).toBeTruthy();
    // find the page/position of the text "Background text." via pdftotext -bbox
    const bbox = execFileSync("pdftotext", ["-bbox", r.pdfPath!, "-"], { encoding: "utf8" });
    const m = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">Background<\/word>/.exec(bbox);
    expect(m).toBeTruthy();
    const pageIdx = bbox.slice(0, m!.index).split("<page ").length - 1;
    const x = (Number(m![1]) + Number(m![3])) / 2;
    const y = (Number(m![2]) + Number(m![4])) / 2;
    const inv = await inverseSearch({ ...common, page: pageIdx, x, y });
    expect(inv).toBeTruthy();
    expect(inv!.note?.path).toBe("Folder/Intro.md");
    expect(inv!.note?.line).toBe(5); // "Background text." is line 5 of Folder/Intro.md
  });

  it("Export flattened project compiles with plain latexmk", async () => {
    const { d, vault, notes } = await setup();
    const out = path.join(tmp, "export-" + Math.random().toString(36).slice(2, 7));
    const res = await exportFlattened({ rootAbs: path.join(d, "main.tex"), cwd: d, outDir: out, notes, vaultBase: vault });
    expect(res.embedded).toBeGreaterThan(0);
    const flat = await fsp.readFile(path.join(out, "main.tex"), "utf8");
    expect(flat).not.toContain("\\obsidian{Lit review}");
    execFileSync(tc.latexmk!.path, ["-pdf", "-interaction=nonstopmode", "-file-line-error", "main.tex"], { cwd: out, env: buildEnv(tc, process.env), stdio: "pipe" });
    const t = text(path.join(out, "main.pdf"));
    expect(t).toContain("Prior work by");
    expect(t).toContain("Background text.");
  });
});
