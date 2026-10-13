import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { math } from "micromark-extension-math";
import { mathFromMarkdown } from "mdast-util-math";
import type { ConvertWarning, SectionLevel, SerializeContext, SerializeResult, WikiTarget } from "../../types";
import { parseEmbedTarget } from "../embedScanner";
import { splitSentinels } from "./sentinels";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
interface Line {
  t: string;
  n: number;
}

export const LEVELS: SectionLevel[] = ["chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif", "tif", "tiff"]);
const MEDIA_EXT = new Set(["pdf", "mp3", "mp4", "webm", "ogg", "wav", "mov", "m4a", "mkv", "flac", "3gp", "ogv"]);
const UNSUPPORTED_FENCE = new Set(["dataview", "dataviewjs", "tasks", "query", "mermaid", "chart", "excalidraw", "button", "meta-bind-button"]);
const MATH_ENV = /^\s*\\begin\{(equation|align|gather|multline|flalign|alignat|eqnarray|displaymath|math)(\*?)\}[\s\S]*\\end\{\1\2\}\s*$/;

const ESC: Record<string, string> = {
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
  "\\": "\\textbackslash{}",
  "<": "\\textless{}",
  ">": "\\textgreater{}",
  "|": "\\textbar{}",
};
export function escapeTex(s: string): string {
  return s.replace(/[&%$#_{}~^\\<>|]/g, (c) => ESC[c]);
}
function escapeUrl(u: string): string {
  return u.replace(/[%#&]/g, (c) => "\\" + c);
}

const HL_O = "";
const HL_C = "";
const PH_RE = /(\d+)/g;

class Serializer {
  warnings: ConvertWarning[] = [];
  usesLinks = false;
  usesGraphics = false;
  private blocks: string[][] = [];
  private footnotes = new Map<string, N>();
  private baseIdx: number;
  private contentBase: number;
  private minDepth = 1;
  private curLevel = -1;
  private htmlWarned = false;

  constructor(private src: string, private ctx: SerializeContext) {
    this.baseIdx = Math.max(0, LEVELS.indexOf(ctx.options.level));
    this.contentBase = ctx.options.title ? Math.min(this.baseIdx + 1, 5) : this.baseIdx;
  }

  warn(message: string, line?: number) {
    this.warnings.push({ message, line });
    this.ctx.warn(message, line);
  }

  run(): SerializeResult {
    const tree: N = fromMarkdown(this.src, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
    let minDepth = 7;
    const visit = (n: N) => {
      if (n.type === "heading") minDepth = Math.min(minDepth, n.depth);
      if (n.type === "footnoteDefinition") this.footnotes.set(n.identifier, n);
      if (n.children && n.type !== "blockquote" && n.type !== "listItem") n.children.forEach(visit);
    };
    visit(tree);
    this.minDepth = minDepth === 7 ? 1 : minDepth;
    const lines: Line[] = [];
    if (this.ctx.options.title) {
      lines.push({ t: `\\${LEVELS[this.baseIdx]}{${escapeTex(this.ctx.options.noteTitle)}}`, n: 1 });
    }
    const body = this.blockList(tree.children ?? []);
    if (lines.length && body.length) lines.push({ t: "", n: 1 });
    lines.push(...body);
    let latex = "";
    let lineMap: number[] = [];
    if (lines.length) {
      latex = lines.map((l) => l.t).join("\n") + "\n";
      lineMap = lines.map((l) => l.n);
      lineMap.push(lineMap[lineMap.length - 1]);
    } else lineMap = [0];
    return { latex, lineMap, warnings: this.warnings, usesLinks: this.usesLinks, usesGraphics: this.usesGraphics };
  }

  // ---------- blocks ----------
  private blockList(nodes: N[]): Line[] {
    const out: Line[] = [];
    for (const node of nodes) {
      const ls = this.block(node);
      if (!ls.length) continue;
      if (out.length) out.push({ t: "", n: out[out.length - 1].n });
      out.push(...ls);
    }
    return out;
  }

  private startLine(n: N): number {
    return n.position?.start?.line ?? 0;
  }

  private mapText(text: string, startLine: number, endLine?: number): Line[] {
    return text.split("\n").map((t, j) => ({ t, n: Math.min(endLine ?? startLine + j, startLine + j) }));
  }

  private block(node: N): Line[] {
    const sl = this.startLine(node);
    switch (node.type) {
      case "heading": {
        const idx = Math.min(5, this.contentBase + (node.depth - this.minDepth));
        this.curLevel = idx;
        const text = this.inl(node.children, 1).replace(/\s*\n\s*/g, " ").trim();
        return [{ t: `\\${LEVELS[idx]}{${text}}`, n: sl }];
      }
      case "paragraph":
        return this.paragraph(node);
      case "list":
        return this.list(node);
      case "table":
        return this.table(node);
      case "code":
        return this.code(node);
      case "blockquote":
        return this.quote(node);
      case "thematicBreak":
        return [{ t: "\\par\\noindent\\rule{\\linewidth}{0.4pt}\\par", n: sl }];
      case "math":
        return this.mathBlock(node);
      case "html": {
        const v = String(node.value).trim();
        if (/^<!--[\s\S]*-->$/.test(v)) return [];
        if (/^<br\s*\/?>$/i.test(v)) return [{ t: "\\par", n: sl }];
        this.warn("HTML is not supported and was replaced by a placeholder", sl);
        return [{ t: "\\texttt{[unsupported: html]}", n: sl }];
      }
      case "definition":
      case "footnoteDefinition":
      case "yaml":
        return [];
      default:
        if (node.children) return this.blockList(node.children);
        return node.value ? this.mapText(escapeTex(String(node.value)), sl) : [];
    }
  }

  private paragraph(node: N): Line[] {
    const sl = this.startLine(node);
    const el = node.position?.end?.line ?? sl;
    const s = this.inl(node.children, 0);
    const out: Line[] = [];
    let last = 0;
    const pushText = (text: string, before: string) => {
      const trimmed = text.replace(/^\n+|\n+$/g, "");
      if (!trimmed.trim()) return;
      const off = before.split("\n").length - 1 + (text.length - text.replace(/^\n+/, "").length);
      out.push(...this.mapText(trimmed, sl + off, el));
    };
    const re = new RegExp(PH_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      pushText(s.slice(last, m.index), s.slice(0, last));
      const off = s.slice(0, m.index).split("\n").length - 1;
      if (out.length) out.push({ t: "", n: out[out.length - 1].n });
      for (const l of this.blocks[Number(m[1])]) out.push({ t: l, n: Math.min(el, sl + off) });
      last = m.index + m[0].length;
      if (last < s.length) out.push({ t: "", n: Math.min(el, sl + off) });
    }
    pushText(s.slice(last), s.slice(0, last));
    while (out.length && out[out.length - 1].t === "") out.pop();
    return out;
  }

  private list(node: N): Line[] {
    const env = node.ordered ? "enumerate" : "itemize";
    const out: Line[] = [{ t: `\\begin{${env}}`, n: this.startLine(node) }];
    for (const item of node.children ?? []) {
      const sl = this.startLine(item);
      let label = "";
      if (item.checked === true) label = this.ctx.options.amssymbLoaded ? "[$\\checkmark$]" : "[{[x]}]";
      else if (item.checked === false) label = this.ctx.options.amssymbLoaded ? "[$\\square$]" : "[{[ ]}]";
      const kids: N[] = item.children ?? [];
      let first: Line[] = [];
      let rest = kids;
      if (kids[0]?.type === "paragraph") {
        first = this.paragraph(kids[0]);
        rest = kids.slice(1);
      }
      if (first.length) {
        if (first[0].t.startsWith("[")) first[0] = { ...first[0], t: "{}" + first[0].t };
        first[0] = { ...first[0], t: `\\item${label} ${first[0].t}`.replace("\\item ", "\\item ") };
        out.push(...first);
      } else out.push({ t: `\\item${label}`, n: sl });
      for (const k of rest) {
        const ls = this.block(k);
        out.push(...ls);
      }
    }
    out.push({ t: `\\end{${env}}`, n: node.position?.end?.line ?? this.startLine(node) });
    return out;
  }

  private table(node: N): Line[] {
    const sl = this.startLine(node);
    const align: Array<string | null> = node.align ?? [];
    const rows: N[] = node.children ?? [];
    const cols = Math.max(align.length, ...rows.map((r) => (r.children ?? []).length), 1);
    const spec = Array.from({ length: cols }, (_, i) => (align[i] === "right" ? "r" : align[i] === "center" ? "c" : "l")).join("");
    const out: Line[] = [
      { t: "\\begin{center}", n: sl },
      { t: `\\begin{tabular}{${spec}}`, n: sl },
      { t: "\\hline", n: sl },
    ];
    rows.forEach((row, ri) => {
      const cells = (row.children ?? []).map((c: N) => this.inl(c.children ?? [], 1).replace(/\s*\n\s*/g, " ").trim());
      while (cells.length < cols) cells.push("");
      out.push({ t: cells.join(" & ") + " \\\\", n: this.startLine(row) });
      if (ri === 0) out.push({ t: "\\hline", n: this.startLine(row) });
    });
    out.push({ t: "\\hline", n: node.position?.end?.line ?? sl });
    out.push({ t: "\\end{tabular}", n: node.position?.end?.line ?? sl });
    out.push({ t: "\\end{center}", n: node.position?.end?.line ?? sl });
    return out;
  }

  private code(node: N): Line[] {
    const sl = this.startLine(node);
    const lang = String(node.lang ?? "").toLowerCase().split(/[\s{]/)[0];
    if (UNSUPPORTED_FENCE.has(lang)) {
      this.warn(`Unsupported code block type "${lang}" was replaced by a placeholder`, sl);
      return [{ t: `\\texttt{[unsupported: ${escapeTex(lang)} block]}`, n: sl }];
    }
    const env = this.ctx.options.listingsLoaded ? "lstlisting" : "verbatim";
    const value = String(node.value ?? "").replace(/\\end\{(verbatim|lstlisting)\}/g, "\\end{ $1}");
    const out: Line[] = [{ t: `\\begin{${env}}`, n: sl }];
    value.split("\n").forEach((l, j) => out.push({ t: l, n: sl + 1 + j }));
    out.push({ t: `\\end{${env}}`, n: node.position?.end?.line ?? sl });
    return out;
  }

  private quote(node: N): Line[] {
    const sl = this.startLine(node);
    const kids: N[] = [...(node.children ?? [])];
    let titleLine: string | null = null;
    const p = kids[0];
    if (p?.type === "paragraph") {
      const ch: N[] = p.children ?? [];
      let lead = "";
      let k = 0;
      while (k < ch.length && ch[k].type === "text") lead += ch[k++].value;
      const m = /^\[!([A-Za-z0-9-]+)\][+-]?[ \t]*([^\n]*)/.exec(lead);
      if (m) {
        const type = m[1];
        // split the paragraph at the first newline
        const titleNodes: N[] = [];
        const bodyNodes: N[] = [];
        let seenNl = false;
        let consumedHeader = false;
        for (const c of ch) {
          if (seenNl) {
            bodyNodes.push(c);
            continue;
          }
          if (c.type === "text") {
            let v: string = c.value;
            if (!consumedHeader) {
              v = v.replace(/^\[![A-Za-z0-9-]+\][+-]?[ \t]*/, "");
              consumedHeader = true;
            }
            const nl = v.indexOf("\n");
            if (nl >= 0) {
              if (v.slice(0, nl)) titleNodes.push({ type: "text", value: v.slice(0, nl) });
              const after = v.slice(nl + 1);
              if (after) bodyNodes.push({ type: "text", value: after });
              seenNl = true;
            } else if (v) titleNodes.push({ type: "text", value: v });
          } else if (c.type === "break") seenNl = true;
          else titleNodes.push(c);
        }
        const title = this.inl(titleNodes, 1).trim();
        titleLine = `\\textbf{${title || escapeTex(type.charAt(0).toUpperCase() + type.slice(1))}}`;
        kids.shift();
        if (bodyNodes.length) kids.unshift({ type: "paragraph", children: bodyNodes, position: p.position });
      }
    }
    const out: Line[] = [{ t: "\\begin{quote}", n: sl }];
    const inner = this.blockList(kids);
    if (titleLine) {
      out.push({ t: titleLine, n: sl });
      if (inner.length) out.push({ t: "", n: sl });
    }
    out.push(...inner);
    out.push({ t: "\\end{quote}", n: node.position?.end?.line ?? sl });
    return out;
  }

  private mathBlock(node: N): Line[] {
    const sl = this.startLine(node);
    const v = String(node.value);
    if (MATH_ENV.test(v)) return this.mapText(v.trim(), sl + 1);
    return [{ t: "\\[", n: sl }, ...this.mapText(v, sl + 1), { t: "\\]", n: node.position?.end?.line ?? sl }];
  }

  // ---------- inline ----------
  private placeholder(lines: string[]): string {
    this.blocks.push(lines);
    return `${this.blocks.length - 1}`;
  }

  inl(nodes: N[], depth: number): string {
    let s = nodes.map((n) => this.inlNode(n, depth)).join("");
    if (s.includes(HL_O) || s.includes(HL_C)) s = this.resolveHighlights(s);
    return s;
  }

  private resolveHighlights(s: string): string {
    const emph = this.ctx.options.highlightEmph;
    let out = "";
    let open = 0;
    for (const ch of s) {
      if (ch === HL_O) {
        open++;
        out += emph ? "\\emph{" : "";
      } else if (ch === HL_C) {
        if (open > 0) {
          open--;
          out += emph ? "}" : "";
        }
      } else out += ch;
    }
    if (emph) out += "}".repeat(open);
    return out;
  }

  private inlNode(n: N, depth: number): string {
    switch (n.type) {
      case "text":
        return this.text(n, depth);
      case "emphasis":
        return `\\emph{${this.inl(n.children, depth + 1)}}`;
      case "strong":
        return `\\textbf{${this.inl(n.children, depth + 1)}}`;
      case "delete":
        return this.inl(n.children, depth + 1);
      case "inlineCode":
        return `\\texttt{${escapeTex(String(n.value))}}`;
      case "inlineMath": {
        const off = n.position?.start?.offset;
        const display = off !== undefined && this.src.startsWith("$$", off);
        const v = String(n.value);
        if (display && depth === 0) return MATH_ENV.test(v) ? v.trim() : `\\[${v}\\]`;
        return `$${v}$`;
      }
      case "break":
        return "\\\\\n";
      case "link":
        return this.link(n, depth);
      case "linkReference":
      case "imageReference":
        return n.children ? this.inl(n.children, depth + 1) : escapeTex(String(n.alt ?? ""));
      case "image":
        return this.image(String(n.url ?? ""), false, n.alt ?? "", "", this.startLine(n), depth);
      case "footnoteReference": {
        const def = this.footnotes.get(n.identifier);
        if (!def) {
          this.warn(`Footnote [^${n.identifier}] has no definition`, this.startLine(n));
          return "";
        }
        const text = (def.children ?? []).map((c: N) => (c.type === "paragraph" ? this.inl(c.children, 1) : this.inl(c.children ?? [], 1))).join(" ").replace(/\s*\n\s*/g, " ").trim();
        return `\\footnote{${text}}`;
      }
      case "html": {
        const v = String(n.value);
        if (/^<br\s*\/?>$/i.test(v)) return "\\\\\n";
        if (/^<!--/.test(v)) return "";
        if (!this.htmlWarned) {
          this.htmlWarned = true;
          this.warn("Inline HTML tags were stripped", this.startLine(n));
        }
        return "";
      }
      default:
        if (n.children) return this.inl(n.children, depth + 1);
        return n.value ? escapeTex(String(n.value)) : "";
    }
  }

  private link(n: N, depth: number): string {
    const url = String(n.url ?? "");
    const kids: N[] = n.children ?? [];
    const plain = kids.length === 1 && kids[0].type === "text" ? String(kids[0].value) : null;
    if (/^(https?:|ftp:|mailto:)/i.test(url)) {
      this.usesLinks = true;
      if (plain !== null && (plain === url || "mailto:" + plain === url)) {
        // \% \# \& print literally with url.sty (only hyperref unescapes them), so such URLs go through \href
        if (!/[%#&]/.test(url)) return `\\url{${url}}`;
        return `\\href{${escapeUrl(url)}}{\\texttt{${escapeTex(plain)}}}`;
      }
      return `\\href{${escapeUrl(url)}}{${this.inl(kids, depth + 1)}}`;
    }
    return this.inl(kids, depth + 1);
  }

  private text(n: N, depth: number): string {
    const value = String(n.value);
    const sl = this.startLine(n);
    let out = "";
    let consumed = 0;
    for (const part of splitSentinels(value)) {
      if (typeof part === "string") {
        out += escapeTex(part);
        consumed += part.length;
        continue;
      }
      const line = sl + (value.slice(0, consumed).match(/\n/g)?.length ?? 0);
      consumed += 1;
      switch (part.kind) {
        case "hlOpen":
          out += HL_O;
          break;
        case "hlClose":
          out += HL_C;
          break;
        case "wikilink": {
          const p = parseEmbedTarget(part.target);
          const display = part.alias || (p.heading ? `${p.note ? p.note + " > " : ""}${p.heading}` : p.blockId ? p.note : p.note) || part.target;
          out += escapeTex(display);
          if (this.ctx.options.wikilinkFootnote) out += `\\footnote{${escapeTex(part.target)}}`;
          break;
        }
        case "embed":
          out += this.embed(part.target, part.extra, line, depth);
          break;
      }
    }
    return out;
  }

  private embed(target: string, extra: string, line: number, depth: number): string {
    const p = parseEmbedTarget(target);
    const ext = /\.([A-Za-z0-9]+)$/.exec(p.note)?.[1]?.toLowerCase() ?? "";
    if (IMAGE_EXT.has(ext)) return this.image(p.note, true, "", extra, line, depth);
    if (MEDIA_EXT.has(ext)) {
      this.warn(`Embedded ${ext.toUpperCase()} file "${p.note}" is not supported`, line);
      return `\\texttt{[unsupported: ${escapeTex(p.note)}]}`;
    }
    const wt: WikiTarget = { note: p.note, heading: p.heading, blockId: p.blockId };
    const levelIndex = this.curLevel >= 0 ? Math.min(5, this.curLevel + 1) : this.contentBase;
    const res = this.ctx.embedNote(wt, { levelIndex, line });
    if (res === null) {
      this.warn(`Embedded note "${target}" could not be found`, line);
      return `\\texttt{[unresolved embed: ${escapeTex(p.note)}]}`;
    }
    const lines = res.replace(/\n+$/, "").split("\n");
    return depth === 0 ? this.placeholder(lines) : lines.join("\n");
  }

  private image(ref: string, isWiki: boolean, alt: string, extra: string, line: number, depth: number): string {
    let url = ref;
    let size = extra;
    if (!isWiki) {
      const sm = /\|(\d+)(?:x(\d+))?\s*$/.exec(alt);
      if (sm) size = sm[2] ? `${sm[1]}x${sm[2]}` : sm[1];
      if (/^(https?:|data:)/i.test(url)) {
        this.warn(`Remote image "${url.slice(0, 60)}" is not downloaded`, line);
        return `\\texttt{[missing image: remote]}`;
      }
      try {
        url = decodeURIComponent(url);
      } catch {
        /* keep */
      }
    }
    const resolved = this.ctx.resolveImage(url, isWiki);
    if (!resolved) {
      this.warn(`Image "${url}" could not be found`, line);
      return `\\texttt{[missing image: ${escapeTex(url)}]}`;
    }
    this.usesGraphics = true;
    const sm = /^(\d+)(?:x(\d+))?$/.exec(size.trim());
    const opts = sm ? (sm[2] ? `width=${sm[1]}bp,height=${sm[2]}bp` : `width=${sm[1]}bp`) : "width=\\linewidth";
    const lines = ["\\begin{figure}[h]", "\\centering", `\\includegraphics[${opts}]{${resolved}}`, "\\end{figure}"];
    return depth === 0 ? this.placeholder(lines) : lines.join("\n");
  }
}

export function serializeMarkdown(markdown: string, ctx: SerializeContext): SerializeResult {
  return new Serializer(markdown, ctx).run();
}
