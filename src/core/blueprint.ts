/**
 * Blueprint (leanblueprint-style) parser. Pure. TASK: docs/tasks in the LeanPane repo (11-blueprint-parser.md).
 */
export interface BlueprintNode {
  label: string;
  /** theorem | lemma | proposition | corollary | definition */
  env: string;
  title?: string;
  file: string;
  /** 1-based line of \begin{env} */
  line: number;
  /** 1-based line of \end{env} */
  endLine: number;
  lean: string[];
  leanok: boolean;
  mathlibok: boolean;
  notready: boolean;
  /** \uses inside the statement */
  uses: string[];
  /** \uses inside the attached proof */
  proofUses: string[];
  proofLeanok: boolean;
  proofLine?: number;
  proofEndLine?: number;
}
export interface BlueprintSource {
  file: string;
  text: string;
}

/** `sources` are in document order (root first, \input files where they are included). */
export function parseBlueprint(_sources: BlueprintSource[], _opts?: { extraEnvs?: string[] }): BlueprintNode[] {
  throw new Error("TODO(task 11)");
}

/** Lean name -> nodes mentioning it, in document order. */
export function nodesByLeanName(_nodes: BlueprintNode[]): Map<string, BlueprintNode[]> {
  throw new Error("TODO(task 11)");
}
