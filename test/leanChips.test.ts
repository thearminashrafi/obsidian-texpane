import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { scanLeanChips } from "../src/editor/leanChips";
import { makeLeanSource, makeSources, type CompletionHost } from "../src/editor/completion";
import { chipInfo, truncate } from "../src/integration/chipInfo";
import type { DeclStatus, DeclSummary } from "../src/integration/api-types";

const status = (state: DeclStatus["state"], extra: Partial<DeclStatus> = {}): DeclStatus => ({ name: "Foo.bar", state, source: "live", updatedAt: 0, ...extra });

describe("scanLeanChips", () => {
  it("finds \\lean macros with all names; skips comments, \\leanok, escapes and the selection", () => {
    const doc = "\\lean{A.b, C} x \\leanok % \\lean{Hidden}\n\\\\lean{Escaped} \\lean{ D }\n\\lean{Sel}";
    const st = EditorState.create({ doc, selection: { anchor: doc.length - 2 } });
    const r = scanLeanChips(st, [{ from: 0, to: doc.length }]);
    expect(r.map((c) => c.names)).toEqual([["A.b", "C"], ["D"]]);
    expect(doc.slice(r[0].from, r[0].to)).toBe("\\lean{A.b, C}");
  });
  it("scans a line once for split visible ranges", () => {
    const doc = "\\lean{A}" + "x".repeat(5000) + "\\lean{B}\nnext";
    const st = EditorState.create({ doc, selection: { anchor: doc.length } });
    const r = scanLeanChips(st, [{ from: 0, to: 100 }, { from: 4900, to: 5020 }]);
    expect(r.map((c) => c.names[0])).toEqual(["A", "B"]);
  });
  it("ignores empty macros", () => {
    const st = EditorState.create({ doc: "\\lean{} \\lean{ , }\n", selection: { anchor: 19 } });
    expect(scanLeanChips(st, [{ from: 0, to: 19 }])).toEqual([]);
  });
});

describe("chipInfo: colour class and hover text", () => {
  it("neutral with a LeanPane hint when LeanPane is not installed", () => {
    const i = chipInfo("Foo.bar", "no-leanpane", undefined);
    expect(i.visual).toBe("neutral");
    expect(i.tooltip).toContain("LeanPane isn't installed");
  });
  it("neutral when the file has no Lean project, or while checking", () => {
    expect(chipInfo("X", "no-project", undefined)).toMatchObject({ visual: "neutral" });
    expect(chipInfo("X", "no-project", undefined).tooltip).toContain("% !LEAN project");
    expect(chipInfo("X", "ready", undefined)).toMatchObject({ visual: "neutral" });
    expect(chipInfo("X", "pending", undefined).tooltip).toContain("Checking");
  });
  it("coloured by declaration state, with status and signature on hover", () => {
    const sig = "theorem Foo.bar : ∀ n : ℕ, n ≤ n";
    const i = chipInfo("Foo.bar", "ready", status("proved", { signature: sig, file: "Proj/Foo.lean", line: 12 }));
    expect(i.visual).toBe("proved");
    expect(i.tooltip.split("\n")).toEqual(["Foo.bar", "Proved", sig, "Proj/Foo.lean:12", "Mod+click to open in LeanPane"]);
    expect(chipInfo("x", "ready", status("stated")).visual).toBe("stated");
    expect(chipInfo("x", "ready", status("proved-with-sorry-deps")).visual).toBe("sorry-deps");
    expect(chipInfo("x", "ready", status("error")).visual).toBe("error");
    expect(chipInfo("x", "ready", status("mathlib")).visual).toBe("mathlib");
    const missing = chipInfo("x", "ready", status("missing"));
    expect(missing.visual).toBe("missing");
    expect(missing.tooltip).not.toContain("click to open");
    expect(chipInfo("x", "ready", status("unknown")).visual).toBe("unknown");
  });
  it("long signatures are shortened to one line", () => {
    const t = chipInfo("x", "ready", status("proved", { signature: "a\n   b ".repeat(300) })).tooltip;
    expect(t.split("\n")[2].length).toBeLessThanOrEqual(400);
    expect(t.split("\n")[2]).toContain("…");
    expect(truncate("  a   b  ", 10)).toBe("a b");
  });
});

