// The Obsidian-facing glue (LeanIntegration) against a fake Obsidian and a FAKE LeanPane API.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { TFile } from "obsidian";
import type { DeclState, DeclStatus, LeanPaneApiV1, LeanProjectInfo } from "../src/integration/api-types";
import type { Diagnostic } from "../src/types";

(globalThis as unknown as { window: unknown }).window = globalThis;

let LeanIntegration: typeof import("../src/integration/leanIntegration").LeanIntegration;
beforeAll(async () => {
  ({ LeanIntegration } = await import("../src/integration/leanIntegration"));
});

const notices = () => (globalThis as unknown as { __notices?: string[] }).__notices ?? [];
const BASE = "/vault";
const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function mkFile(path: string): TFile {
  const f = new TFile();
  f.path = path;
  f.extension = path.split(".").pop()!;
  return f;
}

class FakeVault {
  files = new Map<string, { file: TFile; text: string }>();
  put(path: string, text: string) {
    this.files.set(path, { file: mkFile(path), text });
  }
  getAbstractFileByPath(p: string) {
    return this.files.get(p)?.file ?? null;
  }
  async cachedRead(f: TFile) {
    return this.files.get(f.path)!.text;
  }
  async process(f: TFile, fn: (t: string) => string) {
    const e = this.files.get(f.path)!;
    e.text = fn(e.text);
    return e.text;
  }
  getFiles() {
    return [...this.files.values()].map((e) => e.file);
  }
}

class FakeView {
  diags: Diagnostic[] = [];
  refreshes = 0;
  state: EditorState;
  revealed: number[] = [];
  constructor(public file: TFile, text: string, private rootAbs: string) {
    this.state = EditorState.create({ doc: text });
  }
  leaf: { view: FakeView; getViewState(): { state: { file: string } }; setEphemeralState(s: unknown): void; ephemeral: unknown[] } = {
    view: this,
    getViewState: () => ({ state: { file: this.file.path } }),
    setEphemeralState: (st: unknown) => void this.leaf.ephemeral.push(st),
    ephemeral: [],
  };
  getViewData() {
    return this.state.doc.toString();
  }
  getSession() {
    return { project: { rootAbsPath: this.rootAbs } };
  }
  getEditor() {
    const self = this;
    return {
      get state() {
        return self.state;
      },
      dispatch(spec: { changes: never }) {
        self.state = self.state.update({ changes: spec.changes }).state;
      },
    };
  }
  isTex() {
    return true;
  }
  setLeanDiagnostics(d: Diagnostic[]) {
    this.diags = d;
  }
  refreshLean() {
    this.refreshes++;
  }
  revealLine(l: number) {
    this.revealed.push(l);
  }
}

const TEX = [
  "% !LEAN project = ../lean", // 1
  "\\documentclass{article}", // 2
  "\\begin{document}", // 3
  "\\begin{lemma}\\label{lem:a}\\lean{Foo.a}\\end{lemma}", // 4
  "\\begin{proof}", // 5
  "  \\leanok", // 6
  "  Easy.", // 7
  "\\end{proof}", // 8
  "\\begin{lemma}\\label{lem:b}\\lean{Foo.b}\\end{lemma}", // 9
  "\\begin{proof}", // 10
  "  Hard.", // 11
  "\\end{proof}", // 12
  "\\begin{lemma}\\label{lem:c}\\lean{Foo.c}\\end{lemma}", // 13
  "\\begin{proof}Hmm.\\end{proof}", // 14
  "\\end{document}", // 15
].join("\n");

