/**
 * Fallback definitions for the leanblueprint macros. A blueprint document normally gets them from the
 * leanblueprint "print" macros; a plain LaTeX document that only uses them (\lean{..}, \leanok, ...) would
 * otherwise stop with "Undefined control sequence". Pure.
 */
import { stripComment } from "./indexers";

export interface BlueprintMacro {
  name: string;
  /** Number of mandatory arguments */
  args: number;
}

export const BLUEPRINT_MACROS: readonly BlueprintMacro[] = [
  { name: "lean", args: 1 },
  { name: "leanok", args: 0 },
  { name: "uses", args: 1 },
  { name: "mathlibok", args: 0 },
  { name: "notready", args: 0 },
  { name: "proves", args: 1 },
  { name: "discussion", args: 1 },
];

const usedRe = (name: string) => new RegExp(`\\\\${name}(?![A-Za-z@])`);
/** \newcommand{\x}, \renewcommand*\x, \providecommand, \DeclareRobustCommand, \NewDocumentCommand, \def\x, \let\x, \edef, \gdef, \xdef */
const definedRe = (name: string) =>
  new RegExp(`\\\\(?:(?:re|provide)?newcommand|DeclareRobustCommand|(?:New|Renew|Provide|Declare)DocumentCommand|DeclareMathOperator|[gex]?def|let)\\*?\\s*\\{?\\s*\\\\${name}(?![A-Za-z@])`);

function codeOf(text: string): string {
  return text.split(/\r?\n/).map(stripComment).join("\n");
}

/** True when any of the blueprint macros appears in the text (outside comments). */
export function usesBlueprintMacros(text: string): boolean {
  const code = codeOf(text);
  return BLUEPRINT_MACROS.some((m) => usedRe(m.name).test(code));
}

/**
 * `\AtBeginDocument{\providecommand...}` with a no-op for every blueprint macro that the project does not
 * define itself, or "" when the project does not use the macros at all (so ordinary documents compile untouched).
 * `\AtBeginDocument` runs after the preamble: a definition that comes from an \input file or a package wins,
 * and nothing is "already defined" when the document's own \newcommand runs. The text is one line so it can
 * sit on the \documentclass line without moving any line numbers.
 */
export function blueprintFallbackMacros(files: Iterable<string>, packages: ReadonlySet<string>): string {
  if (packages.has("blueprint")) return "";
  const codes = [...files].map(codeOf);
  if (!codes.some((c) => BLUEPRINT_MACROS.some((m) => usedRe(m.name).test(c)))) return "";
  const missing = BLUEPRINT_MACROS.filter((m) => !codes.some((c) => definedRe(m.name).test(c)));
  if (!missing.length) return "";
  const defs = missing.map((m) => `\\providecommand{\\${m.name}}${m.args ? `[${m.args}]` : ""}{}`).join("");
  return `\\AtBeginDocument{${defs}}`;
}
