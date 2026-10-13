import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { NoteProvider } from "../types";
import { collectProjectFiles, documentClassEnd, supportMacros } from "./buildPipeline";
import { EmbedBuilder } from "./embeds";
import { scanEmbeds, substituteEmbeds } from "./embedScanner";
import { detectPackages } from "./indexers";
import { isInside, toVaultRel } from "./paths";

export interface ExportOptions {
  rootAbs: string;
  cwd: string;
  outDir: string;
  notes: NoteProvider;
  vaultBase?: string;
  wikilinkFootnote?: boolean;
  highlightEmph?: boolean;
}
export interface ExportResult {
  outDir: string;
  rootFile: string;
  warnings: string[];
  embedded: number;
}

const SKIP_DIR = /^\.|^node_modules$/;
const SKIP_FILE = /\.(aux|log|synctex\.gz|fdb_latexmk|fls|out|toc|lof|lot|bcf|run\.xml|blg|bbl|nav|snm|vrb)$/i;

async function copyDir(src: string, dst: string, skip: string): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    if (e.isDirectory()) {
      // never copy the export folder (or the folder holding it) into itself: it is inside the project when the root is at the vault root
      if (SKIP_DIR.test(e.name) || isInside(path.resolve(src, e.name), skip)) continue;
      await copyDir(path.join(src, e.name), path.join(dst, e.name), skip);
    } else if (e.isFile() && !SKIP_FILE.test(e.name)) {
      await fsp.copyFile(path.join(src, e.name), path.join(dst, e.name));
    }
  }
}

/** Write a standalone folder where every \obsidian is replaced by converted LaTeX and images are copied in. */
export async function exportFlattened(o: ExportOptions): Promise<ExportResult> {
  await fsp.mkdir(o.outDir, { recursive: true });
  await copyDir(o.cwd, o.outDir, path.resolve(o.outDir));
  const files = await collectProjectFiles(o.rootAbs, o.cwd);
  const pkgs = new Set<string>();
  for (const t of files.values()) detectPackages(t).forEach((p) => pkgs.add(p));
  const builder = new EmbedBuilder({
    notes: o.notes,
    mode: "export",
    embedsDir: path.join(o.outDir, "embeds-unused"),
    assetsDir: path.join(o.outDir, "assets"),
    assetRefPrefix: "assets/",
    wikilinkFootnote: o.wikilinkFootnote ?? false,
    highlightEmph: o.highlightEmph ?? true,
    amssymbLoaded: pkgs.has("amssymb"),
    listingsLoaded: pkgs.has("listings"),
  });
  const warnings: string[] = [];
  let usesGraphics = false;
  let usesLinks = false;
  let embedded = 0;
  for (const [f, text] of files) {
    const refs = scanEmbeds(text);
    if (!refs.length) continue;
    const rel = path.relative(o.cwd, f);
    if (rel.startsWith("..")) continue;
    const fromVault = o.vaultBase ? toVaultRel(o.vaultBase, f) ?? undefined : undefined;
    const reps: string[] = [];
    for (const r of refs) {
      const out = await builder.embed(r, fromVault);
      reps.push(out.replacement);
      if (!out.ok) warnings.push(`${rel}:${r.line}: ${out.message}`);
      else {
        embedded++;
        usesGraphics ||= out.usesGraphics;
        usesLinks ||= out.usesLinks;
        for (const w of out.warnings) warnings.push(`${rel}:${r.line}: [${w.notePath}${w.line ? ":" + w.line : ""}] ${w.message}`);
      }
    }
    await fsp.writeFile(path.join(o.outDir, rel), substituteEmbeds(text, (_r, i) => reps[i]), "utf8");
  }
  const rootRel = path.relative(o.cwd, o.rootAbs);
  const rootOut = path.join(o.outDir, rootRel);
  const macros = supportMacros({ graphics: usesGraphics, links: usesLinks, hasGraphicx: pkgs.has("graphicx") });
  if (macros) {
    const t = await fsp.readFile(rootOut, "utf8");
    const end = documentClassEnd(t);
    if (end >= 0) await fsp.writeFile(rootOut, t.slice(0, end) + "\n" + macros + t.slice(end), "utf8");
  }
  await fsp.rm(path.join(o.outDir, "embeds-unused"), { recursive: true, force: true });
  return { outDir: o.outDir, rootFile: rootOut, warnings, embedded };
}