function setup(opts: { states?: Record<string, DeclState>; syncLeanok?: boolean; present?: boolean } = {}) {
  const states: Record<string, DeclState> = { "Foo.a": "stated", "Foo.b": "proved", "Foo.c": "missing", ...(opts.states ?? {}) };
  const vault = new FakeVault();
  vault.put("bp/main.tex", TEX);
  vault.put("lean/Foo.lean", "theorem Foo.a : True := sorry\n");
  const stubs: Array<{ root: string; req: { file: string; name: string; docstring: string } }> = [];
  const opened: string[] = [];
  const openOpts: unknown[] = [];
  const calls = { list: 0, listDelay: 0, status: 0 };
  const handlers = new Map<string, Array<() => void>>();
  const deferredLeaves: unknown[] = [];
  const statusListeners = new Set<(r: string, n: string[] | "all") => void>();
  const api: LeanPaneApiV1 = {
    version: 1,
    async projectForPath(p) {
      return p.startsWith("lean/") ? ({ root: "lean", absRoot: BASE + "/lean", toolchain: "v4.25.1", usesMathlib: false } as LeanProjectInfo) : null;
    },
    async getStatus(_root, names) {
      calls.status++;
      return Object.fromEntries(names.map((n) => [n, { name: n, state: states[n] ?? "unknown", source: "live", updatedAt: 1 } as DeclStatus]));
    },
    async listDeclarations() {
      calls.list++;
      if (calls.listDelay) await flush(calls.listDelay);
      return [{ name: "Foo.a", kind: "theorem", file: "lean/Foo.lean", line: 1 }];
    },
    async openDeclaration(_r, n, o) {
      opened.push(n);
      openOpts.push(o);
      return true;
    },
    async createStub(root, req) {
      stubs.push({ root, req });
      return { file: req.file, line: 7 };
    },
    onStatusChanged(cb) {
      statusListeners.add(cb);
      return () => void statusListeners.delete(cb);
    },
  };
  const views: FakeView[] = [];
  const plugin = {
    app: { vault, plugins: { plugins: { leanpane: opts.present === false ? undefined : { api } } }, workspace: { on: (name: string, cb: () => void) => (handlers.set(name, [...(handlers.get(name) ?? []), cb]), {}), getLeaf: () => ({ openFile: async () => undefined }), setActiveLeaf() {} } },
    settings: { syncLeanok: opts.syncLeanok ?? false },
    notes: { basePath: () => BASE },
    latexViews: () => views,
    latexLeaves: () => [...deferredLeaves, ...views.map((v) => v.leaf)],
    projects: () => [{ root: "bp", main: "bp/main.tex", name: "bp", files: ["bp/main.tex"] }],
    registerEvent: () => undefined,
    activeLatexView: () => views[0] ?? null,
    ensureFolder: async () => undefined,
  };
  const integ = new LeanIntegration(plugin as never);
  const fire = (name: string) => (handlers.get(name) ?? []).forEach((h) => h());
  return { integ, vault, views, api, stubs, opened, openOpts, calls, states, plugin, fire, deferredLeaves };
}

function openView(ctx: ReturnType<typeof setup>) {
  const f = ctx.vault.getAbstractFileByPath("bp/main.tex") as TFile;
  const v = new FakeView(f, TEX, BASE + "/bp/main.tex");
  ctx.views.push(v);
  return v;
}

describe("LeanIntegration: project lookup", () => {
  it("honours the % !LEAN project magic comment relative to the root file", async () => {
    const c = setup();
    const info = await c.integ.lookupProject("bp/main.tex");
    expect(info?.root).toBe("lean");
  });
  it("without the comment it asks LeanPane about the file itself", async () => {
    const c = setup();
    c.vault.put("lean/blueprint/main.tex", "\\documentclass{article}");
    expect((await c.integ.lookupProject("lean/blueprint/main.tex"))?.root).toBe("lean");
    c.vault.put("other/main.tex", "\\documentclass{article}");
    expect(await c.integ.lookupProject("other/main.tex")).toBeNull();
  });
  it("is null without LeanPane", async () => {
    const c = setup({ present: false });
    expect(c.integ.available()).toBe(false);
    expect(await c.integ.lookupProject("bp/main.tex")).toBeNull();
  });
});

