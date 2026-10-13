import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Engine, ToolInfo, ToolchainInfo } from "../types";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}
export type ExecFn = (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string }) => Promise<ExecResult>;
export interface ToolchainFs {
  exists(p: string): Promise<boolean>;
  readdir(p: string): Promise<string[]>;
}
export interface DetectOptions {
  settingsDir?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  fs?: ToolchainFs;
}

export const defaultExec: ExecFn = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: opts.env, timeout: opts.timeoutMs ?? 5000, killSignal: "SIGKILL", cwd: opts.cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });

export const defaultFs: ToolchainFs = {
  exists: async (p) => {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
  readdir: (p) => fsp.readdir(p),
};

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}
function getPathKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") return "PATH";
  return Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path";
}

export async function candidateDirs(opts: Required<Pick<DetectOptions, "platform" | "env" | "fs">> & { settingsDir?: string | null }): Promise<string[]> {
  const { platform, env, fs } = opts;
  const p = pathApi(platform);
  const out: string[] = [];
  const add = (d: string | undefined | null) => {
    if (d && !out.includes(d)) out.push(d);
  };
  add(opts.settingsDir);
  const sep = platform === "win32" ? ";" : ":";
  for (const d of (env[getPathKey(env, platform)] ?? "").split(sep)) add(d.trim());
  const texliveRoots: string[] = [];
  if (platform === "darwin") {
    add("/Library/TeX/texbin");
    add("/opt/homebrew/bin");
    add("/usr/local/bin");
    texliveRoots.push("/usr/local/texlive");
  } else if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (local) add(p.join(local, "Programs", "MiKTeX", "miktex", "bin", "x64"));
    add("C:\\Program Files\\MiKTeX\\miktex\\bin\\x64");
    add("C:\\Program Files (x86)\\MiKTeX\\miktex\\bin");
    texliveRoots.push("C:\\texlive");
  } else {
    texliveRoots.push("/usr/local/texlive");
    add("/usr/local/bin");
    add("/usr/bin");
  }
  for (const root of texliveRoots) {
    let years: string[] = [];
    try {
      years = (await fs.readdir(root)).filter((y) => /^\d{4}$/.test(y)).sort((a, b) => Number(b) - Number(a));
    } catch {
      continue;
    }
    for (const y of years) {
      const bin = p.join(root, y, "bin");
      let archs: string[] = [];
      try {
        archs = await fs.readdir(bin);
      } catch {
        continue;
      }
      for (const a of archs) add(p.join(bin, a));
    }
  }
  return out;
}

async function findTool(name: string, dirs: string[], platform: NodeJS.Platform, fs: ToolchainFs): Promise<{ path: string; dir: string } | null> {
  const p = pathApi(platform);
  const exts = platform === "win32" ? [".exe", ".bat", ".cmd"] : [""];
  for (const d of dirs) {
    for (const e of exts) {
      const full = p.join(d, name + e);
      try {
        if (await fs.exists(full)) return { path: full, dir: d };
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

async function probe(file: string, args: string[], re: RegExp | null, exec: ExecFn, env: NodeJS.ProcessEnv, lastMatch = false): Promise<string> {
  try {
    const r = await exec(file, args, { env, timeoutMs: 5000 });
    const text = (r.stdout + "\n" + r.stderr).trim();
    if (re) {
      const g = new RegExp(re.source, "gi");
      const all = [...text.matchAll(g)];
      if (all.length) return (lastMatch ? all[all.length - 1] : all[0])[1] ?? "unknown";
      return "unknown";
    }
    return text.split(/\r?\n/)[0]?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export async function detectToolchain(opts: DetectOptions = {}): Promise<ToolchainInfo> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? defaultExec;
  const fs = opts.fs ?? defaultFs;
  const dirs = await candidateDirs({ platform, env, fs, settingsDir: opts.settingsDir });
  const lm = await findTool("latexmk", dirs, platform, fs);
  const binDir = lm?.dir ?? null;
  const searchDirs = binDir ? [binDir, ...dirs.filter((d) => d !== binDir)] : dirs;
  const probeEnv = buildEnv({ binDir } as ToolchainInfo, env, platform);
  const mk = async (name: string, args: string[], re: RegExp | null, last = false): Promise<ToolInfo | null> => {
    const f = name === "latexmk" ? lm : await findTool(name, searchDirs, platform, fs);
    if (!f) return null;
    return { path: f.path, version: await probe(f.path, args, re, exec, probeEnv, last) };
  };
  const latexmk = await mk("latexmk", ["-v"], /Version\s+([\d.]+)/);
  const synctex = await mk("synctex", ["help"], /version\s+([\d.]+)/, true);
  const texcount = await mk("texcount", ["-version"], /version\s+([\d.]+)/);
  const biber = await mk("biber", ["--version"], /version:?\s*([\d.]+)/);
  const bibtex = await mk("bibtex", ["--version"], null);
  const engines = {} as Record<Engine, ToolInfo | null>;
  for (const e of ["pdflatex", "xelatex", "lualatex"] as Engine[]) engines[e] = await mk(e, ["--version"], null);
  const missing: string[] = [];
  if (!latexmk) missing.push("latexmk");
  if (!synctex) missing.push("synctex");
  if (!engines.pdflatex && !engines.xelatex && !engines.lualatex) missing.push("pdflatex/xelatex/lualatex");
  return { found: !!latexmk, binDir, latexmk, synctex, texcount, biber, bibtex, engines, missing, platform };
}

export function buildEnv(info: Pick<ToolchainInfo, "binDir">, base: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const key = getPathKey(env, platform);
  const sep = platform === "win32" ? ";" : ":";
  if (info.binDir) {
    const cur = env[key] ?? (platform === "win32" ? "" : "/usr/bin:/bin:/usr/sbin:/sbin");
    env[key] = cur ? `${info.binDir}${sep}${cur}` : info.binDir;
  }
  env.max_print_line = "10000";
  env.error_line = "254";
  env.half_error_line = "238";
  return env;
}

export function installHint(platform: NodeJS.Platform): { title: string; url: string; steps: string[] } {
  if (platform === "darwin")
    return { title: "Install MacTeX (or BasicTeX)", url: "https://tug.org/mactex/", steps: ["Download and run the MacTeX installer (or `brew install --cask mactex-no-gui`).", "Restart Obsidian so it can find /Library/TeX/texbin.", "Click Re-check."] };
  if (platform === "win32")
    return { title: "Install MiKTeX or TeX Live", url: "https://miktex.org/download", steps: ["Install MiKTeX (or TeX Live) and enable installing missing packages on the fly.", "Install Strawberry Perl (https://strawberryperl.com/) - latexmk needs Perl.", "Restart Obsidian and click Re-check."] };
  return { title: "Install TeX Live", url: "https://tug.org/texlive/", steps: ["Install TeX Live, e.g. `sudo apt install texlive-full latexmk` (Debian/Ubuntu) or `sudo dnf install texlive-scheme-full latexmk` (Fedora).", "Restart Obsidian and click Re-check."] };
}
