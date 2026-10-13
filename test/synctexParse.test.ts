import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSynctexView, parseSynctexEdit, runSynctexView, runSynctexEdit } from "../src/core/synctex";

const f = (n: string) => readFileSync(join(__dirname, "fixtures", "synctex", n), "utf8");

describe("synctex parsing", () => {
  it("view: single record", () => {
    const r = parseSynctexView(f("view-single.txt"));
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({ page: 1, x: 171.128296, y: 134.764618, h: 133.768356, v: 136.701797, W: 343.71106, H: 8.855677 });
  });
  it("view: multiple records", () => {
    const r = parseSynctexView(f("view-multi.txt"));
    expect(r.map((x) => x.page)).toEqual([1, 2]);
    expect(r[1]).toMatchObject({ x: 100.5, y: 200.25, W: 300, H: 9.5 });
  });
  it("view: no result", () => {
    expect(parseSynctexView(f("view-notag.txt"))).toEqual([]);
    expect(parseSynctexView("")).toEqual([]);
  });
  it("edit: input, line, column", () => {
    const r = parseSynctexEdit(f("edit-single.txt"));
    expect(r).toHaveLength(1);
    expect(r[0].file).toBe("/tmp/claude-0/sx/./main.tex");
    expect(r[0].line).toBe(3);
    expect(r[0].column).toBe(-1);
  });
  it("edit: windows style path with spaces, CRLF", () => {
    const r = parseSynctexEdit(f("edit-windows.txt").replace(/\n/g, "\r\n"));
    expect(r[0].file).toBe("C:/Users/me/My Thesis/./main.tex");
    expect(r[0].line).toBe(3);
  });
  it("edit: nothing", () => {
    expect(parseSynctexEdit("This is SyncTeX command line utility, version 1.5\nSyncTeX result begin\nSyncTeX result end\n")).toEqual([]);
  });
});

describe("synctex runners (injected exec)", () => {
  it("runSynctexView builds the right argument array", async () => {
    let seen: { file: string; args: string[] } | null = null;
    const exec = async (file: string, args: string[]) => { seen = { file, args }; return { stdout: f("view-single.txt"), stderr: "", code: 0 }; };
    const r = await runSynctexView({ synctexPath: "/usr/bin/synctex", texFile: "/p/My Thesis/main.tex", line: 3, column: 1, pdfFile: "/p/My Thesis/.texpane/build/main.pdf", buildDir: "/p/My Thesis/.texpane/build", env: {}, exec });
    expect(seen!.file).toBe("/usr/bin/synctex");
    expect(seen!.args).toEqual(["view", "-i", "3:1:/p/My Thesis/main.tex", "-o", "/p/My Thesis/.texpane/build/main.pdf", "-d", "/p/My Thesis/.texpane/build"]);
    expect(r[0].page).toBe(1);
  });
  it("runSynctexEdit builds args and parses", async () => {
    let seen: string[] = [];
    const exec = async (_f: string, args: string[]) => { seen = args; return { stdout: f("edit-single.txt"), stderr: "", code: 0 }; };
    const r = await runSynctexEdit({ synctexPath: "synctex", page: 2, x: 100.5, y: 150, pdfFile: "/a b/main.pdf", buildDir: "/a b/build", env: {}, exec });
    expect(seen).toEqual(["edit", "-o", "2:100.5:150:/a b/main.pdf", "-d", "/a b/build"]);
    expect(r[0].line).toBe(3);
  });
  it("runner returns [] on exec failure/timeouts", async () => {
    const exec = async () => { throw new Error("timeout"); };
    expect(await runSynctexView({ synctexPath: "s", texFile: "a", line: 1, column: 1, pdfFile: "p", buildDir: "b", env: {}, exec })).toEqual([]);
    expect(await runSynctexEdit({ synctexPath: "s", page: 1, x: 1, y: 1, pdfFile: "p", buildDir: "b", env: {}, exec })).toEqual([]);
  });
});