describe("LeanIntegration: mismatch diagnostics for a view", () => {
  it("reports \\leanok vs Lean and missing names, with working quick fixes", async () => {
    const c = setup();
    const v = openView(c);
    c.integ.start();
    c.integ.attachView(v as never);
    await flush(400);
    const msgs = v.diags.map((d) => [d.line, d.message.replace(/\s+/g, " ")]);
    expect(msgs.map((m) => m[0]).sort((a, b) => (a as number) - (b as number))).toEqual([6, 10, 13]);
    const ok = v.diags.find((d) => d.line === 6)!;
    expect(ok).toMatchObject({ severity: "warning", source: "lean", file: BASE + "/bp/main.tex", col: 2, endCol: 9 });
    expect(ok.fixes!.map((f) => f.label)).toEqual(["Remove \\leanok"]);
    const noOk = v.diags.find((d) => d.line === 10)!;
    expect(noOk.fixes!.map((f) => f.label)).toEqual(["Add \\leanok"]);
    const missing = v.diags.find((d) => d.line === 13)!;
    expect(missing.fixes).toBeUndefined();
    expect(missing.message).toContain("Foo.c");

    await noOk.fixes![0].run();
    expect(v.getViewData().split("\n").slice(9, 12)).toEqual(["\\begin{proof}", "  \\leanok", "  Hard."]);
    await ok.fixes![0].run();
    expect(v.getViewData()).not.toContain("  \\leanok\n  Easy.");
    expect(v.getViewData().split("\n")[4]).toBe("\\begin{proof}");
    c.integ.dispose();
  });

  it("clears them again when LeanPane goes away", async () => {
    const c = setup();
    const v = openView(c);
    c.integ.start();
    c.integ.attachView(v as never);
    await flush(400);
    expect(v.diags.length).toBe(3);
    (c.plugin.app.plugins.plugins as Record<string, unknown>).leanpane = undefined;
    c.integ.recheck();
    await flush(400);
    expect(v.diags).toEqual([]);
    expect(c.integ.available()).toBe(false);
    c.integ.dispose();
  });

  it("'Sync \\leanok automatically' applies the safe fixes by itself, and only when on", async () => {
    const off = setup();
    const v1 = openView(off);
    off.integ.start();
    off.integ.attachView(v1 as never);
    await flush(400);
    expect(v1.getViewData()).toBe(TEX);
    off.integ.dispose();

    const on = setup({ syncLeanok: true });
    on.integ.syncGate.timing = { stableMs: 50, minGapMs: 0 };
    const v2 = openView(on);
    on.integ.start();
    on.integ.attachView(v2 as never);
    await flush(400);
    const t = v2.getViewData().split("\n");
    expect(t.slice(4, 8)).toEqual(["\\begin{proof}", "  Easy.", "\\end{proof}", "\\begin{lemma}\\label{lem:b}\\lean{Foo.b}\\end{lemma}"]);
    expect(v2.getViewData()).toContain("\\begin{proof}\n  \\leanok\n  Hard.");
    // and it settles: nothing flips back and forth afterwards
    const settled = v2.getViewData();
    await flush(1500);
    expect(v2.getViewData()).toBe(settled);
    on.integ.dispose();
  });

  it("applies edits to files that are not open (through the vault)", async () => {
    const c = setup();
    await c.integ.applyEdits([{ file: "bp/main.tex", line: 9, op: "insert-after", text: "\\leanok" }]);
    expect(c.vault.files.get("bp/main.tex")!.text.split("\n")[9]).toBe("\\leanok");
  });
});

describe("LeanIntegration: chips and completion hosts", () => {
  it("chip host goes from pending to ready and fetches the status of the names it is asked about", async () => {
    const c = setup();
    const v = openView(c);
    c.integ.start();
    c.integ.attachView(v as never);
    const host = c.integ.chipHost(v as never);
    expect(host.availability()).toBe("pending");
    await flush(30);
    expect(host.availability()).toBe("ready");
    expect(host.status("Foo.b")).toBeUndefined();
    await flush(120);
    expect(host.status("Foo.b")?.state).toBe("proved");
    host.open("Foo.b", false);
    await flush(10);
    expect(c.opened).toEqual(["Foo.b"]);
    c.integ.dispose();
  });
  it("chip host says no-leanpane / no-project", async () => {
    const none = setup({ present: false });
    expect(none.integ.chipHost(openView(none) as never).availability()).toBe("no-leanpane");
    const c = setup();
    c.vault.put("elsewhere/x.tex", "\\documentclass{article}");
    const f = c.vault.getAbstractFileByPath("elsewhere/x.tex") as TFile;
    const v = new FakeView(f, "x", BASE + "/elsewhere/x.tex");
    c.views.push(v);
    c.integ.attachView(v as never);
    const host = c.integ.chipHost(v as never);
    host.availability();
    await flush(30);
    expect(host.availability()).toBe("no-project");
  });
  it("completion host lists declarations, and is null without LeanPane", async () => {
    const c = setup();
    const v = openView(c);
    const r = await c.integ.completionHost(v as never).declarations("Fo");
    expect(r).toEqual({ items: [{ name: "Foo.a", kind: "theorem", file: "lean/Foo.lean", line: 1 }], complete: true });
    const none = setup({ present: false });
    expect(none.integ.completionHost(openView(none) as never).declarations("")).toBeNull();
  });
});

