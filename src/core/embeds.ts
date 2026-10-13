import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ConvertOptions, EmbedFileInfo, EmbedRef, NoteFile, NoteProvider, SectionLevel, WikiTarget } from "../types";
import { parseEmbedTarget } from "./embedScanner";
import { slugify } from "./paths";
import { LEVELS, preprocessObsidian, selectPart, serializeMarkdown } from "./md2latex/index";
import { SENTINEL_RE, toSentinel } from "./md2latex/sentinels";

const CONVERTER_VERSION = 3;
const IMAGE_OK = new Set(["png", "jpg", "jpeg"]);
const IMAGE_ALL = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif", "tif", "tiff"]);

export interface EmbedBuilderOptions {
  notes: NoteProvider;
  mode: "build" | "export";
  /** build mode: where <slug>.tex and <slug>.map.json go */
  embedsDir: string;
  /** where images are copied */
  assetsDir: string;
  /** prefix used in \includegraphics (build: "", export: "assets/") */
  assetRefPrefix: string;
  wikilinkFootnote: boolean;
  highlightEmph: boolean;
  amssymbLoaded: boolean;
  listingsLoaded: boolean;
  maxDepth?: number;
}

export interface NoteWarning {
  notePath: string;
  line?: number;
  message: string;
}

export interface EmbedOutcome {
  ok: boolean;
  message?: string;
  slug?: string;
  /** build: `\input{slug}`; export: the converted LaTeX */
  replacement: string;
  usesLinks: boolean;
  usesGraphics: boolean;
  files: EmbedFileInfo[];
  notePaths: string[];
  warnings: NoteWarning[];
}

type Dep =
  | { t: "note"; vaultPath: string; mtimeMs: number }
  | { t: "asset"; abs: string; mtimeMs: number; size: number }
  | { t: "missingNote"; link: string; from: string }
  | { t: "missingAsset"; ref: string; from: string };

interface Generated {
  slug: string;
  latex: string;
  files: EmbedFileInfo[];
  notePaths: string[];
  warnings: NoteWarning[];
  usesLinks: boolean;
  usesGraphics: boolean;
  deps: Dep[];
  notFound?: string;
}

interface MapJson {
  version: number;
  converter: number;
  notePath: string;
  lineMap: number[];
  files: EmbedFileInfo[];
  notePaths: string[];
  warnings: NoteWarning[];
  usesLinks: boolean;
  usesGraphics: boolean;
  deps: Dep[];
}

const hash8 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 8);

export function parseLevel(v: string | undefined): SectionLevel | null {
  if (!v) return null;
  return (LEVELS as string[]).includes(v) ? (v as SectionLevel) : null;
}

export class EmbedBuilder {
  private memo = new Map<string, Promise<Generated>>();
  private o: EmbedBuilderOptions;
  constructor(opts: EmbedBuilderOptions) {
    this.o = { maxDepth: 5, ...opts };
  }

  /** Convert the note named by an `\obsidian` macro. `fromVaultPath` = vault path of the .tex file (for link resolution). */
  async embed(ref: EmbedRef, fromVaultPath?: string): Promise<EmbedOutcome> {
    const fail = (message: string): EmbedOutcome => ({ ok: false, message, replacement: `\\texttt{[unresolved embed: ${ref.target.replace(/[\\{}$&#^_%~]/g, " ")}]}`, usesLinks: false, usesGraphics: false, files: [], notePaths: [], warnings: [] });
    const note = await this.o.notes.resolve(ref.note, fromVaultPath);
    if (!note) return fail(`Note "${ref.note}" was not found in the vault`);
    const warnings: NoteWarning[] = [];
    let level = parseLevel(ref.options.level);
    if (ref.options.level && !level) warnings.push({ notePath: note.vaultPath, message: `Unknown level "${ref.options.level}" (use chapter, section, subsection, subsubsection, paragraph or subparagraph); using section` });
    level ??= "section";
    const title = /^(true|yes|1)$/i.test(ref.options.title ?? "");
    const gen = await this.generate(note, { heading: ref.heading, blockId: ref.blockId }, LEVELS.indexOf(level), title, []);
    if (gen.notFound) return fail(gen.notFound);
    const all = [...warnings, ...gen.warnings];
    return {
      ok: true,
      slug: gen.slug,
      replacement: this.o.mode === "build" ? `\\input{${gen.slug}}` : gen.latex.replace(/\n+$/, ""),
      usesLinks: gen.usesLinks,
      usesGraphics: gen.usesGraphics,
      files: gen.files,
      notePaths: gen.notePaths,
      warnings: all,
    };
  }

