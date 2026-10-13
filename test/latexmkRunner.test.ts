import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { runLatexmk } from "../src/core/latexmkRunner";

const posix = process.platform !== "win32";

function alive(pid: number): boolean {
  try {
    // a killed orphan stays a zombie until init reaps it; that counts as dead
    if (/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))) return false;
  } catch {
    /* no procfs (macOS) or already gone */
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

/** Fake "latexmk": a shell that starts a long-running grandchild and prints its pid. */
function fakeTree(timeoutMs: number, signal?: AbortSignal) {
  let grandchild = 0;
  let gotPid: () => void = () => undefined;
  const started = new Promise<void>((r) => (gotPid = r));
  const run = runLatexmk({
    latexmkPath: "/bin/sh",
    args: ["-c", "sleep 30 & echo $!; wait"],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs,
    signal,
    onChild: (c: ChildProcess) =>
      c.stdout?.on("data", (d: Buffer) => {
        const m = /(\d+)/.exec(d.toString());
        if (m && !grandchild) {
          grandchild = Number(m[1]);
          gotPid();
        }
      }),
  });
  return { run, started, pid: () => grandchild };
}

describe.skipIf(!posix)("runLatexmk process-tree kill (POSIX)", () => {
  it("cancel kills the grandchild too", async () => {
    const ac = new AbortController();
    const t = fakeTree(20000, ac.signal);
    await t.started;
    expect(alive(t.pid())).toBe(true);
    ac.abort();
    const r = await t.run;
    expect(r.cancelled).toBe(true);
    expect(await waitDead(t.pid())).toBe(true);
  });

  it("timeout kills the grandchild too", async () => {
    const t = fakeTree(300);
    await t.started;
    const r = await t.run;
    expect(r.timedOut).toBe(true);
    expect(await waitDead(t.pid())).toBe(true);
  });

  it("does not spawn when already cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    let spawned = false;
    const r = await runLatexmk({ latexmkPath: "/bin/sh", args: ["-c", "sleep 30"], cwd: process.cwd(), env: process.env, timeoutMs: 20000, signal: ac.signal, onChild: () => (spawned = true) });
    expect(r.cancelled).toBe(true);
    expect(spawned).toBe(false);
  });

  it("uses no shell: metacharacters in arguments stay literal", async () => {
    const r = await runLatexmk({ latexmkPath: "/bin/echo", args: ["a;b", "$(x)", "c d"], cwd: process.cwd(), env: process.env, timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe("a;b $(x) c d");
  });
});