describe("LeanIntegration: Formalize this", () => {
  it("creates the stub with the statement as docstring and links it after \\label", async () => {
    const c = setup();
    const v = openView(c);
    v.state = EditorState.create({ doc: "\\begin{lemma}[Bound]\n  \\label{lem:bound}\n  For all $n$, $n \\le n$.\n\\end{lemma}\n" });
    const info = { root: "lean", absRoot: BASE + "/lean", toolchain: "v4.25.1", usesMathlib: false };
    await (c.integ as unknown as { createAndLink(v: unknown, i: unknown, l: string, n: string, f: string): Promise<void> }).createAndLink(v, info, "lem:bound", "lem_bound", "lean/Foo.lean");
    expect(c.stubs).toEqual([{ root: "lean", req: { file: "lean/Foo.lean", name: "lem_bound", docstring: "Bound\n\nFor all $n$, $n \\le n$." } }]);
    expect(v.getViewData().split("\n").slice(0, 3)).toEqual(["\\begin{lemma}[Bound]", "  \\label{lem:bound}", "  \\lean{lem_bound}"]);
  });
  it("finds the statement under the cursor (statement or its proof)", () => {
    const c = setup();
    const v = openView(c);
    const at = (line: number) => {
      v.state = EditorState.create({ doc: TEX, selection: { anchor: TEX.split("\n").slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0) } });
      return c.integ.nodeAtCursor(v as never)?.node.label ?? null;
    };
    expect(at(4)).toBe("lem:a");
    expect(at(7)).toBe("lem:a"); // inside its proof
    expect(at(2)).toBeNull();
    expect(at(15)).toBeNull();
  });
  it("a failing LeanPane createStub leaves the LaTeX untouched and tells the user", async () => {
    const c = setup();
    const v = openView(c);
    c.api.createStub = async () => {
      throw new Error("read-only");
    };
    const info = { root: "lean", absRoot: BASE + "/lean", toolchain: "v4.25.1", usesMathlib: false };
    await (c.integ as unknown as { createAndLink(v: unknown, i: unknown, l: string, n: string, f: string): Promise<void> }).createAndLink(v, info, "lem:b", "lem_b", "lean/Foo.lean");
    expect(v.getViewData()).toBe(TEX);
    expect(notices().at(-1)).toContain("read-only");
  });
});

describe("TeXPane API v1 (for LeanPane)", () => {
  it("has version 1 and the four functions", () => {
    const { integ } = setup();
    expect(integ.api.version).toBe(1);
    expect(Object.keys(integ.api).sort()).toEqual(["addBlueprintEntry", "blueprintRefs", "onBlueprintChanged", "openLocation", "version"]);
  });
  it("blueprintRefs finds the nodes mentioning a Lean name across projects", async () => {
    const c = setup();
    const refs = await c.integ.api.blueprintRefs("Foo.a");
    expect(refs).toEqual([{ file: "bp/main.tex", line: 4, label: "lem:a", env: "lemma", title: undefined, leanok: true }]);
    expect((await c.integ.api.blueprintRefs("Foo.b"))[0].leanok).toBe(false);
    expect(await c.integ.api.blueprintRefs("Nope")).toEqual([]);
  });
  it("addBlueprintEntry writes into a closed file and into an open editor", async () => {
    const c = setup();
    const r = await c.integ.api.addBlueprintEntry({ texFile: "bp/main.tex", env: "theorem", label: "thm:new", leanName: "Foo.new", statement: "New statement." });
    const text = c.vault.files.get("bp/main.tex")!.text;
    expect(text.split("\n")[r.line - 1]).toBe("\\begin{theorem}");
    expect(text.indexOf("\\label{thm:new}")).toBeLessThan(text.indexOf("\\end{document}"));
    const v = openView(c);
    v.state = EditorState.create({ doc: text });
    const r2 = await c.integ.api.addBlueprintEntry({ texFile: "bp/main.tex", env: "lemma", label: "lem:new2", leanName: "Foo.new2", statement: "S" });
    expect(v.getViewData().split("\n")[r2.line - 1]).toBe("\\begin{lemma}");
    await expect(c.integ.api.addBlueprintEntry({ texFile: "nope.tex", env: "lemma", label: "x", leanName: "y", statement: "" })).rejects.toThrow();
  });
  it("onBlueprintChanged fires when the blueprint cache is invalidated, and unsubscribes", async () => {
    const c = setup();
    c.integ.start();
    let n = 0;
    const off = c.integ.api.onBlueprintChanged(() => n++);
    c.integ.store.invalidate();
    expect(n).toBe(1);
    off();
    c.integ.store.invalidate();
    expect(n).toBe(1);
    c.integ.dispose();
  });
  it("openLocation reveals the line in an open view", async () => {
    const c = setup();
    const v = openView(c);
    await c.integ.api.openLocation("bp/main.tex", 9);
    expect(v.revealed).toEqual([9]);
  });
  it("panelData builds the graph with Lean statuses", async () => {
    const c = setup();
    openView(c);
    const d = await c.integ.panelData("bp/main.tex");
    expect(d.info?.root).toBe("lean");
    expect(d.graph.map((n) => [n.id, n.status])).toEqual([["lem:a", "stated"], ["lem:b", "proved"], ["lem:c", "missing"]]);
  });
});