  private async generate(note: NoteFile, sel: { heading?: string; blockId?: string }, levelIdx: number, title: boolean, stack: string[]): Promise<Generated> {
    const selKey = `${sel.heading ?? ""}^${sel.blockId ?? ""}`;
    const slug = slugify(note.vaultPath, `${selKey}|${levelIdx}|${title}|${this.o.mode}|${this.o.wikilinkFootnote}|${this.o.highlightEmph}|${this.o.amssymbLoaded}|${this.o.listingsLoaded}`);
    const hit = this.memo.get(slug);
    if (hit && stack.length === 0) return hit;
    const p = this.generateUncached(note, sel, levelIdx, title, stack, slug);
    if (stack.length === 0) this.memo.set(slug, p);
    return p;
  }

  private async fresh(slug: string, note: NoteFile): Promise<Generated | null> {
    if (this.o.mode !== "build") return null;
    const mapPath = path.join(this.o.embedsDir, slug + ".map.json");
    const texPath = path.join(this.o.embedsDir, slug + ".tex");
    let json: MapJson;
    try {
      json = JSON.parse(await fsp.readFile(mapPath, "utf8"));
      await fsp.access(texPath);
    } catch {
      return null;
    }
    if (json.version !== 1 || json.converter !== CONVERTER_VERSION) return null;
    for (const d of json.deps) {
      if (d.t === "note") {
        const n = d.vaultPath === note.vaultPath ? note : await this.o.notes.resolve(d.vaultPath);
        if (!n || n.vaultPath !== d.vaultPath || n.mtimeMs !== d.mtimeMs) return null;
      } else if (d.t === "asset") {
        try {
          const st = await fsp.stat(d.abs);
          if (st.mtimeMs !== d.mtimeMs || st.size !== d.size) return null;
        } catch {
          return null;
        }
      } else if (d.t === "missingNote") {
        if (await this.o.notes.resolve(d.link, d.from)) return null;
      } else if (d.t === "missingAsset") {
        if (await this.o.notes.resolveAsset(d.ref, { vaultPath: d.from } as NoteFile)) return null;
      }
    }
    for (const f of json.files) {
      try {
        await fsp.access(f.embedAbsPath);
      } catch {
        return null;
      }
    }
    return { slug, latex: "", files: json.files, notePaths: json.notePaths, warnings: json.warnings, usesLinks: json.usesLinks, usesGraphics: json.usesGraphics, deps: json.deps };
  }

