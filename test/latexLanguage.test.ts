import { describe, it, expect } from "vitest";
import { highlightTree } from "@lezer/highlight";
import { latexLanguage, texpaneHighlight } from "../src/editor/latexLanguage";

function classes(src: string): Array<[string, string]> {
  const tree = latexLanguage.parser.parse(src);
  const out: Array<[string, string]> = [];
  highlightTree(tree, texpaneHighlight, (from, to, cls) => out.push([src.slice(from, to), cls.replace(/tp-tok-/g, "")]));
  return out;
}
const find = (r: Array<[string, string]>, text: string) => r.find(([t]) => t.includes(text));

describe("latex highlighting classes", () => {
  it("commands, args, comments", () => {
    const r = classes("\\textbf{bold} % note\n");
    expect(find(r, "\\textbf")![1]).toBe("command");
    expect(find(r, "bold")![1]).toBe("arg");
    expect(find(r, "% note")![1]).toBe("comment");
  });
  it("environment names", () => {
    const r = classes("\\begin{itemize}\n\\item x\n\\end{itemize}\n");
    expect(r.filter(([t, c]) => t.includes("itemize") && c.includes("env")).length).toBe(2);
    expect(find(r, "\\begin")![1]).toBe("command");
  });
  it("inline and display math", () => {
    const r = classes("a $x^2 + \\alpha$ b \\[ y = \\frac{1}{2} \\] c\n");
    expect(r.filter(([, c]) => c === "math").map(([t]) => t).join("")).toContain("x");
    expect(find(r, "\\alpha")![1]).toBe("math");
    expect(find(r, "\\frac")![1]).toBe("math");
  });
  it("math environment bodies are math; text after is not", () => {
    const r = classes("\\begin{equation}\n E = mc^2 \\label{eq}\n\\end{equation}\nafter \\emph{x}\n");
    expect(find(r, "mc")![1]).toBe("math");
    expect(r.find(([t]) => t === "\\emph")![1]).toBe("command");
    expect(find(r, "{x}")![1]).toBe("arg");
  });
  it("ref keys and heading text", () => {
    const r = classes("\\section{My Title}\\label{sec:a} see \\ref{sec:a} and \\cite{knuth84}\n");
    expect(find(r, "My")![1]).toBe("heading");
    expect(r.filter(([t, c]) => (t.includes("sec") || t.includes("knuth")) && c === "ref").length).toBeGreaterThanOrEqual(3);
  });
});
