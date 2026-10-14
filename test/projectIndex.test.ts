import { describe, it, expect } from "vitest";
import {
  PROJECT_FILE_EXTS,
  buildProjectIndex,
  isMainTex,
  projectFor,
  type LatexProject,
} from "../src/core/projectIndex";

const MAIN = "\\documentclass{article}\n\\begin{document}x\\end{document}\n";
const PLAIN = "\\section{Intro}\nHello\n";
const tex = (path: string, content: string = MAIN) => ({ path, content });

describe("isMainTex", () => {
  it("is true for a plain \\documentclass line", () => {
    expect(isMainTex("\\documentclass{article}")).toBe(true);
  });

  it("ignores a commented-out \\documentclass", () => {
    expect(isMainTex("% \\documentclass{article}")).toBe(false);
    expect(isMainTex("   % \\documentclass{article}")).toBe(false);
    expect(isMainTex("Foo % \\documentclass{article}")).toBe(false);
  });

  it("counts \\documentclass after an escaped \\%", () => {
    expect(isMainTex(String.raw`\% \documentclass{article}`)).toBe(true);
  });

  it("treats \\\\% as a real comment (escaped backslash)", () => {
    expect(isMainTex(String.raw`\\% \documentclass{article}`)).toBe(false);
  });

  it("counts \\documentclass before a trailing comment", () => {
    expect(isMainTex("\\documentclass{article} % the class")).toBe(true);
  });

  it("finds \\documentclass on a later line after comment lines", () => {
    expect(isMainTex("% header\n% \\documentclass{x}\n\\documentclass{article}\n")).toBe(true);
  });

  it("handles CRLF line endings", () => {
    expect(isMainTex("% hi\r\n\\documentclass{article}\r\n")).toBe(true);
  });

  it("is false when there is no \\documentclass", () => {
    expect(isMainTex(PLAIN)).toBe(false);
    expect(isMainTex("")).toBe(false);
  });
});

describe("PROJECT_FILE_EXTS", () => {
  it("lists the project file extensions", () => {
    expect(PROJECT_FILE_EXTS).toEqual(["tex", "bib", "sty", "cls", "png", "jpg", "jpeg", "pdf", "eps", "svg"]);
  });
});

describe("buildProjectIndex: basics", () => {
  it("builds one project for a folder with a main and its files", () => {
    const projects = buildProjectIndex(
      [tex("thesis/main.tex")],
      ["thesis/main.tex", "thesis/ch1.tex", "thesis/refs.bib", "thesis/fig.png", "notes.md"],
    );
    expect(projects).toEqual([
      {
        root: "thesis",
        main: "thesis/main.tex",
        name: "thesis",
        files: ["thesis/ch1.tex", "thesis/main.tex", "thesis/fig.png", "thesis/refs.bib"],
      },
    ]);
  });

  it("ignores non-main tex files as project roots", () => {
    expect(buildProjectIndex([tex("notes/intro.tex", PLAIN)], ["notes/intro.tex"])).toEqual([]);
  });

  it("includes main even when it is absent from allFiles", () => {
    const [p] = buildProjectIndex([tex("solo/main.tex")], []);
    expect(p.files).toEqual(["solo/main.tex"]);
  });
});

describe("buildProjectIndex: main selection", () => {
  it("prefers main.tex over other mains in the same folder", () => {
    const [p] = buildProjectIndex(
      [tex("paper/zeta.tex"), tex("paper/main.tex"), tex("paper/alpha.tex")],
      ["paper/zeta.tex", "paper/main.tex", "paper/alpha.tex"],
    );
    expect(p.main).toBe("paper/main.tex");
    expect(p.files).toEqual(["paper/alpha.tex", "paper/main.tex", "paper/zeta.tex"]);
  });

  it("falls back to the alphabetically first main when there is no main.tex", () => {
    const [p] = buildProjectIndex([tex("paper/zeta.tex"), tex("paper/m.tex")], []);
    expect(p.main).toBe("paper/m.tex");
    expect(p.name).toBe("paper");
  });

  it("picks the alphabetically first main among a, b", () => {
    const [p] = buildProjectIndex([tex("d/b.tex"), tex("d/a.tex")], []);
    expect(p.main).toBe("d/a.tex");
  });

  it("does not use a main.tex that is not itself a main", () => {
    const [p] = buildProjectIndex([tex("d/main.tex", PLAIN), tex("d/other.tex")], []);
    expect(p.main).toBe("d/other.tex");
  });
});

