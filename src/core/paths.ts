import * as path from "node:path";
import { createHash } from "node:crypto";

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
export function texFileName(p: string): string {
  return toPosix(p);
}
export function relativeInside(parent: string, child: string): string | null {
  const rel = path.relative(parent, child);
  if (rel === "") return "";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}
export function isInside(parent: string, child: string): boolean {
  return relativeInside(parent, child) !== null;
}
export function toVaultRel(base: string, abs: string): string | null {
  return relativeInside(base, abs);
}
export function fromVaultRel(base: string, rel: string): string {
  return path.join(base, ...rel.split("/"));
}
export function normalizeSynctexPath(raw: string, cwd: string): string {
  let p = raw.trim().replace(/^file:\/\//, "");
  if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
  return path.resolve(p);
}
function asciiFold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
/** ASCII-only, TeX-safe slug: tpe-<folded name>-<8 hex of sha1(input|seed)> */
export function slugify(input: string, seed = ""): string {
  const base = input.replace(/\.md$/i, "").split("/").pop() ?? "";
  const folded = asciiFold(base).slice(0, 24);
  const h = createHash("sha1").update(input + "|" + seed).digest("hex").slice(0, 8);
  return `tpe-${folded}-${h}`;
}
