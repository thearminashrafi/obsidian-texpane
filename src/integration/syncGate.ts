/**
 * Hysteresis for "Sync \leanok automatically": a fix is only applied once the situation it answers has been the same
 * for `stableMs`, and a label is never rewritten more than once per `minGapMs`. While the user edits Lean a declaration
 * can flip stated <-> proved many times; without this the .tex would be rewritten on every flip. Pure; time is passed in.
 */
export interface SyncCandidate {
  label: string;
  /** What the fix answers (e.g. the mismatch kind); a different value restarts the stability timer */
  sig: string;
}

export interface SyncTiming {
  stableMs: number;
  minGapMs: number;
}

export const DEFAULT_SYNC_TIMING: SyncTiming = { stableMs: 5000, minGapMs: 10000 };

export class SyncGate {
  private seen = new Map<string, { sig: string; since: number }>();
  private acted = new Map<string, number>();

  constructor(public timing: SyncTiming = { ...DEFAULT_SYNC_TIMING }) {}

  /**
   * Observe the current candidates. Returns the ones that may be acted on now, and `wait`: ms until the earliest
   * remaining one may be (null when nothing is waiting), so the caller can look again then.
   */
  review(candidates: readonly SyncCandidate[], now: number): { ready: SyncCandidate[]; wait: number | null } {
    const live = new Set(candidates.map((c) => c.label));
    for (const k of [...this.seen.keys()]) if (!live.has(k)) this.seen.delete(k);
    const ready: SyncCandidate[] = [];
    let wait: number | null = null;
    for (const c of candidates) {
      let e = this.seen.get(c.label);
      if (!e || e.sig !== c.sig) this.seen.set(c.label, (e = { sig: c.sig, since: now }));
      const lastAct = this.acted.get(c.label);
      const due = Math.max(e.since + this.timing.stableMs, lastAct === undefined ? 0 : lastAct + this.timing.minGapMs);
      if (now >= due) ready.push(c);
      else wait = wait === null ? due - now : Math.min(wait, due - now);
    }
    return { ready, wait };
  }

  /** The fix for this label was applied. */
  markActed(label: string, now: number) {
    this.acted.set(label, now);
    this.seen.delete(label);
  }

  clear() {
    this.seen.clear();
    this.acted.clear();
  }
}
