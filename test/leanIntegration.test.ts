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
  leaf = {};
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
  const statusListeners = new Set<(r: string, n: string[] | "all") => void>();
  const api: LeanPaneApiV1 = {
    version: 1,
    async projectForPath(p) {
      return p.startsWith("lean/") ? ({ root: "lean", absRoot: BASE + "/lean", toolchain: "v4.25.1", usesMathlib: false } as LeanProjectInfo) : null;
    },
    async getStatus(_root, names) {
      return Object.fromEntries(names.map((n) => [n, { name: n, state: states[n] ?? "unknown", source: "live", updatedAt: 1 } as DeclStatus]));
    },
    async listDeclarations() {
      return [{ name: "Foo.a", kind: "theorem", file: "lean/Foo.lean", line: 1 }];
    },
    async openDeclaration(_r, n) {
      opened.push(n);
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
    app: { vault, plugins: { plugins: { leanpane: opts.present === false ? undefined : { api } } }, workspace: { on: () => ({}), getLeaf: () => ({ openFile: async () => undefined }), setActiveLeaf() {} } },
    settings: { syncLeanok: opts.syncLeanok ?? false },
    notes: { basePath: () => BASE },
    latexViews: () => views,
    projects: () => [{ root: "bp", main: "bp/main.tex", name: "bp", files: ["bp/main.tex"] }],
    registerEvent: () => undefined,
    activeLatexView: () => views[0] ?? null,
    ensureFolder: async () => undefined,
  };
  const integ = new LeanIntegration(plugin as never);
  return { integ, vault, views, api, stubs, opened, states, plugin };
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

vi.setConfig({ testTimeout: 20000 });