describe("buildProjectIndex: nested projects", () => {
  it("gives each nested project its own files", () => {
    const projects = buildProjectIndex(
      [tex("a/main.tex"), tex("a/sub/main.tex")],
      [
        "a/chap.tex",
        "a/x.png",
        "a/sub/y.png",
        "a/sub/z.bib",
        "a/sub/deep/fig.pdf",
      ],
    );
    expect(projects).toEqual([
      {
        root: "a",
        main: "a/main.tex",
        name: "a",
        files: ["a/chap.tex", "a/main.tex", "a/x.png"],
      },
      {
        root: "a/sub",
        main: "a/sub/main.tex",
        name: "sub",
        files: ["a/sub/main.tex", "a/sub/deep/fig.pdf", "a/sub/y.png", "a/sub/z.bib"],
      },
    ]);
  });

  it("does not treat a sibling with a shared name prefix as contained", () => {
    const projects = buildProjectIndex([tex("a/main.tex")], ["a/main.tex", "ab/fig.png"]);
    expect(projects[0].files).toEqual(["a/main.tex"]);
  });
});

describe("buildProjectIndex: vault root and standalone folders", () => {
  it("each main file in the vault root is its own single-file project", () => {
    const projects = buildProjectIndex(
      [tex("main.tex"), tex("book/main.tex")],
      ["main.tex", "logo.png", "pics/logo.png", "book/fig.pdf"],
    );
    expect(projects).toEqual([
      {
        root: "book",
        main: "book/main.tex",
        name: "book",
        files: ["book/main.tex", "book/fig.pdf"],
      },
      {
        root: "",
        main: "main.tex",
        name: "main",
        files: ["main.tex"],
      },
    ]);
  });

  it("names a root project after its main file's basename", () => {
    const [p] = buildProjectIndex([tex("paper.tex")], ["paper.tex", "refs.bib"]);
    expect(p).toEqual({ root: "", main: "paper.tex", name: "paper", files: ["paper.tex"] });
  });

  it("treats every main in a standalone folder as its own project, keeping subfolder projects", () => {
    const projects = buildProjectIndex(
      [tex("LaTeX/notes.tex"), tex("LaTeX/hw1.tex"), tex("LaTeX/Paper/main.tex")],
      ["LaTeX/notes.tex", "LaTeX/hw1.tex", "LaTeX/Paper/main.tex", "LaTeX/Paper/refs.bib", "LaTeX/x.png"],
      { standalone: ["LaTeX/"] },
    );
    expect(projects.map((p) => [p.name, p.root, p.files])).toEqual([
      ["hw1", "LaTeX", ["LaTeX/hw1.tex"]],
      ["notes", "LaTeX", ["LaTeX/notes.tex"]],
      ["Paper", "LaTeX/Paper", ["LaTeX/Paper/main.tex", "LaTeX/Paper/refs.bib"]],
    ]);
  });
});

