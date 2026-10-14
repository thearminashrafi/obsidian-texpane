import { describe, it, expect } from "vitest";
import { cssAttrEscape, explorerCss } from "../src/core/explorerCss";

describe("cssAttrEscape", () => {
  it("leaves plain text alone", () => {
    expect(cssAttrEscape("LaTeX/My Thesis")).toBe("LaTeX/My Thesis");
  });
  it("escapes backslash and double quote", () => {
    expect(cssAttrEscape('a\\b')).toBe("a\\\\b");
    expect(cssAttrEscape('say "hi"')).toBe('say \\"hi\\"');
  });
  it("escapes newline and other control characters as hex", () => {
    expect(cssAttrEscape("a\nb")).toBe("a\\a b");
    expect(cssAttrEscape("a\tb")).toBe("a\\9 b");
    expect(cssAttrEscape("a\x7fb")).toBe("a\\7f b");
  });
});

describe("explorerCss", () => {
  it("returns empty string for empty input", () => {
    expect(explorerCss([], { mark: true, hide: false })).toBe("");
    expect(explorerCss([], { mark: false, hide: true })).toBe("");
  });

  it("returns empty string when both flags are off", () => {
    expect(explorerCss(["Thesis"], { mark: false, hide: false })).toBe("");
  });

  it("ignores empty-string roots", () => {
    expect(explorerCss([""], { mark: true, hide: false })).toBe("");
    const css = explorerCss(["", "Thesis"], { mark: true, hide: false });
    expect(css).not.toContain('data-path=""');
    expect(css).toContain('[data-path="Thesis"]');
  });

  it("de-duplicates roots", () => {
    const once = explorerCss(["Thesis"], { mark: true, hide: false });
    const twice = explorerCss(["Thesis", "Thesis"], { mark: true, hide: false });
    expect(twice).toBe(once);
    const hidden = explorerCss(["A", "A", "B"], { mark: false, hide: true });
    expect(hidden.split('[data-path="A"]').length - 1).toBe(1);
  });

  it("hide emits one display:none rule for the whole folder", () => {
    const css = explorerCss(["Thesis"], { mark: false, hide: true });
    expect(css).toBe('.nav-folder:has(> .nav-folder-title[data-path="Thesis"]) { display: none; }');
  });

  it("hide wins over mark: no tint or sigma rules", () => {
    const css = explorerCss(["Thesis"], { mark: true, hide: true });
    expect(css).toContain("display: none");
    expect(css).not.toContain("text-accent");
    expect(css).not.toContain("::after");
  });

  it("mark emits title tint and sigma marker rules", () => {
    const css = explorerCss(["Thesis"], { mark: true, hide: false });
    expect(css).toContain('.nav-folder-title[data-path="Thesis"] { color: var(--text-accent); }');
    expect(css).toContain(
      '.nav-folder-title[data-path="Thesis"] .nav-folder-title-content::after { content: "\\03A3"; font-size: 0.85em; opacity: 0.7; margin-left: 4px; }',
    );
    expect(css).not.toContain("display: none");
  });

  it("combines selectors for multiple roots into one rule each", () => {
    const hidden = explorerCss(["A", "B/C"], { mark: false, hide: true });
    expect(hidden).toBe(
      '.nav-folder:has(> .nav-folder-title[data-path="A"]),\n' +
        '.nav-folder:has(> .nav-folder-title[data-path="B/C"]) { display: none; }',
    );
    const marked = explorerCss(["A", "B/C"], { mark: true, hide: false });
    expect(marked).toContain('.nav-folder-title[data-path="A"],\n.nav-folder-title[data-path="B/C"] { color: var(--text-accent); }');
    expect(marked).toContain(
      '.nav-folder-title[data-path="A"] .nav-folder-title-content::after,\n.nav-folder-title[data-path="B/C"] .nav-folder-title-content::after {',
    );
  });

  it("escapes quotes, backslashes and newlines in paths", () => {
    const css = explorerCss(['say "hi"\\x\nend'], { mark: false, hide: true });
    expect(css).toContain('[data-path="say \\"hi\\"\\\\x\\a end"]');
    expect(css).not.toContain("\n]");
  });

  it("output has no hex colours and no rgb() literals", () => {
    const css = explorerCss(["Thesis", "Notes/Draft"], { mark: true, hide: false });
    expect(css).not.toContain("#");
    expect(css).not.toMatch(/rgba?\(/);
  });
});
