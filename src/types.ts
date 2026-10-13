/**
 * Cross-module contracts for TeXPane. Anything in src/core/ may import from here;
 * nothing in src/core/ may import from 'obsidian'.
 */

export type Engine = "pdflatex" | "xelatex" | "lualatex";
export type Severity = "error" | "warning" | "info";

/** One problem found in a TeX log / blg or produced by the embed layer. */
export interface Diagnostic {
  severity: Severity;
  /** File as printed in the log (parser output) or absolute path of the ORIGINAL source file (after mapping). null if unknown. */
  file: string | null;
  line?: number;
  message: string;
  /** Extra context (e.g. the `l.<n> ...` line) */
  raw?: string;
  source?: "tex" | "bibtex" | "biber" | "embed" | "system";
  /** Set when the diagnostic lies inside an embedded vault note. */
  note?: { path: string; line?: number };
}

export interface ProjectInfo {
  /** Absolute path of the root .tex file */
  rootAbsPath: string;
  /** Directory of the root file; latexmk's cwd */
  cwd: string;
  engine: Engine;
  /** Absolute build directory (-outdir) */
  buildDir: string;
}

export interface BuildRequest {
  project: ProjectInfo;
  shellEscape: boolean;
  /** Extra latexmk arguments (already split) */
  extraArgs: string[];
  timeoutMs: number;
  /** Directory with TeX binaries to prepend to PATH (may be null) */
  texBinDir: string | null;
  /** latexmk -g (force) */
  force: boolean;
  /** Absolute vault base path (for embeds); optional when no NoteProvider is used */
  vaultBase?: string;
}

export type BuildStatus = "ok" | "errors" | "failed" | "cancelled" | "timeout" | "no-toolchain";

export interface BuildResult {
  status: BuildStatus;
  exitCode: number | null;
  durationMs: number;
  /** Absolute path of the PDF in the build dir if it exists */
  pdfPath: string | null;
  /** True if the pdf was (re)written during this build */
  pdfUpdated: boolean;
  diagnostics: Diagnostic[];
  rawLog: string;
  /** Tail of latexmk's stdout/stderr (useful when no .log exists) */
  processOutput: string;
  mapping: BuildMapping;
}

/** One embedded-note output file and how to map it back. */
export interface EmbedFileInfo {
  /** Absolute path of the generated embeds/<slug>.tex */
  embedAbsPath: string;
  /** Absolute path of <slug>.map.json */
  mapAbsPath: string;
  /** Vault-relative path of the note, e.g. "Folder/Note.md" */
  notePath: string;
  /** For each output line (index 0 = line 1) the 1-based line in the note (0 = unknown) */
  lineMap: number[];
}

/** Everything needed to translate between original sources and what was compiled. */
export interface BuildMapping {
  /** Absolute path of the file actually passed to latexmk */
  compiledRoot: string;
  /** Original root */
  originalRoot: string;
  /** Folder of the original root */
  originalDir: string;
  /** Shadow dir (abs) or null when no embeds were involved */
  shadowDir: string | null;
  embedsDir: string | null;
  /** Original abs path of each project .tex that was shadow-copied */
  shadowedFiles: string[];
  embeds: EmbedFileInfo[];
  /** Per embed output file: the .tex abs path + 1-based line holding the \obsidian macro (for first use) */
  embedSites: Array<{ embedAbsPath: string; texFile: string; line: number }>;
}

export interface SyncForward {
  page: number;
  /** PDF points from top-left origin of the page */
  x: number;
  y: number;
  h: number;
  v: number;
  W: number;
  H: number;
}

export interface SyncInverse {
  /** As printed by synctex (may be relative) */
  file: string;
  line: number;
  column: number;
}

/** `\obsidian[opts]{target}` occurrence in a .tex file */
export interface EmbedRef {
  /** Offsets into the content: [start, end) covers the whole macro */
  start: number;
  end: number;
  /** 1-based line of the macro start and end */
  line: number;
  endLine: number;
  raw: string;
  /** Raw target text as written (inside braces, trimmed) */
  target: string;
  /** Note part (before # ) */
  note: string;
  heading?: string;
  blockId?: string;
  /** Parsed [key=value,...] */
  options: Record<string, string>;
}

