import { StreamLanguage, HighlightStyle, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { Tag } from "@lezer/highlight";
import { stex } from "@codemirror/legacy-modes/mode/stex";

/** Custom highlight tags bound to the Parchment & Ink tokens (--tp-syn-*) in styles.css */
export const tpCommand = Tag.define();
export const tpEnv = Tag.define();
export const tpMath = Tag.define();
export const tpArg = Tag.define();
export const tpRef = Tag.define();
export const tpComment = Tag.define();
export const tpHeading = Tag.define();

const MATH_ENVS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "eqnarray", "eqnarray*", "displaymath", "flalign", "flalign*", "alignat", "alignat*", "math"]);
const HEADING_CMDS = new Set(["\\part", "\\chapter", "\\section", "\\subsection", "\\subsubsection", "\\paragraph", "\\subparagraph", "\\title", "\\caption"]);
const REF_CMDS = /^\\(label|ref|eqref|pageref|autoref|cref|Cref|nameref|vref|cite[a-z]*|Cite[a-z]*|parencite|textcite|autocite|footcite|nocite|bibitem|hyperref|crefrange)$/;
const ENV_CMDS = new Set(["\\begin", "\\end"]);

type Kind = "arg" | "ref" | "env" | "heading" | "group";
interface TState {
  inner: any;
  math: boolean; // inside $..$, $$..$$, \[..\], \(..\)
  envMath: number;
  stack: Kind[];
  lastCmd: string | null;
  /** current env name being read inside \begin{...} / \end{...} */
  envName: string;
  envCmd: string | null;
}

const parser: StreamParser<TState> = {
  name: "texpane-latex",
  startState(): TState {
    return { inner: stex.startState!(0), math: false, envMath: 0, stack: [], lastCmd: null, envName: "", envCmd: null };
  },
  copyState(s: TState): TState {
    return { inner: stex.copyState!(s.inner), math: s.math, envMath: s.envMath, stack: s.stack.slice(), lastCmd: s.lastCmd, envName: s.envName, envCmd: s.envCmd };
  },
  blankLine(s: TState) {
    stex.blankLine?.(s.inner, 0);
    s.math = false;
    s.stack.length = 0;
    s.lastCmd = null;
  },
  token(stream, s): string | null {
    const raw = stex.token(stream, s.inner) as string | null;
    const text = stream.current();
    if (raw === "comment") return "tp-comment";
    const trimmed = text.trim();
    if (raw === "error") {
      // unmatched brace tracking in stex is line-local; do not paint noise
      if (trimmed === "}" || trimmed === "]") {
        s.stack.pop();
      }
      return null;
    }
    // math delimiters
    if (raw === "keyword" && /^(\$\$?|\\\[|\\\]|\\\(|\\\))$/.test(trimmed)) {
      s.math = !s.math;
      s.lastCmd = null;
      return "tp-math";
    }
    const inEnvArg = s.stack[s.stack.length - 1] === "env" || (s.lastCmd !== null && ENV_CMDS.has(s.lastCmd) && raw === "bracket" && trimmed === "{");
    const isEnvCmd = raw === "tag" && ENV_CMDS.has(trimmed);
    if ((s.math || s.envMath > 0) && !inEnvArg && !isEnvCmd) return "tp-math";

    if (raw === "tag") {
      if (/^\\[a-zA-Z@]/.test(trimmed)) s.lastCmd = trimmed;
      return "tp-command";
    }
    if (raw === "bracket") {
      if (trimmed === "{" || trimmed === "[") {
        const parent = s.stack[s.stack.length - 1];
        let kind: Kind;
        if (s.lastCmd) {
          kind = ENV_CMDS.has(s.lastCmd) ? "env" : REF_CMDS.test(s.lastCmd) ? "ref" : HEADING_CMDS.has(s.lastCmd) && trimmed === "{" ? "heading" : "arg";
          if (ENV_CMDS.has(s.lastCmd) && trimmed === "{") {
            s.envName = "";
            s.envCmd = s.lastCmd;
          }
        } else kind = parent && parent !== "group" ? parent : "group";
        s.stack.push(kind);
        return "tp-arg";
      }
      if (trimmed === "}" || trimmed === "]") {
        const k = s.stack.pop();
        if (k === "env" && s.envCmd) {
          const name = s.envName;
          if (MATH_ENVS.has(name)) s.envMath = s.envCmd === "\\begin" ? s.envMath + 1 : Math.max(0, s.envMath - 1);
          s.envName = "";
          s.envCmd = null;
        }
        // keep lastCmd so that \href{a}{b} multi-arg sequences stay attached
        return k === "env" ? "tp-env" : "tp-arg";
      }
      return "tp-arg";
    }
    // plain text-like tokens
    if (trimmed !== "" && trimmed !== "*") s.lastCmd = null;
    const top = s.stack[s.stack.length - 1];
    if (top === "env" && trimmed) {
      s.envName += trimmed;
      return "tp-env";
    }
    if (top === "ref" && trimmed) return "tp-ref";
    if (top === "heading" && trimmed) return "tp-heading";
    if (top === "arg" && trimmed) return "tp-arg";
    if (raw === "atom" || raw === "string" || raw === "builtin") return top ? "tp-arg" : null;
    return null;
  },
  languageData: {
    commentTokens: { line: "%" },
    closeBrackets: { brackets: ["(", "[", "{", "$"] },
    indentOnInput: /^\s*\\(end|else|fi)\b/,
  },
  tokenTable: {
    "tp-comment": tpComment,
    "tp-math": tpMath,
    "tp-command": tpCommand,
    "tp-arg": tpArg,
    "tp-env": tpEnv,
    "tp-ref": tpRef,
    "tp-heading": tpHeading,
  },
};

