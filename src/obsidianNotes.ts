import { App, FileSystemAdapter, TFile, normalizePath } from "obsidian";
import type { NoteFile, NoteProvider } from "./types";
import type { NoteSuggestion } from "./editor/completion";
import * as path from "node:path";

/** NoteProvider backed by Obsidian's vault and metadata cache. */
export class ObsidianNotes implements NoteProvider {
  constructor(private app: App) {}

  basePath(): string {
    const a = this.app.vault.adapter;
    return a instanceof FileSystemAdapter ? a.getBasePath() : "";
  }

  private toNote(f: TFile): NoteFile {
    return { vaultPath: f.path, absPath: path.join(this.basePath(), ...f.path.split("/")), mtimeMs: f.stat.mtime, basename: f.basename };
  }

  findFile(linkText: string, from = ""): TFile | null {
    const t = linkText.trim();
    if (!t) return null;
    const direct = this.app.vault.getAbstractFileByPath(normalizePath(t)) ?? this.app.vault.getAbstractFileByPath(normalizePath(t + ".md"));
    if (direct instanceof TFile) return direct;
    return this.app.metadataCache.getFirstLinkpathDest(t.replace(/\.md$/i, ""), from);
  }

  async resolve(linkText: string, fromVaultPath?: string): Promise<NoteFile | null> {
    const f = this.findFile(linkText, fromVaultPath ?? "");
    return f && f.extension === "md" ? this.toNote(f) : null;
  }

  async read(note: NoteFile): Promise<string> {
    const f = this.app.vault.getAbstractFileByPath(note.vaultPath);
    if (f instanceof TFile) return this.app.vault.read(f);
    return "";
  }

  async resolveAsset(ref: string, fromNote: NoteFile | null): Promise<string | null> {
    const f = this.app.metadataCache.getFirstLinkpathDest(ref.trim(), fromNote?.vaultPath ?? "");
    return f ? path.join(this.basePath(), ...f.path.split("/")) : null;
  }

  // ----- helpers for the editor UI -----
  /** Shortest unambiguous name for inserting into \obsidian{...} */
  nameFor(f: TFile): string {
    const same = this.app.vault.getMarkdownFiles().filter((x) => x.basename === f.basename);
    return same.length <= 1 ? f.basename : f.path.replace(/\.md$/i, "");
  }

  suggestions(): NoteSuggestion[] {
    const files = this.app.vault.getMarkdownFiles();
    const counts = new Map<string, number>();
    for (const f of files) counts.set(f.basename, (counts.get(f.basename) ?? 0) + 1);
    return files
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .map((f) => ({ name: (counts.get(f.basename) ?? 0) > 1 ? f.path.replace(/\.md$/i, "") : f.basename, path: f.path }));
  }

  headings(note: string, from = ""): string[] {
    const f = this.findFile(note, from);
    if (!f) return [];
    return (this.app.metadataCache.getFileCache(f)?.headings ?? []).map((h) => h.heading);
  }

  blocks(note: string, from = ""): string[] {
    const f = this.findFile(note, from);
    if (!f) return [];
    return Object.keys(this.app.metadataCache.getFileCache(f)?.blocks ?? {});
  }
}