  private async generateUncached(note: NoteFile, sel: { heading?: string; blockId?: string }, levelIdx: number, title: boolean, stack: string[], slug: string): Promise<Generated> {
    const cached = await this.fresh(slug, note);
    if (cached) return cached;

    const raw = await this.o.notes.read(note);
    const part = selectPart(raw, sel);
    if (!part.found) {
      const what = sel.heading ? `heading "${sel.heading}"` : `block "^${sel.blockId}"`;
      return { slug, latex: "", files: [], notePaths: [note.vaultPath], warnings: [], usesLinks: false, usesGraphics: false, deps: [], notFound: `Could not find ${what} in note "${note.vaultPath}"` };
    }
    const md = preprocessObsidian(part.md);
    const deps: Dep[] = [{ t: "note", vaultPath: note.vaultPath, mtimeMs: note.mtimeMs }];
    const warnings: NoteWarning[] = [];
    const warn = (message: string, line?: number) => warnings.push({ notePath: note.vaultPath, line, message });

    // ---- pre-resolve nested notes and images (async) ----
    const nestedNotes = new Map<string, NoteFile | null>();
    const images = new Map<string, string | null>();
    const imageJobs: Array<{ key: string; ref: string }> = [];
    const noteJobs = new Set<string>();
    for (const m of md.matchAll(new RegExp(SENTINEL_RE.source, "g"))) {
      const s = toSentinel(m);
      if (s.kind !== "embed") continue;
      const p = parseEmbedTarget(s.target);
      const ext = /\.([A-Za-z0-9]+)$/.exec(p.note)?.[1]?.toLowerCase() ?? "";
      if (IMAGE_ALL.has(ext)) imageJobs.push({ key: `true:${p.note}`, ref: p.note });
      else if (!ext || ext === "md") noteJobs.add(p.note);
      else if (!["pdf", "mp3", "mp4", "webm", "ogg", "wav", "mov", "m4a", "mkv", "flac", "3gp", "ogv"].includes(ext)) noteJobs.add(p.note);
    }
    for (const m of md.matchAll(/!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)/g)) {
      let ref = m[1].replace(/^<|>$/g, "");
      if (/^(https?:|data:)/i.test(ref)) continue;
      try {
        ref = decodeURIComponent(ref);
      } catch {
        /* keep */
      }
      imageJobs.push({ key: `false:${ref}`, ref });
    }
    for (const name of noteJobs) {
      const n = await this.o.notes.resolve(name, note.vaultPath);
      nestedNotes.set(name, n);
      if (!n) deps.push({ t: "missingNote", link: name, from: note.vaultPath });
    }
    for (const j of imageJobs) {
      if (images.has(j.key)) continue;
      const ext = /\.([A-Za-z0-9]+)$/.exec(j.ref)?.[1]?.toLowerCase() ?? "";
      const abs = await this.o.notes.resolveAsset(j.ref, note);
      if (!abs) {
        images.set(j.key, null);
        deps.push({ t: "missingAsset", ref: j.ref, from: note.vaultPath });
        continue;
      }
      if (!IMAGE_OK.has(ext)) {
        warn(`Image format .${ext} is not supported by LaTeX (use png or jpg): ${j.ref}`);
        images.set(j.key, null);
        continue;
      }
      const st = await fsp.stat(abs);
      const name = `img-${hash8(`${abs}|${st.mtimeMs}|${st.size}`)}.${ext}`;
      await fsp.mkdir(this.o.assetsDir, { recursive: true });
      const dest = path.join(this.o.assetsDir, name);
      try {
        await fsp.access(dest);
      } catch {
        await fsp.copyFile(abs, dest);
      }
      deps.push({ t: "asset", abs, mtimeMs: st.mtimeMs, size: st.size });
      images.set(j.key, this.o.assetRefPrefix + name);
    }

