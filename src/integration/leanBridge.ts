/**
 * The only door to LeanPane. Looks the API up through a getter every time (the plugin object is never kept),
 * keeps a cache of declaration statuses per Lean project, and tells listeners when anything they showed may be stale.
 * No Obsidian imports: the host supplies `getApi`.
 */
import type { DeclStatus, LeanPaneApiV1, LeanProjectInfo } from "./api-types";

export interface BridgeHost {
  /** Current LeanPane API, or null when it is absent, disabled, or of another major version */
  getApi(): LeanPaneApiV1 | null;
}

export type BridgeEvent = "availability" | "status";

/** Why there is nothing to show for a file. */
export type LeanAvailability = "ready" | "no-leanpane" | "no-project";

const FETCH_BATCH_MS = 40;

export class LeanBridge {
  private listeners = new Set<(e: BridgeEvent) => void>();
  private statuses = new Map<string, Map<string, DeclStatus>>();
  private requested = new Map<string, Set<string>>();
  private inflight = new Map<string, Set<string>>();
  private queued = new Map<string, Set<string>>();
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private projects = new Map<string, Promise<LeanProjectInfo | null>>();
  private lastApi: LeanPaneApiV1 | null = null;
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  private disposed = false;

  constructor(private host: BridgeHost) {}

  /** The API right now, or null. Never cached by callers. */
  api(): LeanPaneApiV1 | null {
    return this.disposed ? null : this.host.getApi();
  }
  available(): boolean {
    return this.api() !== null;
  }

  onChange(cb: (e: BridgeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(e: BridgeEvent) {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error("[TeXPane] lean listener failed", err);
      }
    }
  }

  /**
   * Call when LeanPane may have appeared, disappeared or been replaced (api-ready / api-unload events, layout changes).
   * Re-subscribes to status changes and drops everything cached from the previous API. Returns true when something changed.
   */
  recheck(): boolean {
    const api = this.api();
    if (api === this.lastApi) return false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lastApi = api;
    this.generation++;
    this.statuses.clear();
    this.requested.clear();
    this.inflight.clear();
    this.queued.clear();
    this.projects.clear();
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetchTimer = null;
    if (api) {
      try {
        this.unsubscribe = api.onStatusChanged((root, names) => this.statusChanged(root, names));
      } catch (e) {
        console.warn("[TeXPane] could not subscribe to LeanPane status changes", e);
      }
    }
    this.emit("availability");
    return true;
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetchTimer = null;
    this.listeners.clear();
    this.disposed = true;
  }

  // ---------------------------------------------------------------- projects
  /** Lean project for a vault path (a .tex file, or a folder given as a path inside it). Cached per API instance. */
  projectFor(vaultPath: string): Promise<LeanProjectInfo | null> {
    const api = this.api();
    if (!api) return Promise.resolve(null);
    let p = this.projects.get(vaultPath);
    if (!p) {
      const gen = this.generation;
      p = Promise.resolve()
        .then(() => api.projectForPath(vaultPath))
        .catch((e) => {
          console.warn("[TeXPane] LeanPane projectForPath failed", e);
          return null;
        })
        .then((info) => {
          // a null answer may be temporary (LeanPane still starting): do not remember it
          if (!info && gen === this.generation) this.projects.delete(vaultPath);
          return info;
        });
      this.projects.set(vaultPath, p);
    }
    return p;
  }

  // ---------------------------------------------------------------- statuses
  /** Cached status, or undefined when not (yet) known. */
  statusOf(projectRoot: string, name: string): DeclStatus | undefined {
    return this.statuses.get(projectRoot)?.get(name);
  }
  /** Map of everything known for a project (the live map; do not modify). */
  statusMap(projectRoot: string): ReadonlyMap<string, DeclStatus> {
    return this.mutableMap(projectRoot);
  }
  private mutableMap(projectRoot: string): Map<string, DeclStatus> {
    let m = this.statuses.get(projectRoot);
    if (!m) this.statuses.set(projectRoot, (m = new Map()));
    return m;
  }

  /** Make sure these names get a status soon (batched). Names already known or being fetched are skipped. */
  want(projectRoot: string, names: Iterable<string>) {
    const known = this.statuses.get(projectRoot);
    const asked = this.requested.get(projectRoot) ?? new Set<string>();
    const q = this.queued.get(projectRoot) ?? new Set<string>();
    let any = false;
    for (const n of names) {
      if (!n || known?.has(n) || asked.has(n) || q.has(n)) continue;
      q.add(n);
      any = true;
    }
    if (!any) return;
    this.queued.set(projectRoot, q);
    if (!this.fetchTimer) this.fetchTimer = setTimeout(() => void this.flush(), FETCH_BATCH_MS);
  }

  /** Fetch now and resolve when the statuses are in. `refresh` asks LeanPane to recompute instead of answering from its cache. */
  async request(projectRoot: string, names: Iterable<string>, refresh = false): Promise<void> {
    const list = [...new Set(names)].filter(Boolean);
    if (!list.length) return;
    await this.fetch(projectRoot, list, refresh);
  }

  private async flush() {
    this.fetchTimer = null;
    const batches = [...this.queued];
    this.queued.clear();
    await Promise.all(batches.map(([root, names]) => this.fetch(root, [...names], false)));
  }

  private async fetch(projectRoot: string, names: string[], refresh: boolean): Promise<void> {
    const api = this.api();
    if (!api) return;
    const gen = this.generation;
    const asked = this.requested.get(projectRoot) ?? new Set<string>();
    this.requested.set(projectRoot, asked);
    names.forEach((n) => asked.add(n));
    try {
      const res = await api.getStatus(projectRoot, names, refresh ? { refresh: true } : undefined);
      if (gen !== this.generation) return;
      const map = this.mutableMap(projectRoot);
      for (const n of names) {
        const s = res?.[n];
        map.set(n, s ?? { name: n, state: "unknown", source: "none", updatedAt: Date.now() });
      }
      this.emit("status");
    } catch (e) {
      console.warn("[TeXPane] LeanPane getStatus failed", e);
      // let a later want() try again
      for (const n of names) asked.delete(n);
    }
  }

  private statusChanged(projectRoot: string, names: string[] | "all") {
    const asked = this.requested.get(projectRoot);
    if (!asked) return;
    const wanted = names === "all" ? [...asked] : names.filter((n) => asked.has(n));
    if (!wanted.length) return;
    // keep showing the old status until the new one arrives
    void this.fetch(projectRoot, wanted, false);
  }
}
