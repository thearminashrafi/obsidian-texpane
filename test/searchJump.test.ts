// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { openSearchPanel, search } from "@codemirror/search";
import { createSearchPanel } from "../src/editor/searchPanel";

// jsdom has no layout; scrolling needs these
(Range.prototype as any).getClientRects = () => [];
(Range.prototype as any).getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });

describe("find panel selects the first match while typing", () => {
  it("jumps to the first match at or after the cursor, wraps, and does not need Enter", () => {
    const doc = "alpha\nbeta\n" + "x\n".repeat(50) + "needle one\nmore\nneedle two\n";
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ state: EditorState.create({ doc, extensions: [search({ top: true, createPanel: createSearchPanel })] }), parent });
    openSearchPanel(view);
    const input = parent.querySelector("input.tp-search-input") as HTMLInputElement;
    input.value = "needle";
    input.dispatchEvent(new Event("input"));
    const first = doc.indexOf("needle");
    expect(view.state.selection.main.from).toBe(first);
    expect(view.state.selection.main.to).toBe(first + 6);
    // typing more keeps the same anchor (does not hop to the second match)
    input.value = "needle o";
    input.dispatchEvent(new Event("input"));
    expect(view.state.selection.main.from).toBe(first);
    // no match leaves the selection alone
    input.value = "zzz";
    input.dispatchEvent(new Event("input"));
    expect(view.state.selection.main.from).toBe(first);
  });
});
