import { describe, expect, it } from "vitest";
import { SyncGate } from "../src/integration/syncGate";
import { findLeafForFile, friendlyPath } from "../src/integration/openLeaf";

const c = (label: string, sig = "a") => ({ label, sig });

describe("SyncGate", () => {
  it("lets a state through only after it has been stable for stableMs", () => {
    const g = new SyncGate({ stableMs: 5000, minGapMs: 10000 });
    expect(g.review([c("x")], 0)).toEqual({ ready: [], wait: 5000 });
    expect(g.review([c("x")], 4000)).toEqual({ ready: [], wait: 1000 });
    expect(g.review([c("x")], 5000).ready).toEqual([c("x")]);
  });
  it("a changed signature or a disappearing candidate restarts the timer", () => {
    const g = new SyncGate({ stableMs: 5000, minGapMs: 0 });
    g.review([c("x", "a")], 0);
    expect(g.review([c("x", "b")], 4000).ready).toEqual([]);
    expect(g.review([c("x", "b")], 8000).ready).toEqual([]);
    g.review([], 8500); // flipped back to no mismatch
    expect(g.review([c("x", "b")], 9000).ready).toEqual([]);
    expect(g.review([c("x", "b")], 14000).ready.length).toBe(1);
  });
  it("never acts twice on a label within minGapMs", () => {
    const g = new SyncGate({ stableMs: 1000, minGapMs: 10000 });
    g.review([c("x")], 0);
    expect(g.review([c("x")], 1000).ready.length).toBe(1);
    g.markActed("x", 1000);
    g.review([c("x", "b")], 2000);
    expect(g.review([c("x", "b")], 4000)).toEqual({ ready: [], wait: 7000 });
    expect(g.review([c("x", "b")], 11000).ready.length).toBe(1);
  });
  it("labels are independent", () => {
    const g = new SyncGate({ stableMs: 1000, minGapMs: 0 });
    g.review([c("x")], 0);
    const r = g.review([c("x"), c("y")], 1500);
    expect(r.ready.map((k) => k.label)).toEqual(["x"]);
    expect(r.wait).toBe(1000);
  });
});

describe("findLeafForFile", () => {
  const mk = (file: string | null, live = false) => {
    const log: string[] = [];
    return {
      log,
      view: live ? { file: { path: file! } } : {},
      getViewState: () => ({ state: { file } }),
      loadIfDeferred: async () => void log.push("load"),
      setEphemeralState() {},
    };
  };
  it("prefers a loaded view, then a deferred leaf (which gets loaded)", async () => {
    const live = mk("a.tex", true);
    const def = mk("b.tex");
    expect(await findLeafForFile([def, live], "a.tex")).toEqual({ leaf: live, deferred: false });
    const r = await findLeafForFile([live, def], "b.tex");
    expect(r?.deferred).toBe(true);
    expect(def.log).toEqual(["load"]);
    expect(live.log).toEqual([]);
    expect(await findLeafForFile([live, def], "c.tex")).toBeNull();
  });
});

describe("friendlyPath", () => {
  it("makes absolute paths inside the vault vault-relative and leaves the rest alone", () => {
    expect(friendlyPath("/v/lean/A.lean", "/v")).toBe("lean/A.lean");
    expect(friendlyPath("/v2/lean/A.lean", "/v")).toBe("/v2/lean/A.lean");
    expect(friendlyPath("lean/A.lean", "/v")).toBe("lean/A.lean");
    expect(friendlyPath("/out/B.lean", "/v")).toBe("/out/B.lean");
    expect(friendlyPath("C:\\v\\lean\\A.lean", "C:\\v")).toBe("lean/A.lean");
  });
});
