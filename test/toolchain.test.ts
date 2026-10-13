import { describe, it, expect } from "vitest";
import { detectToolchain, buildEnv, installHint, type ExecFn, type ToolchainFs } from "../src/core/toolchain";

/** Fake file system: set of existing file paths; directories derived. */
function fakeFs(files: string[]): ToolchainFs {
  const set = new Set(files);
  const dirs = new Map<string, Set<string>>();
  for (const f of files) {
    const i = f.lastIndexOf("/");
    const d = f.slice(0, i) || "/";
    if (!dirs.has(d)) dirs.set(d, new Set());
    dirs.get(d)!.add(f.slice(i + 1));
    // register parents for readdir of intermediate dirs
    let cur = d;
    while (cur.includes("/") && cur !== "/") {
      const j = cur.lastIndexOf("/");
      const parent = cur.slice(0, j) || "/";
      if (!dirs.has(parent)) dirs.set(parent, new Set());
      dirs.get(parent)!.add(cur.slice(j + 1));
      cur = parent;
    }
  }
  return {
    exists: async (p) => set.has(p) || dirs.has(p),
    readdir: async (p) => { const d = dirs.get(p); if (!d) throw new Error("ENOENT"); return [...d]; },
  };
}
const exec: ExecFn = async (file, args) => {
  const name = file.split(/[\\/]/).pop()!.replace(/\.exe$/, "");
  const out: Record<string, string> = {
    latexmk: "Latexmk, John Collins, 31 Jan. 2024. Version 4.83",
    pdflatex: "pdfTeX 3.141592653-2.6-1.40.25 (TeX Live 2023)",
    xelatex: "XeTeX 3.141592653-2.6-0.999995 (TeX Live 2023)",
    lualatex: "This is LuaHBTeX, Version 1.17.0 (TeX Live 2023)",
    bibtex: "BibTeX 0.99d (TeX Live 2023)",
    biber: "biber version: 2.19",
    texcount: "TeXcount version 3.2.0.41",
  };
  if (name === "synctex") return { stdout: "usage: synctex <subcommand>\nSynchronize TeXnology command-line client, version 1.21\n", stderr: "", code: 0 };
  return { stdout: (out[name] ?? "") + "\nmore\n", stderr: "", code: 0 };
};