describe("LeanPane api events", () => {
  it("api-unload: LeanPane is gone at once, without looking the API up again, and everything is cleared", async () => {
    const c = setup();
    const v = openView(c);
    c.integ.start();
    c.integ.attachView(v as never);
    await flush(400);
    expect(v.diags.length).toBe(3);
    // from now on count every lookup of the plugin object
    let reads = 0;
    const plugins = c.plugin.app.plugins.plugins as Record<string, unknown>;
    const lp = plugins.leanpane;
    Object.defineProperty(plugins, "leanpane", { get: () => (reads++, lp) });
    c.fire("leanpane:api-unload");
    expect(reads).toBe(0);
    // the plugin object still lists the api, yet:
    expect(c.integ.available()).toBe(false);
    expect(v.diags).toEqual([]);
    expect(c.integ.chipHost(v as never).availability()).toBe("no-leanpane");
    expect(c.integ.completionHost(v as never).declarations("")).toBeNull();
    // a layout change while it is still half unloaded does not bring it back
    c.integ.recheck();
    expect(c.integ.available()).toBe(false);
    await flush(300);
    expect(v.diags).toEqual([]);
    c.integ.dispose();
  });

  it("api-ready is handled deferred, and retried once after ~200 ms when the API is not visible yet", async () => {
    const c = setup();
    c.integ.start();
    const plugins = c.plugin.app.plugins.plugins as Record<string, unknown>;
    const lp = plugins.leanpane;
    c.fire("leanpane:api-unload");
    expect(c.integ.available()).toBe(false);
    // ready fires; the plugin object does not expose the api yet
    plugins.leanpane = undefined;
    c.fire("leanpane:api-ready");
    expect(c.integ.available()).toBe(false); // nothing happens synchronously
    await flush(30);
    expect(c.integ.available()).toBe(false);
    plugins.leanpane = lp; // appears a bit later
    await flush(250);
    expect(c.integ.available()).toBe(true);
    c.integ.dispose();
  });

  it("api-ready with the API already visible picks it up on the next tick", async () => {
    const c = setup();
    c.integ.start();
    c.fire("leanpane:api-unload");
    c.fire("leanpane:api-ready");
    expect(c.integ.available()).toBe(false);
    await flush(20);
    expect(c.integ.available()).toBe(true);
    c.integ.dispose();
  });
});

describe("declaration completion: one query in flight", () => {
  it("concurrent callers share one listDeclarations call; the result is cached for the TTL", async () => {
    const c = setup();
    c.calls.listDelay = 40;
    const host = c.integ.completionHost(openView(c) as never);
    const rs = await Promise.all([host.declarations("F")!, host.declarations("Fo")!, host.declarations("Foo")!]);
    expect(c.calls.list).toBe(1);
    expect(rs.every((r) => r.items.length === 1)).toBe(true);
    await host.declarations("Foo");
    expect(c.calls.list).toBe(1);
    c.integ.dispose();
  });
  it("a failed query is not remembered", async () => {
    const c = setup();
    const ok = c.api.listDeclarations;
    c.api.listDeclarations = async () => {
      throw new Error("boom");
    };
    const host = c.integ.completionHost(openView(c) as never);
    await expect(host.declarations("F")!).rejects.toThrow("boom");
    c.api.listDeclarations = ok;
    expect((await host.declarations("F")!).items.length).toBe(1);
  });
});

