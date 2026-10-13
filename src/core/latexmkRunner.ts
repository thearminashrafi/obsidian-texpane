import { spawn, type ChildProcess } from "node:child_process";
import type { BuildRequest, Engine } from "../types";

export interface RunnerResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  spawnError?: string;
}

export function engineFlag(e: Engine): string {
  return e === "xelatex" ? "-pdfxe" : e === "lualatex" ? "-pdflua" : "-pdf";
}

/** Split a free-text argument string into an argument array (supports simple "double" and 'single' quotes). Never goes through a shell. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function latexmkArgs(req: BuildRequest, compileRoot: string): string[] {
  const args = [engineFlag(req.project.engine), "-interaction=nonstopmode", "-file-line-error", "-synctex=1", `-outdir=${req.project.buildDir}`];
  if (req.shellEscape) args.push("-shell-escape");
  if (req.force) args.push("-g");
  args.push(...req.extraArgs);
  args.push(compileRoot);
  return args;
}

export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false }).on("error", () => undefined);
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000).unref();
    }
  } catch {
    /* ignore */
  }
}

export interface RunOptions {
  latexmkPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onChild?: (c: ChildProcess) => void;
}

export function runLatexmk(o: RunOptions): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let output = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let child: ChildProcess;
    const finish = (r: Partial<RunnerResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: null, output: output.slice(-60000), timedOut, cancelled, durationMs: Date.now() - start, ...r });
    };
    try {
      child = spawn(o.latexmkPath, o.args, { cwd: o.cwd, env: o.env, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ exitCode: null, output: "", timedOut: false, cancelled: false, durationMs: 0, spawnError: String(e) });
    }
    o.onChild?.(child);
    const onData = (d: Buffer) => {
      output += d.toString("utf8");
      if (output.length > 200000) output = output.slice(-100000);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => finish({ spawnError: String(e) }));
    child.on("close", (code) => finish({ exitCode: code }));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, o.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    if (o.signal) {
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener("abort", onAbort);
    }
  });
}
