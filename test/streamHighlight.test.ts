// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { latexSyntax, bibSyntax } from "../src/editor/latexLanguage";

function render(doc: string, ext = latexSyntax()) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [ext] }), parent });
  return { view, spans: () => [...parent.querySelectorAll("span[class*='tp-tok-']")].map((e) => [e.textContent, e.className.match(/tp-tok-\w+/)![0].slice(7)]) };
}

describe("class-based syntax marks", () => {
  it("colours commands, math, comments and headings", () => {
    const { spans } = render("\\section{Hi} $x^2$ % c\n\\begin{theorem}\\end{theorem}");
    const m = new Map(spans().map(([t, c]) => [t, c]));
    expect(m.get("\\section")).toBe("command");
    expect(spans().some(([t, c]) => t!.includes("x") && c === "math")).toBe(true);
    expect(m.get("% c")).toBe("comment");
    expect(m.get("Hi")).toBe("heading");
  });
  it("stays correct after edits and across lines (math state carries)", () => {
    const { view, spans } = render("$$\nx\n$$\n\\alpha");
    expect(spans().some(([t, c]) => t === "x" && c === "math")).toBe(true);
    view.dispatch({ changes: { from: 0, to: 3, insert: "" } }); // remove "$$\n": x is now plain text
    expect(spans().some(([t, c]) => t === "x" && c === "math")).toBe(false);
    expect(spans().some(([t]) => t === "\\alpha")).toBe(true);
  });
  it("highlights bib files", () => {
    const { spans } = render("@article{key,\n  title = {T},\n}", bibSyntax());
    expect(spans().some(([t, c]) => t === "@article" && c === "command")).toBe(true);
  });
});
