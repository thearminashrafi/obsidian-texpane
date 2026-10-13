import * as path from "node:path";
import type { BuildMapping, Diagnostic, SyncForward, SyncInverse } from "../types";
import { isInside, normalizeSynctexPath, relativeInside } from "./paths";
import { runSynctexEdit, runSynctexView } from "./synctex";
import type { ExecFn } from "./toolchain";

const samePath = (a: string, b: string) => path.resolve(a) === path.resolve(b);

export interface MappedLocation {
  /** Absolute path of the original source (a .tex file in the project or a system file) */
  file: string;
  line: number;
  /** Present when the location is inside an embedded vault note */
  note?: { path: string; line: number };
}

/** Translate a location in the compiled tree (shadow/embeds) back to original sources. */
export function mapCompiledLocation(absFile: string, line: number, m: BuildMapping): MappedLocation {
  const abs = path.resolve(absFile);
  if (m.shadowDir && isInside(m.shadowDir, abs)) {
    const rel = relativeInside(m.shadowDir, abs)!;
    return { file: path.join(m.originalDir, ...rel.split("/")), line };
  }
  if (m.embedsDir && isInside(m.embedsDir, abs)) {
    const e = m.embeds.find((x) => samePath(x.embedAbsPath, abs));
    if (e) {
      const site = m.embedSites.find((s) => samePath(s.embedAbsPath, abs));
      const noteLine = e.lineMap[line - 1] ?? 0;
      return {
        file: site ? site.texFile : m.originalRoot,
        line: site ? site.line : 1,
        note: { path: e.notePath, line: noteLine },
      };
    }
  }
  return { file: abs, line };
}

/** Path of an original source as seen by TeX (shadow copy if it was shadowed). */
export function toCompiledPath(origAbs: string, m: BuildMapping): string {
  const abs = path.resolve(origAbs);
  if (m.shadowDir && m.shadowedFiles.some((f) => samePath(f, abs))) {
    const rel = relativeInside(m.originalDir, abs);
    if (rel !== null) return path.join(m.shadowDir, ...rel.split("/"));
  }
  return abs;
}

export function mapDiagnostics(diags: Diagnostic[], m: BuildMapping, cwd: string): Diagnostic[] {
  return diags.map((d) => {
    if (!d.file) return d;
    const abs = normalizeSynctexPath(d.file, cwd);
    if (d.line === undefined && !(m.shadowDir && isInside(m.shadowDir, abs)) && !(m.embedsDir && isInside(m.embedsDir, abs))) return { ...d, file: abs };
    const loc = mapCompiledLocation(abs, d.line ?? 0, m);
    const out: Diagnostic = { ...d, file: loc.file };
    if (d.line !== undefined) out.line = loc.line;
    if (loc.note) {
      out.note = loc.note;
      out.message = `[${loc.note.path}${loc.note.line ? ":" + loc.note.line : ""}] ${d.message}`;
    }
    return out;
  });
}

export interface ForwardArgs {
  synctexPath: string;
  mapping: BuildMapping;
  pdfFile: string;
  buildDir: string;
  texFile: string;
  line: number;
  column: number;
  env: NodeJS.ProcessEnv;
  cwd: string;
  exec?: ExecFn;
}
export async function forwardSearch(a: ForwardArgs): Promise<SyncForward | null> {
  const compiled = toCompiledPath(a.texFile, a.mapping);
  const r = await runSynctexView({ synctexPath: a.synctexPath, texFile: compiled, line: a.line, column: Math.max(a.column, 0), pdfFile: a.pdfFile, buildDir: a.buildDir, env: a.env, exec: a.exec, cwd: a.cwd });
  return r[0] ?? null;
}

export interface InverseArgs {
  synctexPath: string;
  mapping: BuildMapping;
  pdfFile: string;
  buildDir: string;
  page: number;
  x: number;
  y: number;
  env: NodeJS.ProcessEnv;
  cwd: string;
  exec?: ExecFn;
}
export async function inverseSearch(a: InverseArgs): Promise<(MappedLocation & { column: number }) | null> {
  const r: SyncInverse[] = await runSynctexEdit({ synctexPath: a.synctexPath, page: a.page, x: a.x, y: a.y, pdfFile: a.pdfFile, buildDir: a.buildDir, env: a.env, exec: a.exec, cwd: a.cwd });
  if (!r.length) return null;
  const abs = normalizeSynctexPath(r[0].file, a.cwd);
  return { ...mapCompiledLocation(abs, r[0].line, a.mapping), column: r[0].column };
}
