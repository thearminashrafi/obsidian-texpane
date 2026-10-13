import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";

import { scanChips } from "../src/editor/embedChips";

describe("scanChips", () => {
  it("finds macros, skips comments and the selection", () => {
    const doc = "a \\obsidian{Note A} b % \\obsidian{Hidden}\n\\obsidian[x]{Missing} x\\\\obsidian{Escaped}\n";
    const st = EditorState.create({ doc, selection: { anchor: doc.length } });
    const r = scanChips(st, [{ from: 0, to: doc.length }], (n) => n === "Note A");
    expect(r.map((c) => [c.target, c.opts, c.exists])).toEqual([
      ["Note A", "", true],
      ["Missing", "x", false],
    ]);
  });

  it("scans a line once when several visible ranges fall on it (long-line gaps)", () => {
    const doc = "\\obsidian{A}" + "x".repeat(5000) + "\\obsidian{B}\nnext";
    const st = EditorState.create({ doc, selection: { anchor: doc.length } });
    const r = scanChips(st, [{ from: 0, to: 100 }, { from: 4900, to: 5020 }], () => true);
    expect(r.map((c) => c.target)).toEqual(["A", "B"]);
    for (let i = 1; i < r.length; i++) expect(r[i].from).toBeGreaterThan(r[i - 1].from);
  });
});
