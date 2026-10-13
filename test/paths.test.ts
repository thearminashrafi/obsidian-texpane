import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { toPosix, isInside, relativeInside, toVaultRel, fromVaultRel, normalizeSynctexPath, slugify, texFileName } from "../src/core/paths";

describe("paths", () => {
  const base = path.resolve("/vault/My Vault");
  it("toPosix", () => {
    expect(toPosix("a\\b\\c.tex")).toBe("a/b/c.tex");
    expect(toPosix("a/b")).toBe("a/b");
  });
  it("isInside / relativeInside", () => {
    expect(isInside(base, path.join(base, "a", "b.tex"))).toBe(true);
    expect(isInside(base, base)).toBe(true);
    expect(isInside(base, path.resolve("/vault/My Vault2/x"))).toBe(false);
    expect(isInside(base, path.resolve("/vault/other"))).toBe(false);
    expect(relativeInside(base, path.join(base, "My Thesis", "Ch 1", "einführung.tex"))).toBe("My Thesis/Ch 1/einführung.tex");
    expect(relativeInside(base, path.resolve("/etc/passwd"))).toBeNull();
    expect(relativeInside(base, base)).toBe("");
  });
  it("vault relative <-> absolute with spaces and unicode", () => {
    const rel = "My Thesis/Ch 1/einführung.tex";
    const abs = fromVaultRel(base, rel);
    expect(abs).toBe(path.join(base, "My Thesis", "Ch 1", "einführung.tex"));
    expect(toVaultRel(base, abs)).toBe(rel);
    expect(toVaultRel(base, path.resolve("/elsewhere/x.tex"))).toBeNull();
  });
  it("normalizeSynctexPath handles ./, relative and absolute", () => {
    const cwd = path.resolve("/p/q");
    expect(normalizeSynctexPath("/p/q/./main.tex", cwd)).toBe(path.resolve("/p/q/main.tex"));
    expect(normalizeSynctexPath("./chapters/two.tex", cwd)).toBe(path.resolve("/p/q/chapters/two.tex"));
    expect(normalizeSynctexPath("chapters/../main.tex", cwd)).toBe(path.resolve("/p/q/main.tex"));
    expect(normalizeSynctexPath("/a/b/../c.tex", cwd)).toBe(path.resolve("/a/c.tex"));
    expect(normalizeSynctexPath("  /p/q/x.tex\r", cwd)).toBe(path.resolve("/p/q/x.tex"));
  });
  it("slugify is ascii-safe, deterministic and unique per seed", () => {
    const a = slugify("Folder/Lit review.md", "x");
    expect(a).toMatch(/^tpe-[A-Za-z0-9_]+-[0-9a-f]{8}$/);
    expect(slugify("Folder/Lit review.md", "x")).toBe(a);
    expect(slugify("Folder/Lit review.md", "y")).not.toBe(a);
    expect(slugify("Ünïcödé/日本語.md", "")).toMatch(/^tpe-[A-Za-z0-9_]*-[0-9a-f]{8}$/);
    expect(slugify("a".repeat(300) + ".md", "").length).toBeLessThan(60);
  });
  it("texFileName replaces backslashes", () => {
    expect(texFileName("C:\\Users\\me\\x.png")).toBe("C:/Users/me/x.png");
  });
});