describe("buildProjectIndex: ignore prefixes", () => {
  it("skips default ignored folders, including their mains", () => {
    const projects = buildProjectIndex(
      [
        tex(".texpane/main.tex"),
        tex(".obsidian/main.tex"),
        tex(".trash/main.tex"),
        tex("paper/main.tex"),
      ],
      [".texpane/x.png", ".obsidian/y.png", ".trash/z.pdf", "paper/fig.pdf"],
    );
    expect(projects.map((p) => p.root)).toEqual(["paper"]);
    expect(projects[0].files).toEqual(["paper/main.tex", "paper/fig.pdf"]);
  });

  it("skips a configured build folder", () => {
    const projects = buildProjectIndex(
      [tex("paper/main.tex"), tex("paper/build/main.tex")],
      ["paper/main.tex", "paper/build/main.pdf", "paper/build/x.aux", "paper/out/x.pdf"],
      { ignore: ["paper/build"] },
    );
    expect(projects).toHaveLength(1);
    expect(projects[0].files).toEqual(["paper/main.tex", "paper/out/x.pdf"]);
  });

  it("accepts ignore entries with or without slashes", () => {
    const files = ["paper/main.tex", "paper/build/main.pdf"];
    const texFiles = [tex("paper/main.tex")];
    for (const entry of ["paper/build", "paper/build/", "/paper/build/"]) {
      const [p] = buildProjectIndex(texFiles, files, { ignore: [entry] });
      expect(p.files).toEqual(["paper/main.tex"]);
    }
  });

  it("ignores empty ignore entries", () => {
    const [p] = buildProjectIndex([tex("paper/main.tex")], ["paper/main.tex", "paper/a.png"], {
      ignore: ["", "   "],
    });
    expect(p.files).toEqual(["paper/main.tex", "paper/a.png"]);
  });
});

describe("buildProjectIndex: extensions and sorting", () => {
  it("filters by extension case-insensitively", () => {
    const [p] = buildProjectIndex(
      [tex("p/main.tex")],
      ["p/IMG.PNG", "p/Refs.BIB", "p/doc.md", "p/data.csv", "p/Fig.JPEG", "p/a.pdf", "p/s.Sty", "p/t.SVG"],
    );
    expect(p.files).toEqual([
      "p/main.tex",
      "p/a.pdf",
      "p/Fig.JPEG",
      "p/IMG.PNG",
      "p/Refs.BIB",
      "p/s.Sty",
      "p/t.SVG",
    ]);
  });

  it("puts .tex files first even when they sort later by path", () => {
    const [p] = buildProjectIndex([tex("p/zzz.tex", PLAIN), tex("p/main.tex")], ["p/aaa.png", "p/zzz.tex"]);
    expect(p.files).toEqual(["p/main.tex", "p/zzz.tex", "p/aaa.png"]);
  });

  it("sorts projects by name case-insensitively, then by root", () => {
    const projects = buildProjectIndex(
      [tex("Zeta/main.tex"), tex("alpha/main.tex"), tex("b/x/main.tex"), tex("a/x/main.tex")],
      [],
    );
    expect(projects.map((p) => p.root)).toEqual(["alpha", "a/x", "b/x", "Zeta"]);
    expect(projects.map((p) => p.name)).toEqual(["alpha", "x", "x", "Zeta"]);
  });
});

describe("projectFor", () => {
  const projects: LatexProject[] = buildProjectIndex(
    [tex("main.tex"), tex("a/main.tex"), tex("a/sub/main.tex")],
    [],
  );

  it("returns the deepest project containing the path", () => {
    expect(projectFor("a/sub/deep/f.png", projects)?.root).toBe("a/sub");
    expect(projectFor("a/sub/main.tex", projects)?.root).toBe("a/sub");
    expect(projectFor("a/f.png", projects)?.root).toBe("a");
  });

  it("returns the project for a path equal to its root folder", () => {
    expect(projectFor("a", projects)?.root).toBe("a");
    expect(projectFor("a/sub", projects)?.root).toBe("a/sub");
  });

  it("uses the vault-root project only for root-level files", () => {
    expect(projectFor("top.tex", projects)?.root).toBe("");
    expect(projectFor("other/x.tex", projects)).toBeNull();
  });

  it("does not match a root by a bare name prefix", () => {
    const onlyA = buildProjectIndex([tex("a/main.tex")], []);
    expect(projectFor("ab/x.tex", onlyA)).toBeNull();
    expect(projectFor("a/x.tex", onlyA)?.root).toBe("a");
  });

  it("returns null when there are no projects", () => {
    expect(projectFor("a/x.tex", [])).toBeNull();
  });
});