describe("line-addressed edits are verified", () => {
  it("applyEdits skips an edit whose line no longer holds the expected text", async () => {
    const c = setup();
    const v = openView(c);
    const n = await c.integ.applyEdits([
      { file: "bp/main.tex", line: 6, op: "remove-token", token: "\\leanok", expect: "something else" },
      { file: "bp/main.tex", line: 5, op: "insert-after", text: "X", expect: "\\begin{nope}" },
    ]);
    expect(n).toBe(0);
    expect(v.getViewData()).toBe(TEX);
    expect(await c.integ.applyEdits([{ file: "bp/main.tex", line: 6, op: "remove-token", token: "\\leanok", expect: "\\leanok" }])).toBe(1);
  });

  it("Formalize this: the \\label is found again after createStub (the user kept typing)", async () => {
    const c = setup();
    const v = openView(c);
    v.state = EditorState.create({ doc: "\\begin{lemma}\n  \\label{lem:bound}\n  Stmt.\n\\end{lemma}\n" });
    c.api.createStub = async (_r, req) => {
      // meanwhile, two lines were added above the statement
      v.state = v.state.update({ changes: { from: 0, insert: "% a\n% b\n" } }).state;
      return { file: req.file, line: 3 };
    };
    const info = { root: "lean", absRoot: BASE + "/lean", toolchain: "v4.25.1", usesMathlib: false };
    await (c.integ as unknown as { createAndLink(v: unknown, i: unknown, l: string, n: string, f: string): Promise<void> }).createAndLink(v, info, "lem:bound", "lem_bound", "lean/Foo.lean");
    expect(v.getViewData().split("\n").slice(0, 5)).toEqual(["% a", "% b", "\\begin{lemma}", "  \\label{lem:bound}", "  \\lean{lem_bound}"]);
  });

  it("Formalize this: if the \\label vanished meanwhile, nothing is inserted and the user is told", async () => {
    const c = setup();
    const v = openView(c);
    v.state = EditorState.create({ doc: "\\begin{lemma}\n  \\label{lem:bound}\n  Stmt.\n\\end{lemma}\n" });
    c.api.createStub = async (_r, req) => {
      v.state = EditorState.create({ doc: "nothing here\n" });
      return { file: req.file, line: 3 };
    };
    const info = { root: "lean", absRoot: BASE + "/lean", toolchain: "v4.25.1", usesMathlib: false };
    await (c.integ as unknown as { createAndLink(v: unknown, i: unknown, l: string, n: string, f: string): Promise<void> }).createAndLink(v, info, "lem:bound", "lem_bound", "lean/Foo.lean");
    expect(v.getViewData()).toBe("nothing here\n");
    expect(notices().at(-1)).toContain("moved while it was being created");
  });
});

describe("Sync \\leanok: hysteresis", () => {
  it("a declaration flipping stated <-> proved does not rewrite the .tex; a stable state does, once per gap", async () => {
    const c = setup({ syncLeanok: true, states: { "Foo.a": "proved" } });
    c.integ.syncGate.timing = { stableMs: 600, minGapMs: 5000 };
    const v = openView(c);
    c.integ.start();
    c.integ.attachView(v as never);
    const flip = async (state: DeclState) => {
      c.states["Foo.b"] = state;
      await c.integ.bridge.request("lean", ["Foo.b"], true);
      c.integ.syncNow();
    };
    await flush(300); // proved-no-leanok for lem:b seen
    expect(v.getViewData()).toBe(TEX);
    await flip("stated");
    await flush(300);
    await flip("proved");
    await flush(300); // only ~300 ms stable again
    expect(v.getViewData()).toBe(TEX);
    await flush(800); // now stable for > 600 ms
    expect(v.getViewData()).toContain("\\begin{proof}\n  \\leanok\n  Hard.");
    const after = v.getViewData();
    // flips right after: the minimum gap per label holds the rewrite back
    await flip("stated");
    await flush(1200);
    expect(v.getViewData()).toBe(after);
    c.integ.dispose();
  });
});

