import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { NoteFile, NoteProvider } from "../types";
import { toPosix } from "./paths";

/** NoteProvider backed by a plain folder of .md files (used by tests and the standalone fallback). */
export class FolderNoteProvider implements NoteProvider {
  private listing: string[] | null = null;
  constructor(private root: string) {}

  invalidate() {
    this.listing = null;
  }

  private async list(): Promise<string[]> {
    if (this.listing) return this.listing;
    const out: string[] = [];
    const walk = async (dir: string, rel: string) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), r);
        else out.push(r);
      }
    };
    await walk(this.root, "");
    this.listing = out;
    return out;
  }

  private async toNote(rel: string): Promise<NoteFile> {
    const abs = path.join(this.root, ...rel.split("/"));
    const st = await fsp.stat(abs);
    return { vaultPath: rel, absPath: abs, mtimeMs: st.mtimeMs, basename: path.posix.basename(rel).replace(/\.md$/i, "") };
  }

  async resolve(linkText: string, fromVaultPath?: string): Promise<NoteFile | null> {
    let t = toPosix(linkText.trim()).replace(/^\/+/, "");
    if (!t) return null;
    const files = (await this.list()).filter((f) => /\.md$/i.test(f));
    const want = (/\.md$/i.test(t) ? t : t + ".md").toLowerCase();
    const fromDir = fromVaultPath ? path.posix.dirname(fromVaultPath) : "";
    const exact = files.find((f) => f.toLowerCase() === want);
    if (exact) return this.toNote(exact);
    const matches = files.filter((f) => f.toLowerCase() === want || f.toLowerCase().endsWith("/" + want));
    if (!matches.length) return null;
    matches.sort((a, b) => {
      const sa = path.posix.dirname(a) === fromDir ? 0 : 1;
      const sb = path.posix.dirname(b) === fromDir ? 0 : 1;
      return sa - sb || a.length - b.length;
    });
    return this.toNote(matches[0]);
  }

  read(note: NoteFile): Promise<string> {
    return fsp.readFile(note.absPath, "utf8");
  }

  async resolveAsset(ref: string, fromNote: NoteFile | null): Promise<string | null> {
    const r = toPosix(ref.trim());
    const cands = [];
    if (fromNote) cands.push(path.join(path.dirname(fromNote.absPath), ...r.split("/")));
    cands.push(path.join(this.root, ...r.split("/")));
    for (const c of cands) {
      try {
        if ((await fsp.stat(c)).isFile()) return c;
      } catch {
        /* next */
      }
    }
    const base = path.posix.basename(r).toLowerCase();
    const hit = (await this.list()).find((f) => path.posix.basename(f).toLowerCase() === base && !/\.md$/i.test(f));
    return hit ? path.join(this.root, ...hit.split("/")) : null;
  }
}
