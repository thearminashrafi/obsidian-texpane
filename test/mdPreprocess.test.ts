import { describe, it, expect } from "vitest";
import { preprocessObsidian } from "../src/core/md2latex/preprocess";
import { makeWikilink, makeEmbed, HL_OPEN, HL_CLOSE } from "../src/core/md2latex/sentinels";

const nl = (s: string) => s.split("\n").length;

describe("preprocessObsidian", () => {
  it("is line-preserving for every transformation", () => {
    const md = "---\ntitle: x\ntags: [a]\n---\n# H #tag\ntext %%c\nomment%% more [[A]] ![[b.png|300]] ==h== ^blk\n\n```js\n[[x]] #y\n```\n";
    expect(nl(preprocessObsidian(md))).toBe(nl(md));
  });
  it("removes front matter (replaced by blank lines)", () => {
    const out = preprocessObsidian("---\ntitle: T\n---\n# Heading\n");
    expect(out).toBe("\n\n\n# Heading\n");
    expect(preprocessObsidian("---\nnot closed\ntext")).toBe("---\nnot closed\ntext");
    expect(preprocessObsidian("text\n---\na: b\n---\n")).toBe("text\n---\na: b\n---\n"); // only at very top
  });
  it("removes %% comments inline and across lines", () => {
    expect(preprocessObsidian("a %%hidden%% b")).toBe("a  b");
    expect(preprocessObsidian("a %%x\ny\nz%% b")).toBe("a \n\n b");
  });
  it("removes #tags but keeps headings, escaped and numeric hashes", () => {
    expect(preprocessObsidian("hello #tag and #nested/tag-2 end")).toBe("hello  and  end");
    expect(preprocessObsidian("# Heading\n## Two")).toBe("# Heading\n## Two");
    expect(preprocessObsidian("issue #123 stays, C# stays, a#b stays")).toBe("issue #123 stays, C# stays, a#b stays");
    expect(preprocessObsidian("#tagfirst rest")).toBe(" rest");
  });
  it("removes ^block-id markers at end of line and on their own line", () => {
    expect(preprocessObsidian("para text ^abc-1\nnext")).toBe("para text\nnext");
    expect(preprocessObsidian("- a\n- b\n\n^listid\n")).toBe("- a\n- b\n\n\n");
    expect(preprocessObsidian("2^10 stays")).toBe("2^10 stays");
  });
  it("converts wikilinks, aliases, heading and block targets", () => {
    expect(preprocessObsidian("see [[Note]] now")).toBe(`see ${makeWikilink("Note")} now`);
    expect(preprocessObsidian("[[Folder/Note|the alias]]")).toBe(makeWikilink("Folder/Note", "the alias"));
    expect(preprocessObsidian("[[Note#Head]] [[Note#^blk]] [[#Local]]")).toBe(`${makeWikilink("Note#Head")} ${makeWikilink("Note#^blk")} ${makeWikilink("#Local")}`);
  });
  it("converts embeds with sizes and aliases", () => {
    expect(preprocessObsidian("![[Other note]]")).toBe(makeEmbed("Other note"));
    expect(preprocessObsidian("![[img.png|300]]")).toBe(makeEmbed("img.png", "300"));
    expect(preprocessObsidian("![[img.png|300x200]]")).toBe(makeEmbed("img.png", "300x200"));
    expect(preprocessObsidian("![[Note#Heading]]")).toBe(makeEmbed("Note#Heading"));
  });
  it("converts highlights", () => {
    expect(preprocessObsidian("a ==b c== d")).toBe(`a ${HL_OPEN}b c${HL_CLOSE} d`);
    expect(preprocessObsidian("x == y")).toBe("x == y");
  });
  it("leaves fenced code, inline code and math alone", () => {
    const md = "```\n[[x]] #tag %%c%% ==h==\n```\n`[[y]] #z`\n$a==b [[1]] #$\n$$\n[[1,2],[3]] ==\n$$\n~~~\n[[q]]\n~~~\n";
    expect(preprocessObsidian(md)).toBe(md);
  });
  it("unclosed constructs are left alone", () => {
    expect(preprocessObsidian("a [[unclosed")).toBe("a [[unclosed");
    expect(preprocessObsidian("a %%unclosed")).toBe("a %%unclosed");
  });
  it("handles CRLF input by normalising to LF", () => {
    expect(preprocessObsidian("a\r\n[[B]]\r\n")).toBe(`a\n${makeWikilink("B")}\n`);
  });
});