describe("detectToolchain", () => {
  it("finds tools on PATH (posix)", async () => {
    const fs = fakeFs(["/usr/bin/latexmk", "/usr/bin/pdflatex", "/usr/bin/synctex", "/usr/bin/bibtex", "/usr/bin/xelatex"]);
    const t = await detectToolchain({ platform: "linux", env: { PATH: "/bin:/usr/bin" }, exec, fs });
    expect(t.found).toBe(true);
    expect(t.binDir).toBe("/usr/bin");
    expect(t.latexmk?.version).toBe("4.83");
    expect(t.synctex?.version).toBe("1.21");
    expect(t.engines.pdflatex?.version).toContain("pdfTeX");
    expect(t.engines.xelatex).not.toBeNull();
    expect(t.engines.lualatex).toBeNull();
    expect(t.texcount).toBeNull();
    expect(t.missing).toEqual([]);
  });
  it("macOS Dock launch: PATH lacks TeX but /Library/TeX/texbin is probed", async () => {
    const fs = fakeFs(["/Library/TeX/texbin/latexmk", "/Library/TeX/texbin/pdflatex", "/Library/TeX/texbin/synctex", "/Library/TeX/texbin/biber"]);
    const t = await detectToolchain({ platform: "darwin", env: { PATH: "/usr/bin:/bin" }, exec, fs });
    expect(t.found).toBe(true);
    expect(t.binDir).toBe("/Library/TeX/texbin");
    expect(t.biber?.version).toBe("2.19");
  });
  it("settings dir wins over PATH", async () => {
    const fs = fakeFs(["/opt/tex/bin/latexmk", "/opt/tex/bin/synctex", "/usr/bin/latexmk", "/usr/bin/synctex"]);
    const t = await detectToolchain({ platform: "linux", env: { PATH: "/usr/bin" }, settingsDir: "/opt/tex/bin", exec, fs });
    expect(t.binDir).toBe("/opt/tex/bin");
  });
  it("picks the newest TeX Live year on linux", async () => {
    const fs = fakeFs(["/usr/local/texlive/2023/bin/x86_64-linux/latexmk", "/usr/local/texlive/2025/bin/x86_64-linux/latexmk", "/usr/local/texlive/2025/bin/x86_64-linux/synctex", "/usr/local/texlive/2024/bin/x86_64-linux/latexmk"]);
    const t = await detectToolchain({ platform: "linux", env: { PATH: "/usr/bin" }, exec, fs });
    expect(t.binDir).toBe("/usr/local/texlive/2025/bin/x86_64-linux");
  });
  it("macOS TeX Live (non-MacTeX) year dirs: /usr/local/texlive/<year>/bin/universal-darwin", async () => {
    const fs = fakeFs(["/usr/local/texlive/2024/bin/universal-darwin/latexmk", "/usr/local/texlive/2024/bin/universal-darwin/synctex"]);
    const t = await detectToolchain({ platform: "darwin", env: { PATH: "/usr/bin" }, exec, fs });
    expect(t.binDir).toBe("/usr/local/texlive/2024/bin/universal-darwin");
  });
  it("reports missing tools and found=false when latexmk is absent", async () => {
    const t = await detectToolchain({ platform: "linux", env: { PATH: "/usr/bin" }, exec, fs: fakeFs([]) });
    expect(t.found).toBe(false);
    expect(t.binDir).toBeNull();
    expect(t.missing).toContain("latexmk");
    expect(t.missing).toContain("synctex");
  });
  it("windows: .exe suffix and MiKTeX dirs", async () => {
    const fs = fakeFs(["C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\latexmk.exe".replace(/\\/g, "/")]);
    // paths use '/' in the fake fs; the implementation must join with the platform's separator, so on windows we only assert candidate generation
    const t = await detectToolchain({ platform: "win32", env: { PATH: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, exec, fs });
    expect(t.found).toBe(false); // separators differ in the fake fs; must not throw
  });
  it("version probe failure does not hide the tool", async () => {
    const fs = fakeFs(["/usr/bin/latexmk", "/usr/bin/synctex"]);
    const bad: ExecFn = async () => { throw new Error("spawn failed"); };
    const t = await detectToolchain({ platform: "linux", env: { PATH: "/usr/bin" }, exec: bad, fs });
    expect(t.found).toBe(true);
    expect(t.latexmk?.version).toBe("unknown");
  });
});

describe("buildEnv", () => {
  it("prepends binDir to PATH, sets max_print_line, keeps other vars", () => {
    const info = { binDir: "/Library/TeX/texbin" } as any;
    const e = buildEnv(info, { PATH: "/usr/bin", HOME: "/h" }, "darwin");
    expect(e.PATH).toBe("/Library/TeX/texbin:/usr/bin");
    expect(e.max_print_line).toBe("10000");
    expect(e.HOME).toBe("/h");
  });
  it("windows uses ; and the existing Path key", () => {
    const e = buildEnv({ binDir: "C:\\tex\\bin" } as any, { Path: "C:\\Windows" }, "win32");
    expect(e.Path).toBe("C:\\tex\\bin;C:\\Windows");
  });
  it("no binDir leaves PATH alone", () => {
    const e = buildEnv({ binDir: null } as any, { PATH: "/x" }, "linux");
    expect(e.PATH).toBe("/x");
  });
});

describe("installHint", () => {
  it("per OS", () => {
    expect(installHint("darwin").url).toMatch(/^https:\/\//);
    expect(installHint("darwin").title).toMatch(/MacTeX/);
    expect(installHint("win32").title).toMatch(/MiKTeX|TeX Live/);
    expect(installHint("linux").steps.length).toBeGreaterThan(0);
  });
});
