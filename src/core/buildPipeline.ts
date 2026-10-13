import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { BuildMapping, BuildRequest, BuildResult, Diagnostic, EmbedRef, NoteProvider } from "../types";
import { EmbedBuilder } from "./embeds";
import { scanEmbeds, substituteEmbeds } from "./embedScanner";
import { detectPackages, extractInputs } from "./indexers";
import { latexmkArgs, runLatexmk, type RunnerResult } from "./latexmkRunner";
import { parseBlg, parseLog } from "./logParser";
import { isInside, toVaultRel } from "./paths";
import { mapDiagnostics } from "./syncMap";

export interface EmbedGraphEntry {
  texFile: string;
  notePaths: string[];
}

export interface BuildDeps {
  latexmkPath: string | null;
  /** Full env for the child (already includes TeX bin dir in PATH) */
  env: NodeJS.ProcessEnv;
  notes?: NoteProvider | null;
  wikilinkFootnote?: boolean;
  highlightEmph?: boolean;
  signal?: AbortSignal;
  /** Called with the embed graph discovered in this build */
  onEmbedGraph?: (entries: EmbedGraphEntry[]) => void;
  /** Override for tests */
  run?: typeof runLatexmk;
}

const exists = async (p: string) => {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
};
const readOrNull = async (p: string) => {
  try {
    return await fsp.readFile(p, "utf8");
  } catch {
    return null;
  }
};

function emptyMapping(req: BuildRequest): BuildMapping {
  return { compiledRoot: req.project.rootAbsPath, originalRoot: req.project.rootAbsPath, originalDir: req.project.cwd, shadowDir: null, embedsDir: null, shadowedFiles: [], embeds: [], embedSites: [] };
}

/** Project .tex files reachable from the root via \input/\include/\subfile. */
export async function collectProjectFiles(rootAbs: string, cwd: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const queue = [path.resolve(rootAbs)];
  while (queue.length) {
    const f = queue.pop()!;
    if (files.has(f)) continue;
    const text = await readOrNull(f);
    if (text === null) continue;
    files.set(f, text);
    for (const inp of extractInputs(text)) {
      const n = /\.[A-Za-z0-9]+$/.test(inp) ? inp : inp + ".tex";
      for (const c of [path.resolve(cwd, n), path.resolve(path.dirname(f), n)]) {
        if (!files.has(c) && (await exists(c))) {
          queue.push(c);
          break;
        }
      }
    }
  }
  return files;
}

/** Index of the end of the `\documentclass[..]{..}` command in `text` (outside comments), or -1. */
export function documentClassEnd(text: string): number {
  const re = /^[^%\n]*?(\\documentclass)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // make sure no unescaped % precedes on the line
    const before = m[0].slice(0, m[0].length - "\\documentclass".length);
    if (/(^|[^\\])%/.test(before)) continue;
    let i = m.index + m[0].length;
    while (/\s/.test(text[i] ?? "")) i++;
    if (text[i] === "[") {
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === "[") depth++;
        else if (text[i] === "]" && --depth === 0) {
          i++;
          break;
        }
      }
    }
    while (/\s/.test(text[i] ?? "")) i++;
    if (text[i] !== "{") return -1;
    let depth = 0;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i + 1;
    }
    return -1;
  }
  return -1;
}

export function supportMacros(opts: { graphics: boolean; links: boolean; hasGraphicx: boolean }): string {
  let s = "";
  if (opts.graphics && !opts.hasGraphicx) s += "\\usepackage{graphicx}";
  if (opts.links) s += "\\AtBeginDocument{\\providecommand{\\href}[2]{#2}\\providecommand{\\url}[1]{\\texttt{\\detokenize{#1}}}}";
  return s;
}

export function texinputsValue(dirs: string[], platform: NodeJS.Platform = process.platform): string {
  const sep = platform === "win32" ? ";" : ":";
  return dirs.map((d) => d.replace(/\\/g, "/")).join(sep) + sep;
}