// ------------------------------------------------------------------ completion
const decls: DeclSummary[] = [
  { name: "Foo.bound", kind: "theorem", file: "Proj/Foo.lean", line: 3 },
  { name: "Foo.bound_aux", kind: "lemma", file: "Proj/Foo.lean", line: 9 },
  { name: "Foo.Thing", kind: "structure", file: "Proj/Foo.lean", line: 1 },
  { name: "Foo.bound", kind: "theorem", file: "Proj/Foo.lean", line: 3 },
];
async function complete(doc: string, lean: CompletionHost["lean"], explicit = false) {
  const pos = doc.indexOf("|");
  const text = doc.replace("|", "");
  const state = EditorState.create({ doc: text });
  const src = makeLeanSource(lean!);
  return src(new CompletionContext(state, pos, explicit));
}

describe("completion inside \\lean{ ... }", () => {
  const host = (calls: string[] = []): CompletionHost["lean"] => ({
    declarations: (typed) => {
      calls.push(typed);
      return Promise.resolve({ items: decls, complete: true });
    },
  });

  it("offers declarations (deduplicated) with kind and location", async () => {
    const calls: string[] = [];
    const r = (await complete("\\lean{Fo|}", host(calls)))!;
    expect(calls).toEqual(["Fo"]);
    expect(r.from).toBe(6);
    expect(r.options.map((o) => o.label)).toEqual(["Foo.bound", "Foo.bound_aux", "Foo.Thing"]);
    expect(r.options[0]).toMatchObject({ detail: "theorem", info: "Proj/Foo.lean:3" });
    expect(r.options[2].type).toBe("class");
  });
  it("completes the last name of a comma-separated list", async () => {
    const calls: string[] = [];
    const r = (await complete("\\lean{Foo.bound,  Foo.b|}", host(calls)))!;
    expect(calls).toEqual(["Foo.b"]);
    expect(r.from).toBe("\\lean{Foo.bound,  ".length);
    const r2 = (await complete("\\lean{A, |}", host(), true))!;
    expect(r2.from).toBe("\\lean{A, ".length);
  });
  it("does not pop up on an empty name unless asked", async () => {
    expect(await complete("\\lean{|}", host())).toBeNull();
    expect(await complete("\\lean{|}", host(), true)).not.toBeNull();
  });
  it("only inside \\lean{..}: not for \\leanok, other macros, or after the closing brace", async () => {
    expect(await complete("\\leanok Fo|", host(), true)).toBeNull();
    expect(await complete("\\label{Fo|}", host(), true)).toBeNull();
    expect(await complete("\\lean{A} Fo|", host(), true)).toBeNull();
  });
  it("null when LeanPane has nothing to offer", async () => {
    expect(await complete("\\lean{Fo|}", { declarations: () => null })).toBeNull();
  });
  it("a cut-down list is only reused while the typed text still starts with the query", async () => {
    const r = (await complete("\\lean{Foo|}", { declarations: () => Promise.resolve({ items: decls, complete: false }) }))!;
    const valid = r.validFor as (t: string) => boolean;
    expect(valid("Foo.b")).toBe(true);
    expect(valid("Fo")).toBe(false);
    expect(valid("Foo,")).toBe(false);
  });
  it("is part of makeSources only when the host has LeanPane", () => {
    const base = { labels: () => [], bibEntries: () => [], notes: () => [], headingsOf: () => [], blocksOf: () => [] };
    expect(makeSources(base).length).toBe(5);
    expect(makeSources({ ...base, lean: { declarations: () => null } }).length).toBe(6);
  });
});
