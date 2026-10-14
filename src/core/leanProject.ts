/** Which Lean project belongs to a LaTeX project, and how Lean names relate to blueprint labels. Pure. */
import * as path from "node:path";

/** `% !LEAN project = <relative path>` in the first lines of the root .tex file. */
export function parseLeanMagic(content: string): { project?: string } {
  const lines = content.split(/\r?\n/).slice(0, 30);
  for (const line of lines) {
    const m = /^\s*%\s*!\s*lean\s+project\s*=\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    let v = m[1].trim();
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    if (v) return { project: v.replace(/\\/g, "/") };
  }
  return {};
}

/**
 * Vault path of a path given relative to a .tex file (posix, normalised). Returns null when it escapes the vault.
 * `fromFile` is the vault path of the file that contains the comment.
 */
export function resolveVaultRelative(fromFile: string, rel: string): string | null {
  const dir = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(path.posix.join(dir === "." ? "" : dir, rel));
  if (joined === ".." || joined.startsWith("../") || joined.startsWith("/")) return null;
  return joined === "." ? "" : joined.replace(/\/$/, "");
}

const LEAN_KEYWORDS = new Set([
  "theorem", "lemma", "def", "example", "instance", "structure", "class", "inductive", "where", "end", "at", "by", "do", "fun", "let", "have",
  "show", "from", "in", "if", "then", "else", "match", "with", "namespace", "section", "open", "import", "variable", "universe", "axiom", "abbrev",
  "opaque", "mutual", "private", "protected", "partial", "unsafe", "deriving", "extends", "macro", "syntax", "notation", "infix", "prefix", "postfix",
]);

/**
 * Lean declaration name for a blueprint label: `lem:bound` -> `lem_bound`. Anything that is not a letter, digit,
 * underscore or prime becomes an underscore; a name that would not start with a letter or underscore, or that is a
 * Lean keyword, is made valid.
 */
export function leanNameFromLabel(label: string, env = "theorem"): string {
  let n = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_']+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!n) n = env;
  if (!/^[A-Za-z_]/.test(n)) n = `${env}_${n}`;
  if (LEAN_KEYWORDS.has(n)) n += "_";
  return n;
}

/** True when `name` can be used as a declaration name (dotted namespaces allowed). */
export function isValidLeanName(name: string): boolean {
  return name.split(".").every((part) => /^[A-Za-z_][A-Za-z0-9_'!?]*$/.test(part) && !LEAN_KEYWORDS.has(part)) && name.length > 0;
}
