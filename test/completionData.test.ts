import { describe, it, expect } from "vitest";
import data from "../src/editor/data/commands.json";

interface Item { label: string; type: "command" | "environment"; snippet?: string; detail?: string; package?: string }
const items = data as Item[];

describe("commands.json", () => {
  it("has at least 200 entries with both commands and environments", () => {
    expect(items.length).toBeGreaterThanOrEqual(200);
    expect(items.filter((i) => i.type === "command").length).toBeGreaterThanOrEqual(130);
    expect(items.filter((i) => i.type === "environment").length).toBeGreaterThanOrEqual(35);
  });
  it("labels are unique per type; commands start with a backslash, environments do not", () => {
    const seen = new Set<string>();
    for (const i of items) {
      const k = i.type + ":" + i.label;
      expect(seen.has(k), k).toBe(false);
      seen.add(k);
      if (i.type === "command") expect(i.label.startsWith("\\"), i.label).toBe(true);
      else expect(/^[A-Za-z*]+$/.test(i.label), i.label).toBe(true);
    }
  });
  it("snippets are balanced and use CodeMirror snippet placeholders", () => {
    for (const i of items) {
      if (!i.snippet) continue;
      let depth = 0;
      for (const ch of i.snippet.replace(/\\[{}]/g, "")) { if (ch === "{") depth++; if (ch === "}") depth--; expect(depth, i.snippet).toBeGreaterThanOrEqual(0); }
      expect(depth, i.snippet).toBe(0);
      expect(/\$\{\d*(:[^}]*)?\}/.test(i.snippet) || !i.snippet.includes("$"), i.snippet).toBe(true);
    }
  });
  it("contains the essentials", () => {
    const has = (l: string, t: string) => items.some((i) => i.label === l && i.type === t);
    for (const c of ["\\frac", "\\section", "\\textbf", "\\emph", "\\cite", "\\ref", "\\label", "\\includegraphics", "\\usepackage", "\\begin", "\\end", "\\item", "\\sum", "\\int", "\\alpha", "\\footnote", "\\caption", "\\input", "\\obsidian"]) expect(has(c, "command"), c).toBe(true);
    for (const e of ["itemize", "enumerate", "equation", "align", "figure", "table", "tabular", "document", "abstract", "verbatim", "theorem", "proof", "center", "minipage", "cases", "bmatrix"]) expect(has(e, "environment"), e).toBe(true);
  });
  it("environment snippets expand to a full begin/end block", () => {
    const it = items.find((i) => i.type === "environment" && i.label === "itemize")!;
    expect(it.snippet).toContain("\\begin{itemize}");
    expect(it.snippet).toContain("\\end{itemize}");
  });
});