export type SectionLevel = "chapter" | "section" | "subsection" | "subsubsection" | "paragraph" | "subparagraph";

export interface ConvertOptions {
  level: SectionLevel;
  /** Add the note name as a heading first */
  title: boolean;
  noteTitle: string;
  /** [[Note]] -> text + \footnote{Note} */
  wikilinkFootnote: boolean;
  /** ==highlight== as \emph (true) or plain text (false) */
  highlightEmph: boolean;
  amssymbLoaded: boolean;
  listingsLoaded: boolean;
}

export interface ConvertWarning {
  message: string;
  /** line in the note (1-based) */
  line?: number;
}

export interface SerializeResult {
  latex: string;
  /** index i = output line i+1 -> note line (1-based) */
  lineMap: number[];
  warnings: ConvertWarning[];
  /** True if \href / \url were emitted */
  usesLinks: boolean;
  /** True if \includegraphics was emitted */
  usesGraphics: boolean;
}

/** Target of `![[...]]` or `[[...]]` */
export interface WikiTarget {
  note: string;
  heading?: string;
  blockId?: string;
}

/** Callbacks the markdown serializer uses to reach the outside world. */
export interface SerializeContext {
  options: ConvertOptions;
  /**
   * Resolve a nested note embed. Return LaTeX to put at that position (e.g. `\input{tpe-foo-1234abcd}`),
   * or null if it could not be resolved (the serializer then emits an unresolved marker).
   * `levelIndex` is the index (0=chapter..5=subparagraph) of the base level the nested note should start at.
   */
  embedNote(target: WikiTarget, ctx: { levelIndex: number; line: number }): string | null;
  /** Resolve an image reference (wiki `![[x.png]]` name or markdown path) to a TeX-safe file name/path usable in \includegraphics, or null. */
  resolveImage(ref: string, isWiki: boolean): string | null;
  /** Note names referenced by [[wikilinks]] are not resolved; this lets the host decide display text if needed. */
  warn(message: string, line?: number): void;
}

export interface NoteFile {
  /** Vault-relative posix path, e.g. "Folder/Note.md" */
  vaultPath: string;
  absPath: string;
  mtimeMs: number;
  basename: string;
}

/** Host abstraction for reading vault notes (Obsidian impl in main layer, folder impl in tests). */
export interface NoteProvider {
  /** Resolve link text (e.g. "Note", "Folder/Note") from a source file (vault-relative) like Obsidian does. */
  resolve(linkText: string, fromVaultPath?: string): Promise<NoteFile | null>;
  read(note: NoteFile): Promise<string>;
  /** Resolve an attachment reference to an absolute path (null if missing) */
  resolveAsset(ref: string, fromNote: NoteFile | null): Promise<string | null>;
}

export interface ToolInfo {
  path: string;
  version: string;
}

export interface ToolchainInfo {
  found: boolean;
  /** Directory containing latexmk (to prepend to PATH) */
  binDir: string | null;
  latexmk: ToolInfo | null;
  synctex: ToolInfo | null;
  texcount: ToolInfo | null;
  biber: ToolInfo | null;
  bibtex: ToolInfo | null;
  engines: Record<Engine, ToolInfo | null>;
  /** Names of required tools not found */
  missing: string[];
  platform: string;
}

export interface LabelEntry {
  label: string;
  file: string;
  line: number;
}
export interface BibEntry {
  key: string;
  type: string;
  title?: string;
  file: string;
  line: number;
}
export interface OutlineItem {
  /** 0 = part, 1 = chapter, 2 = section, 3 = subsection, 4 = subsubsection, 5 = paragraph, 6 = subparagraph */
  depth: number;
  kind: string;
  title: string;
  line: number;
  starred: boolean;
}
