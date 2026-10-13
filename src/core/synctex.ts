import type { SyncForward, SyncInverse } from "../types";
import { defaultExec, type ExecFn } from "./toolchain";

const num = (s: string) => Number.parseFloat(s);

export function parseSynctexView(out: string): SyncForward[] {
  const res: SyncForward[] = [];
  let cur: Partial<SyncForward> | null = null;
  const flush = () => {
    if (cur && cur.page !== undefined && cur.x !== undefined && cur.y !== undefined) {
      res.push({ page: cur.page, x: cur.x, y: cur.y, h: cur.h ?? cur.x, v: cur.v ?? cur.y, W: cur.W ?? 0, H: cur.H ?? 0 });
    }
    cur = null;
  };
  for (const raw of out.split(/\r?\n/)) {
    const m = /^(Page|x|y|h|v|W|H):(.*)$/.exec(raw.trim());
    if (!m) {
      if (/^SyncTeX result end/.test(raw)) flush();
      continue;
    }
    if (m[1] === "Page") {
      flush();
      cur = { page: Number.parseInt(m[2], 10) };
    } else if (cur) {
      (cur as Record<string, number>)[m[1]] = num(m[2]);
    }
  }
  flush();
  return res;
}

export function parseSynctexEdit(out: string): SyncInverse[] {
  const res: SyncInverse[] = [];
  let cur: Partial<SyncInverse> | null = null;
  const flush = () => {
    if (cur && cur.file !== undefined && cur.line !== undefined) res.push({ file: cur.file, line: cur.line, column: cur.column ?? -1 });
    cur = null;
  };
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    let m = /^Input:(.*)$/.exec(line);
    if (m) {
      flush();
      cur = { file: m[1].trim() };
      continue;
    }
    if (!cur) continue;
    m = /^Line:(-?\d+)/.exec(line);
    if (m) cur.line = Number.parseInt(m[1], 10);
    m = /^Column:(-?\d+)/.exec(line);
    if (m) cur.column = Number.parseInt(m[1], 10);
  }
  flush();
  return res;
}

export interface SynctexViewArgs {
  synctexPath: string;
  texFile: string;
  line: number;
  column: number;
  pdfFile: string;
  buildDir: string;
  env: NodeJS.ProcessEnv;
  exec?: ExecFn;
  cwd?: string;
}
export async function runSynctexView(a: SynctexViewArgs): Promise<SyncForward[]> {
  try {
    const r = await (a.exec ?? defaultExec)(a.synctexPath, ["view", "-i", `${a.line}:${a.column}:${a.texFile}`, "-o", a.pdfFile, "-d", a.buildDir], { env: a.env, timeoutMs: 3000, cwd: a.cwd });
    return parseSynctexView(r.stdout);
  } catch {
    return [];
  }
}
export interface SynctexEditArgs {
  synctexPath: string;
  page: number;
  x: number;
  y: number;
  pdfFile: string;
  buildDir: string;
  env: NodeJS.ProcessEnv;
  exec?: ExecFn;
  cwd?: string;
}
export async function runSynctexEdit(a: SynctexEditArgs): Promise<SyncInverse[]> {
  try {
    const r = await (a.exec ?? defaultExec)(a.synctexPath, ["edit", "-o", `${a.page}:${a.x}:${a.y}:${a.pdfFile}`, "-d", a.buildDir], { env: a.env, timeoutMs: 3000, cwd: a.cwd });
    return parseSynctexEdit(r.stdout);
  } catch {
    return [];
  }
}