export const latexLanguage = StreamLanguage.define(parser);

export const texpaneHighlight = HighlightStyle.define([
  { tag: tpCommand, class: "tp-tok-command" },
  { tag: tpEnv, class: "tp-tok-env" },
  { tag: tpMath, class: "tp-tok-math" },
  { tag: tpArg, class: "tp-tok-arg" },
  { tag: tpRef, class: "tp-tok-ref" },
  { tag: tpComment, class: "tp-tok-comment" },
  { tag: tpHeading, class: "tp-tok-heading" },
]);

export function latexSyntax() {
  return [latexLanguage, syntaxHighlighting(texpaneHighlight)];
}

/** BibTeX is highlighted with a tiny dedicated parser (entries, keys, fields, comments). */
const bibParser: StreamParser<{ depth: number }> = {
  name: "texpane-bibtex",
  startState: () => ({ depth: 0 }),
  copyState: (s) => ({ depth: s.depth }),
  token(stream, s) {
    if (stream.sol() && stream.match(/^@[A-Za-z]+/)) return "tp-command";
    if (stream.match(/^%.*/)) return "tp-comment";
    if (stream.eatSpace()) return null;
    if (stream.match(/^[{(]/)) {
      s.depth++;
      return "tp-arg";
    }
    if (stream.match(/^[})]/)) {
      s.depth = Math.max(0, s.depth - 1);
      return "tp-arg";
    }
    if (s.depth === 1 && stream.match(/^[A-Za-z_][\w-]*(?=\s*=)/)) return "tp-env";
    if (s.depth === 1 && stream.match(/^[^\s,={}()"]+(?=\s*,)/)) return "tp-ref";
    stream.next();
    return s.depth > 0 ? "tp-arg" : null;
  },
  tokenTable: { "tp-comment": tpComment, "tp-command": tpCommand, "tp-arg": tpArg, "tp-env": tpEnv, "tp-ref": tpRef },
};
export const bibLanguage = StreamLanguage.define(bibParser);
export function bibSyntax() {
  return [bibLanguage, syntaxHighlighting(texpaneHighlight)];
}
