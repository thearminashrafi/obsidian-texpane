export interface LatexProject {
  /** Folder path relative to the vault, "" for the vault root. */
  root: string;
  /** Vault path of the main .tex file. */
  main: string;
  /** Display name: folder name, or the main file's basename when root is "". */
  name: string;
  /** Vault paths of the files that belong to this project (main included), sorted: .tex first, then by path. */
  files: string[];
}

export const PROJECT_FILE_EXTS: string[] = ["tex", "bib", "sty", "cls", "png", "jpg", "jpeg", "pdf", "eps", "svg"];

const DEFAULT_IGNORE = [".texpane/", ".obsidian/", ".trash/"];
const DOCCLASS = "\\documentclass";

/** True when a line holds \documentclass before any unescaped % (escaped as an odd run of backslashes). */
function lineIsMain(line: string): boolean {
  let i = 0;
  while (i < line.length) {
    if (line.startsWith(DOCCLASS, i)) return true;
    const ch = line[i];
    if (ch === "%") return false;
    if (ch === "\\") {
      // Skip the escaped character, so \% and \\ are consumed as pairs.
      i += 2;
      continue;
    }
    i++;
  }
  return false;
}

export function isMainTex(content: string): boolean {
  for (const line of content.split(/\r?\n/)) {
    if (lineIsMain(line)) return true;
  }
  return false;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extOf(path: string): string {
  const base = baseOf(path);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Folder containment: root "" holds files with no "/"; root "x" holds "x" and "x/..." at any depth. */
function containsPath(root: string, path: string): boolean {
  if (path === root) return true;
  if (root === "") return !path.includes("/");
  return path.startsWith(root + "/");
}

/** The deepest of the given roots that contains the path, or null. */
function deepestRoot(path: string, roots: string[]): string | null {
  let best: string | null = null;
  for (const root of roots) {
    if (!containsPath(root, path)) continue;
    if (best === null || root.length > best.length) best = root;
  }
  return best;
}

/** "build/" / "/build" / "build" all become "build/". Returns null for empty entries. */
function normaliseIgnore(entry: string): string | null {
  const s = entry.trim().replace(/^\/+|\/+$/g, "");
  return s === "" ? null : s + "/";
}

function byPath(a: string, b: string): number {
  return a.localeCompare(b);
}

function isTexPath(path: string): boolean {
  return extOf(path) === "tex";
}

export function buildProjectIndex(
  texFiles: { path: string; content: string }[],
  allFiles: string[],
  opts: { ignore?: string[]; standalone?: string[] } = {},
): LatexProject[] {
  const prefixes = [
    ...DEFAULT_IGNORE,
    ...(opts.ignore ?? []).map(normaliseIgnore).filter((p): p is string => p !== null),
  ];
  const ignored = (path: string): boolean => prefixes.some((prefix) => path.startsWith(prefix));

  const tex = texFiles.filter((f) => !ignored(f.path));

  // Group main files by folder: one project per folder.
  const mainsByRoot = new Map<string, string[]>();
  for (const f of tex) {
    if (!isMainTex(f.content)) continue;
    const root = dirOf(f.path);
    const list = mainsByRoot.get(root) ?? [];
    list.push(f.path);
    mainsByRoot.set(root, list);
  }

  const roots = [...mainsByRoot.keys()];
  const mainOf = new Map<string, string>();
  for (const [root, paths] of mainsByRoot) {
    const preferred = root === "" ? "main.tex" : `${root}/main.tex`;
    mainOf.set(root, paths.includes(preferred) ? preferred : [...paths].sort(byPath)[0]);
  }

  // Candidate files: allFiles plus the tex files themselves.
  const candidates = new Set<string>([...allFiles, ...tex.map((f) => f.path)]);
  const filesByRoot = new Map<string, Set<string>>();
  for (const root of roots) filesByRoot.set(root, new Set<string>());

  for (const path of candidates) {
    if (ignored(path)) continue;
    if (!PROJECT_FILE_EXTS.includes(extOf(path))) continue;
    const root = deepestRoot(path, roots);
    if (root === null) continue;
    filesByRoot.get(root)!.add(path);
  }

  // Standalone folders (the vault root and e.g. the projects home folder): every main file there is its own
  // single-file project, named after the file, instead of the whole folder being one project.
  const standalone = new Set(["", ...(opts.standalone ?? []).map((r) => r.trim().replace(/^\/+|\/+$/g, ""))]);
  const projects: LatexProject[] = [];
  for (const root of roots) {
    if (standalone.has(root)) {
      for (const main of mainsByRoot.get(root)!) projects.push({ root, main, name: baseOf(main).replace(/\.tex$/i, ""), files: [main] });
      continue;
    }
    const main = mainOf.get(root)!;
    const set = filesByRoot.get(root)!;
    set.add(main); // main is always included
    const files = [...set].sort((a, b) => {
      const ta = isTexPath(a) ? 0 : 1;
      const tb = isTexPath(b) ? 0 : 1;
      return ta - tb || byPath(a, b);
    });
    projects.push({ root, main, name: root.slice(root.lastIndexOf("/") + 1), files });
  }

  projects.sort((a, b) => {
    const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    if (byName !== 0) return byName;
    return a.root < b.root ? -1 : a.root > b.root ? 1 : 0;
  });
  return projects;
}

export function projectFor(path: string, projects: LatexProject[]): LatexProject | null {
  let best: LatexProject | null = null;
  for (const project of projects) {
    if (!containsPath(project.root, path)) continue;
    if (best === null || project.root.length > best.root.length) best = project;
  }
  return best;
}