    // ---- serialize ----
    const nested: Array<{ wt: WikiTarget; note: NoteFile; levelIndex: number }> = [];
    const options: ConvertOptions = {
      level: LEVELS[levelIdx],
      title,
      noteTitle: sel.heading ? sel.heading.split("#").pop()!.trim() : note.basename,
      wikilinkFootnote: this.o.wikilinkFootnote,
      highlightEmph: this.o.highlightEmph,
      amssymbLoaded: this.o.amssymbLoaded,
      listingsLoaded: this.o.listingsLoaded,
    };
    if (title && sel.heading === undefined) options.noteTitle = note.basename;
    const result = serializeMarkdown(md, {
      options,
      warn,
      resolveImage: (ref, isWiki) => images.get(`${isWiki}:${ref}`) ?? null,
      embedNote: (wt, c) => {
        const n = nestedNotes.get(wt.note);
        if (!n) return null;
        const key = `${n.vaultPath}#${wt.heading ?? ""}^${wt.blockId ?? ""}`;
        const selfKey = `${note.vaultPath}#${sel.heading ?? ""}^${sel.blockId ?? ""}`;
        if (key === selfKey || stack.includes(key)) {
          warn(`Embed cycle: "${n.vaultPath}" is already being embedded; skipped`, c.line);
          return `\\texttt{[embed cycle: ${wt.note.replace(/[\\{}$&#^_%~]/g, " ")}]}`;
        }
        if (stack.length + 1 >= (this.o.maxDepth ?? 5)) {
          warn(`Embed depth limit (${this.o.maxDepth}) reached at "${n.vaultPath}"; skipped`, c.line);
          return `\\texttt{[embed depth limit]}`;
        }
        nested.push({ wt, note: n, levelIndex: c.levelIndex });
        return `${nested.length - 1}`;
      },
    });
    let latex = result.latex;
    let usesLinks = result.usesLinks;
    let usesGraphics = result.usesGraphics;
    const files: EmbedFileInfo[] = [];
    const notePaths = new Set<string>([note.vaultPath]);
    const selfKey = `${note.vaultPath}#${sel.heading ?? ""}^${sel.blockId ?? ""}`;
    for (let i = 0; i < nested.length; i++) {
      const nn = nested[i];
      const child = await this.generateUncachedChild(nn.note, { heading: nn.wt.heading, blockId: nn.wt.blockId }, nn.levelIndex, [...stack, selfKey]);
      let rep: string;
      if (child.notFound) {
        warn(child.notFound);
        rep = `\\texttt{[unresolved embed: ${nn.wt.note.replace(/[\\{}$&#^_%~]/g, " ")}]}`;
      } else {
        warnings.push(...child.warnings);
        usesLinks ||= child.usesLinks;
        usesGraphics ||= child.usesGraphics;
        files.push(...child.files);
        child.notePaths.forEach((p) => notePaths.add(p));
        deps.push(...child.deps);
        rep = this.o.mode === "build" ? `\\input{${child.slug}}` : child.latex.replace(/\n+$/, "");
      }
      latex = latex.replace(`${i}`, () => rep);
    }
    const gen: Generated = { slug, latex, files, notePaths: [...notePaths], warnings, usesLinks, usesGraphics, deps };
    if (this.o.mode === "build") {
      const embedAbsPath = path.join(this.o.embedsDir, slug + ".tex");
      const mapAbsPath = path.join(this.o.embedsDir, slug + ".map.json");
      const info: EmbedFileInfo = { embedAbsPath, mapAbsPath, notePath: note.vaultPath, lineMap: result.lineMap };
      gen.files = [info, ...files];
      await fsp.mkdir(this.o.embedsDir, { recursive: true });
      await fsp.writeFile(embedAbsPath, latex, "utf8");
      const json: MapJson = { version: 1, converter: CONVERTER_VERSION, notePath: note.vaultPath, lineMap: result.lineMap, files: gen.files, notePaths: gen.notePaths, warnings, usesLinks, usesGraphics, deps };
      await fsp.writeFile(mapAbsPath, JSON.stringify(json), "utf8");
    }
    return gen;
  }

  private async generateUncachedChild(note: NoteFile, sel: { heading?: string; blockId?: string }, levelIdx: number, stack: string[]): Promise<Generated> {
    const slug = slugify(note.vaultPath, `${sel.heading ?? ""}^${sel.blockId ?? ""}|${levelIdx}|false|${this.o.mode}|${this.o.wikilinkFootnote}|${this.o.highlightEmph}|${this.o.amssymbLoaded}|${this.o.listingsLoaded}`);
    return this.generateUncached(note, sel, levelIdx, false, stack, slug);
  }
}
