import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { Completion } from "@codemirror/autocomplete";
import { braceThenList } from "../src/editor/completion";

/** Minimal stand-in for EditorView: applies dispatched specs to a real EditorState. */
function fakeView(doc: string, cursor: number) {
  let state = EditorState.create({ doc, selection: { anchor: cursor } });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    },
  };
  return view as unknown as EditorView & { state: EditorState };
}
const completion: Completion = { label: "\\begin" };

describe("\\begin / \\end completion", () => {
  it("inserts the macro with empty braces, puts the cursor between them and opens the environment list", async () => {
    const trigger = vi.fn();
    const view = fakeView("\\begin", 6);
    braceThenList("\\begin", trigger)(view, completion, 0, 6);
    expect(view.state.doc.toString()).toBe("\\begin{}");
    expect(view.state.selection.main.head).toBe(7);
    await new Promise((r) => setTimeout(r, 5));
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("works for \\end and in the middle of a line", () => {
    const view = fakeView("x \\en y", 5);
    braceThenList("\\end", vi.fn())(view, completion, 2, 5);
    expect(view.state.doc.toString()).toBe("x \\end{} y");
    expect(view.state.selection.main.head).toBe(7);
  });

  it("reuses an existing opening brace instead of doubling it", () => {
    const view = fakeView("\\begin{itemize}", 6);
    braceThenList("\\begin", vi.fn())(view, completion, 0, 6);
    expect(view.state.doc.toString()).toBe("\\begin{itemize}");
    expect(view.state.selection.main.head).toBe(7);
  });
});
