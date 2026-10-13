import * as path from "node:path";
import type { BibEntry, LabelEntry, OutlineItem } from "../types";

/** Strip a trailing TeX comment (first unescaped %). */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") i++;
    else if (c === "%") return line.slice(0, i);
  }
  return line;
}

function eachCodeLine(text: string, fn: (line: string, no: number) => void) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) fn(stripComment(lines[i]), i + 1);
}

export function extractLabels(text: string, file: string): LabelEntry[] {
  const out: LabelEntry[] = [];
  eachCodeLine(text, (l, no) => {
    for (const m of l.matchAll(/\\label\s*\{([^}]*)\}/g)) out.push({ label: m[1].trim(), file, line: no });
  });
  return out;
}

export function extractBibEntries(text: string, file: string): BibEntry[] {
  const out: BibEntry[] = [];
  const re = /^[ \t]*@([A-Za-z]+)[ \t]*[{(][ \t]*([^,\s]+)[ \t]*,/gm;
  const starts: Array<{ idx: number; type: string; key: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const type = m[1].toLowerCase();
    if (["comment", "string", "preamble"].includes(type)) continue;
    starts.push({ idx: m.index, type, key: m[2] });
  }
  const allAt = [...text.matchAll(/^[ \t]*@/gm)].map((x) => x.index ?? 0);
  for (const s of starts) {
    const next = allAt.find((i) => i > s.idx);
    const body = text.slice(s.idx, next ?? text.length);
    const tm = /\btitle\s*=\s*(?:\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}|"([^"]*)")/i.exec(body);
    const line = text.slice(0, s.idx).split("\n").length + (text.slice(s.idx).match(/^[ \t]*\n*/)?.[0].split("\n").length ?? 1) - 1;
    out.push({ key: s.key, type: s.type, title: tm ? (tm[1] ?? tm[2]) : undefined, file, line });
  }
  return out;
}

export function extractInputs(text: string): string[] {
  const out: string[] = [];
  eachCodeLine(text, (l) => {
    for (const m of l.matchAll(/\\(?:input|include|subfile|subfileinclude)\s*\{([^}]*)\}/g)) out.push(m[1].trim().replace(/^"(.*)"$/, "$1"));
  });
  return out;
}

export function extractBibResources(text: string): string[] {
  const out: string[] = [];
  eachCodeLine(text, (l) => {
    for (const m of l.matchAll(/\\bibliography\s*\{([^}]*)\}/g)) out.push(...m[1].split(",").map((s) => s.trim()).filter(Boolean));
    for (const m of l.matchAll(/\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) out.push(m[1].trim());
  });
  return out;
}

export function detectPackages(text: string): Set<string> {
  const out = new Set<string>();
  eachCodeLine(text, (l) => {
    for (const m of l.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) for (const p of m[1].split(",")) if (p.trim()) out.add(p.trim());
  });
  return out;
}

const SECTION_DEPTH: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };

export function extractSections(text: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  eachCodeLine(text, (l, no) => {
    const m = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*)?\s*(?:\[[^\]]*\])?\s*\{/.exec(l);
    if (!m) return;
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < l.length; i++) {
      if (l[i] === "\\") i++;
      else if (l[i] === "{") depth++;
      else if (l[i] === "}" && --depth === 0) break;
    }
    out.push({ depth: SECTION_DEPTH[m[1]], kind: m[1], title: l.slice(start, i).trim(), line: no, starred: !!m[2] });
  });
  return out;
}

export interface IndexFs {
  readFile(abs: string): Promise<string | null>;
  listBibFiles(dir: string): Promise<string[]>;
}

interface TexData {
  labels: LabelEntry[];
  inputs: string[];
  bibs: string[];
  sections: OutlineItem[];
}

export class ProjectIndex {
  private root = "";
  private rootDir = "";
  private tex = new Map<string, TexData>();
  private bib = new Map<string, BibEntry[]>();
  private declaredBibs = false;

  constructor(private fs: IndexFs) {}

  private resolveInput(name: string, from: string, ext: string): string[] {
    const n = /\.[A-Za-z0-9]+$/.test(name) ? name : name + ext;
    const cands = [path.resolve(this.rootDir, n), path.resolve(path.dirname(from), n)];
    return [...new Set(cands)];
  }

  private async readTex(abs: string): Promise<TexData | null> {
    const text = await this.fs.readFile(abs);
    if (text === null) return null;
    return { labels: extractLabels(text, abs), inputs: extractInputs(text), bibs: extractBibResources(text), sections: extractSections(text) };
  }

  private async readBib(abs: string) {
    const text = await this.fs.readFile(abs);
    this.bib.set(abs, text === null ? [] : extractBibEntries(text, abs));
  }

  private async addTex(abs: string) {
    const queue = [abs];
    while (queue.length) {
      const f = queue.pop()!;
      if (this.tex.has(f)) continue;
      const d = await this.readTex(f);
      if (!d) continue;
      this.tex.set(f, d);
      for (const inp of d.inputs) {
        for (const c of this.resolveInput(inp, f, ".tex")) {
          if (!this.tex.has(c) && (await this.fs.readFile(c)) !== null) {
            queue.push(c);
            break;
          }
        }
      }
    }
  }

  async build(rootAbs: string): Promise<void> {
    this.root = path.resolve(rootAbs);
    this.rootDir = path.dirname(this.root);
    this.tex.clear();
    this.bib.clear();
    await this.addTex(this.root);
    await this.loadBibs();
  }

  private async loadBibs() {
    const declared = new Set<string>();
    for (const [f, d] of this.tex) for (const b of d.bibs) for (const c of this.resolveInput(b, f, ".bib")) declared.add(c);
    this.declaredBibs = declared.size > 0;
    const list = this.declaredBibs ? [...declared] : await this.fs.listBibFiles(this.rootDir);
    for (const f of [...this.bib.keys()]) if (!list.includes(f)) this.bib.delete(f);
    for (const f of list) await this.readBib(path.resolve(f));
  }

  async update(file: string): Promise<void> {
    const abs = path.resolve(file);
    if (abs.toLowerCase().endsWith(".bib")) {
      await this.readBib(abs);
      return;
    }
    if (!this.tex.has(abs)) return;
    const d = await this.readTex(abs);
    if (!d) {
      this.tex.delete(abs);
      return;
    }
    this.tex.set(abs, d);
    for (const inp of d.inputs) for (const c of this.resolveInput(inp, abs, ".tex")) if (!this.tex.has(c)) await this.addTex(c);
    await this.loadBibs();
  }

  files(): string[] {
    return [...this.tex.keys()];
  }
  labels(): LabelEntry[] {
    return [...this.tex.values()].flatMap((d) => d.labels);
  }
  bibEntries(): BibEntry[] {
    return [...this.bib.values()].flat();
  }
  outline(file: string): OutlineItem[] {
    return this.tex.get(path.resolve(file))?.sections ?? [];
  }
  has(file: string): boolean {
    const a = path.resolve(file);
    return this.tex.has(a) || this.bib.has(a);
  }
}
