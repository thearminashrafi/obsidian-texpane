export type QueueState = "idle" | "scheduled" | "running" | "queued";
export interface CompileJob {
  force: boolean;
  signal: AbortSignal;
}
export interface CompileQueueOptions<R> {
  run(job: CompileJob): Promise<R>;
  delayMs: number | (() => number);
  onState?(state: QueueState): void;
}

interface Waiter<R> {
  resolve(v: R): void;
  reject(e: unknown): void;
}

/** Debounced, single-flight queue: at most one running job and one queued follow-up. */
export class CompileQueue<R> {
  state: QueueState = "idle";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pending = false;
  private pendingForce = false;
  private pendingWaiters: Waiter<R>[] = [];
  private abort: AbortController | null = null;
  private disposed = false;

  constructor(private opts: CompileQueueOptions<R>) {}

  private set(s: QueueState) {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState?.(s);
  }
  private delay(): number {
    return typeof this.opts.delayMs === "function" ? this.opts.delayMs() : this.opts.delayMs;
  }
  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.request(false, null);
    }, this.delay());
    if (!this.running) this.set("scheduled");
  }

  compileNow(): Promise<R> {
    if (this.disposed) return Promise.reject(new Error("disposed"));
    this.clearTimer();
    return new Promise<R>((resolve, reject) => this.request(true, { resolve, reject }));
  }

  private request(force: boolean, waiter: Waiter<R> | null) {
    if (this.running) {
      this.pending = true;
      this.pendingForce ||= force;
      if (waiter) this.pendingWaiters.push(waiter);
      this.set("queued");
      return;
    }
    void this.start(force, waiter ? [waiter] : []);
  }

  private async start(force: boolean, waiters: Waiter<R>[]) {
    this.running = true;
    this.abort = new AbortController();
    this.set("running");
    let result: R | undefined;
    let error: unknown;
    let failed = false;
    try {
      result = await this.opts.run({ force, signal: this.abort.signal });
    } catch (e) {
      failed = true;
      error = e;
    }
    this.running = false;
    this.abort = null;
    for (const w of waiters) (failed ? w.reject(error) : w.resolve(result as R));
    if (this.pending && !this.disposed) {
      const f = this.pendingForce;
      const ws = this.pendingWaiters;
      this.pending = false;
      this.pendingForce = false;
      this.pendingWaiters = [];
      void this.start(f, ws);
    } else {
      this.set(this.timer ? "scheduled" : "idle");
    }
  }

  cancel(): void {
    this.clearTimer();
    this.pending = false;
    this.pendingForce = false;
    const ws = this.pendingWaiters;
    this.pendingWaiters = [];
    for (const w of ws) w.reject(new Error("cancelled"));
    this.abort?.abort();
    if (!this.running) this.set("idle");
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }
}
