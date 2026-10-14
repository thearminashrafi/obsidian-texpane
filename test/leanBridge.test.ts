import { describe, it, expect, vi } from "vitest";
import { API_VERSION, getLeanPaneApi, type DeclStatus, type LeanPaneApiV1, type LeanProjectInfo } from "../src/integration/api-types";
import { LeanBridge } from "../src/integration/leanBridge";

const flush = (ms = 70) => new Promise((r) => setTimeout(r, ms));

function fakeApi(over: Partial<LeanPaneApiV1> = {}) {
  const listeners = new Set<(root: string, names: string[] | "all") => void>();
  const calls = { getStatus: [] as Array<[string, string[], unknown]>, projectForPath: [] as string[] };
  const states: Record<string, DeclStatus["state"]> = { A: "proved", B: "stated" };
  const api: LeanPaneApiV1 = {
    version: 1,
    async projectForPath(p) {
      calls.projectForPath.push(p);
      return p.startsWith("Proj/") ? ({ root: "Proj", absRoot: "/v/Proj", toolchain: "v4.25.1", usesMathlib: false } as LeanProjectInfo) : null;
    },
    async getStatus(root, names, opts) {
      calls.getStatus.push([root, names, opts]);
      return Object.fromEntries(names.filter((n) => n in states).map((n) => [n, { name: n, state: states[n], source: "live", updatedAt: 1, signature: `${n} : Prop` } as DeclStatus]));
    },
    async listDeclarations() {
      return [];
    },
    async openDeclaration() {
      return true;
    },
    async createStub() {
      return { file: "x.lean", line: 1 };
    },
    onStatusChanged(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    ...over,
  };
  return { api, calls, listeners, states };
}

describe("getLeanPaneApi (feature detection)", () => {
  const app = (plugin: unknown) => ({ plugins: { plugins: { leanpane: plugin } } });
  it("finds the API of an enabled plugin with version 1", () => {
    const { api } = fakeApi();
    expect(getLeanPaneApi(app({ api }))).toBe(api);
  });
  it("is null when the plugin is absent, has no api yet, or another version", () => {
    expect(getLeanPaneApi({})).toBeNull();
    expect(getLeanPaneApi(app(undefined))).toBeNull();
    expect(getLeanPaneApi(app({}))).toBeNull();
    expect(getLeanPaneApi(app({ api: { version: 2 } }))).toBeNull();
    expect(getLeanPaneApi(undefined)).toBeNull();
    expect(API_VERSION).toBe(1);
  });
  it("reads the plugin through the app every time (never caches the plugin object)", () => {
    const a = fakeApi().api;
    const host: { plugins: { plugins: Record<string, unknown> } } = { plugins: { plugins: { leanpane: { api: a } } } };
    expect(getLeanPaneApi(host)).toBe(a);
    delete host.plugins.plugins.leanpane; // disabled
    expect(getLeanPaneApi(host)).toBeNull();
    const b = fakeApi().api;
    host.plugins.plugins.leanpane = { api: b }; // enabled again, new object
    expect(getLeanPaneApi(host)).toBe(b);
  });
});

describe("LeanBridge", () => {
  it("recheck follows the API appearing, disappearing and being replaced", () => {
    let current: LeanPaneApiV1 | null = null;
    const bridge = new LeanBridge({ getApi: () => current });
    const events: string[] = [];
    bridge.onChange((e) => events.push(e));
    expect(bridge.available()).toBe(false);
    expect(bridge.recheck()).toBe(false);
    const a = fakeApi();
    current = a.api;
    expect(bridge.available()).toBe(true);
    expect(bridge.recheck()).toBe(true);
    expect(a.listeners.size).toBe(1); // subscribed to status changes
    expect(bridge.recheck()).toBe(false);
    current = null;
    expect(bridge.recheck()).toBe(true);
    expect(a.listeners.size).toBe(0); // unsubscribed from the old API
    const b = fakeApi();
    current = b.api;
    bridge.recheck();
    expect(b.listeners.size).toBe(1);
    expect(events).toEqual(["availability", "availability", "availability"]);
  });

  it("projectFor asks LeanPane once, and forgets a null answer", async () => {
    const a = fakeApi();
    const bridge = new LeanBridge({ getApi: () => a.api });
    bridge.recheck();
    expect((await bridge.projectFor("Proj/blueprint/src/print.tex"))?.root).toBe("Proj");
    await bridge.projectFor("Proj/blueprint/src/print.tex");
    expect(a.calls.projectForPath.length).toBe(1);
    expect(await bridge.projectFor("Other/x.tex")).toBeNull();
    await bridge.projectFor("Other/x.tex");
    expect(a.calls.projectForPath.length).toBe(3);
  });

  it("projectFor is null without LeanPane and survives a throwing API", async () => {
    expect(await new LeanBridge({ getApi: () => null }).projectFor("x.tex")).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = fakeApi({ projectForPath: async () => { throw new Error("boom"); } });
    expect(await new LeanBridge({ getApi: () => a.api }).projectFor("x.tex")).toBeNull();
    warn.mockRestore();
  });

  it("want() batches names into one getStatus call and caches the answers", async () => {
    const a = fakeApi();
    const bridge = new LeanBridge({ getApi: () => a.api });
    bridge.recheck();
    const events: string[] = [];
    bridge.onChange((e) => events.push(e));
    bridge.want("Proj", ["A"]);
    bridge.want("Proj", ["B", "A", "Nope"]);
    expect(bridge.statusOf("Proj", "A")).toBeUndefined();
    await flush();
    expect(a.calls.getStatus).toEqual([["Proj", ["A", "B", "Nope"], undefined]]);
    expect(bridge.statusOf("Proj", "A")?.state).toBe("proved");
    expect(bridge.statusOf("Proj", "A")?.signature).toBe("A : Prop");
    expect(bridge.statusOf("Proj", "Nope")?.state).toBe("unknown"); // not in the answer
    expect(events).toContain("status");
    bridge.want("Proj", ["A", "B"]); // known: no new call
    await flush();
    expect(a.calls.getStatus.length).toBe(1);
  });

  it("request() fetches now, with refresh when asked", async () => {
    const a = fakeApi();
    const bridge = new LeanBridge({ getApi: () => a.api });
    bridge.recheck();
    await bridge.request("Proj", ["A", "B"], true);
    expect(a.calls.getStatus).toEqual([["Proj", ["A", "B"], { refresh: true }]]);
    expect(bridge.statusMap("Proj").size).toBe(2);
  });

  it("onStatusChanged refetches only names that were asked for, and 'all'", async () => {
    const a = fakeApi();
    const bridge = new LeanBridge({ getApi: () => a.api });
    bridge.recheck();
    await bridge.request("Proj", ["A", "B"]);
    a.calls.getStatus.length = 0;
    a.states.A = "stated";
    [...a.listeners].forEach((l) => l("Proj", ["A", "Z"]));
    await flush(10);
    expect(a.calls.getStatus.map((c) => c[1])).toEqual([["A"]]);
    expect(bridge.statusOf("Proj", "A")?.state).toBe("stated");
    [...a.listeners].forEach((l) => l("Proj", "all"));
    await flush(10);
    expect(a.calls.getStatus.at(-1)![1]).toEqual(["A", "B"]);
    [...a.listeners].forEach((l) => l("OtherProject", "all"));
    await flush(10);
    expect(a.calls.getStatus.length).toBe(2);
  });

  it("drops everything when the API goes away or is replaced, and ignores late answers", async () => {
    let resolve!: (v: Record<string, DeclStatus>) => void;
    const slow = fakeApi({ getStatus: () => new Promise((r) => (resolve = r)) });
    let current: LeanPaneApiV1 | null = slow.api;
    const bridge = new LeanBridge({ getApi: () => current });
    bridge.recheck();
    const pending = bridge.request("Proj", ["A"]);
    current = null;
    bridge.recheck();
    resolve({ A: { name: "A", state: "proved", source: "live", updatedAt: 1 } });
    await pending;
    expect(bridge.statusOf("Proj", "A")).toBeUndefined();
    expect(bridge.api()).toBeNull();
  });

  it("a failing getStatus is retried by a later want()", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let fail = true;
    const a = fakeApi();
    const base = a.api.getStatus.bind(a.api);
    a.api.getStatus = async (r, n, o) => {
      if (fail) throw new Error("lean not ready");
      return base(r, n, o);
    };
    const bridge = new LeanBridge({ getApi: () => a.api });
    bridge.recheck();
    bridge.want("Proj", ["A"]);
    await flush();
    expect(bridge.statusOf("Proj", "A")).toBeUndefined();
    fail = false;
    bridge.want("Proj", ["A"]);
    await flush();
    expect(bridge.statusOf("Proj", "A")?.state).toBe("proved");
    warn.mockRestore();
  });

  it("dispose silences everything", () => {
    const a = fakeApi();
    const bridge = new LeanBridge({ getApi: () => a.api });
    bridge.recheck();
    bridge.dispose();
    expect(bridge.available()).toBe(false);
    expect(a.listeners.size).toBe(0);
  });
});