export async function runBuild(req: BuildRequest, deps: BuildDeps): Promise<BuildResult> {
  const t0 = Date.now();
  const { project } = req;
  const base = path.basename(project.rootAbsPath).replace(/\.tex$/i, "");
  const pdfPath = path.join(project.buildDir, base + ".pdf");
  const mapping = emptyMapping(req);
  const extraDiags: Diagnostic[] = [];
  const result = (r: Partial<BuildResult>): BuildResult => ({ status: "failed", exitCode: null, durationMs: Date.now() - t0, pdfPath: null, pdfUpdated: false, diagnostics: extraDiags, rawLog: "", processOutput: "", mapping, ...r });

  if (!deps.latexmkPath) {
    return result({ status: "no-toolchain", diagnostics: [{ severity: "error", file: null, message: "latexmk was not found. Install a TeX distribution (see TeXPane settings).", source: "system" }] });
  }
  await fsp.mkdir(project.buildDir, { recursive: true });

  // ---- project scan ----
  const files = await collectProjectFiles(project.rootAbsPath, project.cwd);
  const refsByFile = new Map<string, EmbedRef[]>();
  let total = 0;
  for (const [f, text] of files) {
    const refs = scanEmbeds(text);
    if (refs.length) refsByFile.set(f, refs);
    total += refs.length;
  }
  const pkgs = new Set<string>();
  for (const text of files.values()) detectPackages(text).forEach((p) => pkgs.add(p));

  let compileRoot = project.rootAbsPath;
  const env = { ...deps.env };

  // mirror sub-directories of included files so \include{sub/x} can write sub/x.aux in the build dir
  for (const f of files.keys()) {
    const rel = path.relative(project.cwd, path.dirname(f));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) await fsp.mkdir(path.join(project.buildDir, rel), { recursive: true });
  }

  if (total > 0) {
    const shadowDir = path.join(project.buildDir, "shadow");
    const embedsDir = path.join(project.buildDir, "embeds");
    const assetsDir = path.join(embedsDir, "assets");
    await fsp.rm(shadowDir, { recursive: true, force: true });
    await fsp.mkdir(shadowDir, { recursive: true });
    await fsp.mkdir(embedsDir, { recursive: true });
    mapping.shadowDir = shadowDir;
    mapping.embedsDir = embedsDir;
    const builder = deps.notes
      ? new EmbedBuilder({
          notes: deps.notes,
          mode: "build",
          embedsDir,
          assetsDir,
          assetRefPrefix: "",
          wikilinkFootnote: deps.wikilinkFootnote ?? false,
          highlightEmph: deps.highlightEmph ?? true,
          amssymbLoaded: pkgs.has("amssymb"),
          listingsLoaded: pkgs.has("listings"),
        })
      : null;
    let usesGraphics = false;
    let usesLinks = false;
    const graph: EmbedGraphEntry[] = [];
    const sitesSeen = new Set<string>();

    for (const [f, text] of files) {
      const refs = refsByFile.get(f) ?? [];
      const inside = isInside(project.cwd, f);
      const rel = path.relative(project.cwd, f);
      if (!inside) {
        if (refs.length) extraDiags.push({ severity: "error", file: f, line: refs[0].line, message: "\\obsidian is only supported in files inside the root file's folder", source: "embed" });
        continue;
      }
      const fromVault = req.vaultBase ? toVaultRel(req.vaultBase, f) ?? undefined : undefined;
      const outcomes = new Map<number, string>();
      const notePaths = new Set<string>();
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        if (!builder) {
          extraDiags.push({ severity: "warning", file: f, line: ref.line, message: "Obsidian notes are not available; \\obsidian was left unresolved", source: "embed" });
          outcomes.set(i, `\\texttt{[unresolved embed]}`);
          continue;
        }
        const o = await builder.embed(ref, fromVault);
        outcomes.set(i, o.replacement);
        if (!o.ok) {
          extraDiags.push({ severity: "warning", file: f, line: ref.line, message: o.message ?? `Could not embed "${ref.target}"`, source: "embed" });
          continue;
        }
        usesGraphics ||= o.usesGraphics;
        usesLinks ||= o.usesLinks;
        o.notePaths.forEach((p) => notePaths.add(p));
        for (const info of o.files) {
          if (!mapping.embeds.some((e) => e.embedAbsPath === info.embedAbsPath)) mapping.embeds.push(info);
          if (!sitesSeen.has(info.embedAbsPath)) {
            sitesSeen.add(info.embedAbsPath);
            mapping.embedSites.push({ embedAbsPath: info.embedAbsPath, texFile: f, line: ref.line });
          }
        }
        for (const w of o.warnings) extraDiags.push({ severity: "warning", file: f, line: ref.line, message: `[${w.notePath}${w.line ? ":" + w.line : ""}] ${w.message}`, source: "embed", note: { path: w.notePath, line: w.line } });
      }
      graph.push({ texFile: f, notePaths: [...notePaths] });
      const shadowText = refs.length ? substituteEmbeds(text, (_r, i) => outcomes.get(i) ?? null) : text;
      const dest = path.join(shadowDir, rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      mapping.shadowedFiles.push(f);
      await fsp.writeFile(dest, shadowText, "utf8");
    }

    // support macros on the \documentclass line of the root
    const rootDest = path.join(shadowDir, path.relative(project.cwd, project.rootAbsPath));
    const macros = supportMacros({ graphics: usesGraphics, links: usesLinks, hasGraphicx: pkgs.has("graphicx") });
    if (macros) {
      const rt = (await readOrNull(rootDest)) ?? "";
      const end = documentClassEnd(rt);
      if (end >= 0) await fsp.writeFile(rootDest, rt.slice(0, end) + macros + rt.slice(end), "utf8");
    }
    deps.onEmbedGraph?.(graph);
    compileRoot = rootDest;
    mapping.compiledRoot = rootDest;
    const sepPlat = process.platform;
    env.TEXINPUTS = texinputsValue([shadowDir, project.cwd, embedsDir, assetsDir], sepPlat);
  } else {
    deps.onEmbedGraph?.([]);
  }

  // ---- run latexmk ----
  const startMs = Date.now();
  const run = deps.run ?? runLatexmk;
  const rr: RunnerResult = await run({ latexmkPath: deps.latexmkPath, args: latexmkArgs(req, compileRoot), cwd: project.cwd, env, timeoutMs: req.timeoutMs, signal: deps.signal });

  const rawLog = (await readOrNull(path.join(project.buildDir, base + ".log"))) ?? "";
  const blg = (await readOrNull(path.join(project.buildDir, base + ".blg"))) ?? "";
  const rel = (p: string) => path.relative(project.cwd, p);
  let diags: Diagnostic[] = [...parseLog(rawLog, { defaultFile: rel(compileRoot) }), ...parseBlg(blg).map((d) => (d.file && !path.isAbsolute(d.file) ? { ...d, file: path.join(project.cwd, d.file) } : d))];
  diags = mapDiagnostics(diags, mapping, project.cwd);
  const all = [...extraDiags, ...diags];

  let pdfUpdated = false;
  let havePdf = false;
  try {
    const st = await fsp.stat(pdfPath);
    havePdf = true;
    pdfUpdated = st.mtimeMs >= startMs - 100;
  } catch {
    /* no pdf */
  }
  if (rr.spawnError) all.push({ severity: "error", file: null, message: `Could not start latexmk: ${rr.spawnError}`, source: "system" });
  if (rr.timedOut) all.push({ severity: "error", file: null, message: `Build timed out after ${Math.round(req.timeoutMs / 1000)} s`, source: "system" });
  if (!rawLog && rr.output && !rr.cancelled && !all.some((d) => d.severity === "error")) all.push({ severity: "error", file: null, message: rr.output.trim().split("\n").slice(-3).join(" "), source: "system" });

  let status: BuildResult["status"];
  if (rr.cancelled) status = "cancelled";
  else if (rr.timedOut) status = "timeout";
  else if (rr.exitCode === 0) status = "ok";
  else if (pdfUpdated) status = "errors";
  else status = "failed";
  return { status, exitCode: rr.exitCode, durationMs: Date.now() - t0, pdfPath: havePdf ? pdfPath : null, pdfUpdated, diagnostics: all, rawLog, processOutput: rr.output, mapping };
}