describe("LeanPane absent: typing costs nothing", () => {
  it("viewEdited / texChanged set no timer and never invalidate", async () => {
    const c = setup({ present: false });
    c.integ.start();
    let changes = 0;
    c.integ.store.onChange(() => changes++);
    const v = openView(c);
    c.integ.viewEdited(v as never);
    c.integ.texChanged();
    expect((c.integ as unknown as { editTimer: unknown }).editTimer).toBeNull();
    await flush(800);
    expect(changes).toBe(0);
    c.integ.dispose();
  });
  it("with LeanPane they still debounce into one invalidation", async () => {
    const c = setup();
    c.integ.start();
    let changes = 0;
    c.integ.store.onChange(() => changes++);
    const v = openView(c);
    c.integ.viewEdited(v as never);
    c.integ.viewEdited(v as never);
    await flush(800);
    expect(changes).toBe(1);
    c.integ.dispose();
  });
});

describe("open views: deferred leaves count", () => {
  it("openLocation loads a deferred leaf for the file instead of opening a duplicate tab", async () => {
    const c = setup();
    const loaded: number[] = [];
    const eph: unknown[] = [];
    c.deferredLeaves.push({
      view: {},
      getViewState: () => ({ state: { file: "bp/main.tex" } }),
      loadIfDeferred: async () => void loaded.push(1),
      setEphemeralState: (st: unknown) => void eph.push(st),
    });
    const opened: unknown[] = [];
    (c.plugin.app.workspace as { getLeaf: unknown }).getLeaf = () => ({ openFile: async (...a: unknown[]) => void opened.push(a) });
    await c.integ.api.openLocation("bp/main.tex", 9);
    expect(loaded).toEqual([1]);
    expect(eph).toEqual([{ line: 8 }]);
    expect(opened).toEqual([]);
  });
  it("a loaded view is revealed directly; an unrelated file opens a new tab", async () => {
    const c = setup();
    const v = openView(c);
    c.vault.put("bp/other.tex", "x");
    const opened: unknown[] = [];
    (c.plugin.app.workspace as { getLeaf: unknown }).getLeaf = () => ({ openFile: async (...a: unknown[]) => void opened.push(a) });
    await c.integ.api.openLocation("bp/main.tex", 4);
    expect(v.revealed).toEqual([4]);
    await c.integ.api.openLocation("bp/other.tex", 2);
    expect(opened.length).toBe(1);
  });
});

describe("opening a declaration, and absolute file paths", () => {
  it("always asks LeanPane for a new leaf, never replacing the TeXPane tab", async () => {
    const c = setup();
    const v = openView(c);
    c.integ.start();
    c.integ.attachView(v as never);
    await flush(30);
    c.integ.chipHost(v as never).open("Foo.b", false);
    await flush(10);
    await c.integ.openDeclarationIn("lean", "Foo.a");
    expect(c.openOpts).toEqual([{ newLeaf: true }, { newLeaf: true }]);
    c.integ.dispose();
  });
  it("absolute status files are shown vault-relative when inside the vault, kept otherwise", async () => {
    const c = setup();
    c.api.getStatus = async (_r, names) =>
      Object.fromEntries(names.map((n) => [n, { name: n, state: "proved", file: n === "Foo.a" ? BASE + "/lean/Foo.lean" : "/elsewhere/Lib/B.lean", line: 3, source: "live", updatedAt: 1 } as DeclStatus]));
    c.api.listDeclarations = async () => [
      { name: "Foo.a", kind: "theorem", file: BASE + "/lean/Foo.lean", line: 1 },
      { name: "Out.b", kind: "def", file: "/elsewhere/Lib/B.lean", line: 2 },
    ];
    const v = openView(c);
    c.integ.start();
    c.integ.attachView(v as never);
    const host = c.integ.chipHost(v as never);
    await flush(30);
    host.status("Foo.a");
    host.status("Foo.b");
    await flush(150);
    expect(host.status("Foo.a")?.file).toBe("lean/Foo.lean");
    expect(host.status("Foo.b")?.file).toBe("/elsewhere/Lib/B.lean");
    const d = (await c.integ.completionHost(v as never).declarations(""))!;
    expect(d.items.map((i) => i.file)).toEqual(["lean/Foo.lean", "/elsewhere/Lib/B.lean"]);
    c.integ.dispose();
  });
});

vi.setConfig({ testTimeout: 20000 });
