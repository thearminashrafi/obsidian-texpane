import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CompileQueue } from "../src/core/compileQueue";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("CompileQueue", () => {
  it("debounces schedule() calls", async () => {
    const run = vi.fn(async (_j: { force: boolean }) => "ok");
    const q = new CompileQueue<string>({ run, delayMs: 800 });
    q.schedule(); await vi.advanceTimersByTimeAsync(500);
    q.schedule(); await vi.advanceTimersByTimeAsync(500);
    q.schedule(); await vi.advanceTimersByTimeAsync(799);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].force).toBe(false);
  });

  it("single-flight: edits during a build coalesce into exactly one follow-up", async () => {
    const d1 = deferred(); let n = 0;
    const run = vi.fn(async () => { n++; if (n === 1) await d1.promise; return "r" + n; });
    const q = new CompileQueue<string>({ run, delayMs: 100 });
    q.schedule(); await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
    // many edits while running
    for (let i = 0; i < 5; i++) { q.schedule(); await vi.advanceTimersByTimeAsync(150); }
    expect(run).toHaveBeenCalledTimes(1);
    expect(q.state).toBe("queued");
    d1.resolve(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(q.state).toBe("idle");
  });

  it("compileNow bypasses the debounce, forces, and returns the result", async () => {
    const run = vi.fn(async (j: { force: boolean }) => (j.force ? "forced" : "normal"));
    const q = new CompileQueue<string>({ run, delayMs: 5000 });
    q.schedule();
    const p = q.compileNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toBe("forced");
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).toHaveBeenCalledTimes(1); // pending debounce was cleared
  });

  it("compileNow while running queues exactly one forced run and resolves with its result", async () => {
    const d1 = deferred(); let n = 0;
    const run = vi.fn(async (j: { force: boolean }) => { n++; if (n === 1) await d1.promise; return `${n}:${j.force}`; });
    const q = new CompileQueue<string>({ run, delayMs: 100 });
    const p1 = q.compileNow();
    await vi.advanceTimersByTimeAsync(0);
    const p2 = q.compileNow(); const p3 = q.compileNow();
    d1.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(await p1).toBe("1:true");
    expect(await p2).toBe("2:true");
    expect(await p3).toBe("2:true");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancel aborts the running job's signal, clears the timer and pending flag", async () => {
    let signal!: AbortSignal;
    const d = deferred();
    const run = vi.fn(async (j: { signal: AbortSignal }) => { signal = j.signal; await d.promise; return "x"; });
    const q = new CompileQueue<string>({ run, delayMs: 100 });
    q.schedule(); await vi.advanceTimersByTimeAsync(100);
    q.schedule(); await vi.advanceTimersByTimeAsync(200); // pending
    q.cancel();
    expect(signal.aborted).toBe(true);
    d.resolve(); await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(1);
    expect(q.state).toBe("idle");
    q.schedule(); await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("errors in run do not wedge the queue; state callback fires", async () => {
    const states: string[] = [];
    let n = 0;
    const run = vi.fn(async () => { n++; if (n === 1) throw new Error("boom"); return "fine"; });
    const q = new CompileQueue<string>({ run, delayMs: 10, onState: (s) => states.push(s) });
    const p = q.compileNow();
    await expect(p).rejects.toThrow("boom");
    expect(await q.compileNow()).toBe("fine");
    expect(states).toContain("running");
    expect(states[states.length - 1]).toBe("idle");
  });

  it("dispose cancels everything and ignores later schedule()", async () => {
    const run = vi.fn(async () => "x");
    const q = new CompileQueue<string>({ run, delayMs: 10 });
    q.schedule(); q.dispose();
    await vi.advanceTimersByTimeAsync(100);
    q.schedule(); await vi.advanceTimersByTimeAsync(100);
    expect(run).not.toHaveBeenCalled();
  });

  it("delay can be a function (reads live setting)", async () => {
    let delay = 100;
    const run = vi.fn(async () => "x");
    const q = new CompileQueue<string>({ run, delayMs: () => delay });
    delay = 300; q.schedule();
    await vi.advanceTimersByTimeAsync(299); expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2); expect(run).toHaveBeenCalledTimes(1);
  });
});
