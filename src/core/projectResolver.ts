import * as path from "node:path";
import type { Engine, ProjectInfo } from "../types";

export interface ResolverFs {
  readFile(abs: string): Promise<string | null>;
  exists(abs: string): Promise<boolean>;
}
export interface ResolveOptions {
  filePath: string;
  content?: string;
  vaultBase: string;
  defaultEngine: Engine;
  buildFolder: string;
  fs: ResolverFs;
}

export function parseMagicComments(content: string): { root?: string; program?: Engine } {
  const out: { root?: string; program?: Engine } = {};
  const lines = content.split(/\r?\n/).slice(0, 20);
  for (const line of lines) {
    const m = /^\s*%\s*!\s*te[xX]\s+(root|ts-program|program)\s*=\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    const key = m[1].toLowerCase();
    if (key === "root") out.root ??= v;
    else {
      const e = v.toLowerCase();
      if (e === "pdflatex" || e === "xelatex" || e === "lualatex") out.program ??= e;
    }
  }
  return out;
}

export function hasDocumentClass(content: string): boolean {
  return content.split(/\r?\n/).some((l) => {
    const i = l.indexOf("\\documentclass");
    if (i < 0) return false;
    const pre = l.slice(0, i);
    return !/(^|[^\\])%/.test(pre);
  });
}

function withTex(p: string): string {
  return /\.[A-Za-z0-9]+$/.test(p) ? p : p + ".tex";
}

export async function resolveProject(o: ResolveOptions): Promise<ProjectInfo> {
  const { fs } = o;
  const file = path.resolve(o.filePath);
  const content = o.content ?? (await fs.readFile(file)) ?? "";
  let root = await findRoot(file, content, o);
  const rootContent = root === file ? content : ((await fs.readFile(root)) ?? "");
  const magic = parseMagicComments(rootContent);
  const own = parseMagicComments(content);
  const engine = magic.program ?? own.program ?? o.defaultEngine;
  root = path.resolve(root);
  const cwd = path.dirname(root);
  return { rootAbsPath: root, cwd, engine, buildDir: path.join(cwd, ...o.buildFolder.split(/[\\/]/).filter(Boolean)) };
}

async function findRoot(file: string, content: string, o: ResolveOptions): Promise<string> {
  // magic comment chain (max 4 hops, cycle-safe)
  const seen = new Set<string>([file]);
  let cur = file;
  let curContent = content;
  for (let hop = 0; hop < 4; hop++) {
    const m = parseMagicComments(curContent);
    if (!m.root) break;
    const target = path.resolve(path.dirname(cur), withTex(m.root.replace(/\\/g, "/")));
    if (seen.has(target)) return cur;
    if (!(await o.fs.exists(target))) break;
    seen.add(target);
    cur = target;
    curContent = (await o.fs.readFile(target)) ?? "";
    if (!parseMagicComments(curContent).root) return cur;
  }
  if (cur !== file) return cur;
  if (hasDocumentClass(content)) return file;
  // nearest main.tex upward until vault root
  const stop = path.resolve(o.vaultBase);
  let dir = path.dirname(file);
  for (let i = 0; i < 64; i++) {
    const cand = path.join(dir, "main.tex");
    if (cand !== file && (await o.fs.exists(cand))) return cand;
    if (path.resolve(dir) === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    // do not climb past the vault root
    const rel = path.relative(stop, parent);
    if (rel.startsWith("..") || path.isAbsolute(rel)) break;
    dir = parent;
  }
  return file;
}
