import { autocompletion, pickedCompletion, snippet, snippetCompletion, startCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import type { DeclSummary } from "../integration/api-types";
import type { BibEntry, LabelEntry } from "../types";
import data from "./data/commands.json";

interface DataItem {
  label: string;
  type: "command" | "environment";
  snippet?: string;
  detail?: string;
  package?: string;
}

export interface NoteSuggestion {
  /** Text inserted into \obsidian{...} */
  name: string;
  /** Vault path for the detail column */
  path: string;
}

export interface CompletionHost {
  labels(): LabelEntry[];
  bibEntries(): BibEntry[];
  notes(): NoteSuggestion[];
  headingsOf(note: string): string[];
  blocksOf(note: string): string[];
  /**
   * Lean declarations for \lean{..}; absent or null when LeanPane is not there.
   * `complete` false: the list was cut down to names starting with `typed`.
   */
  lean?: { declarations(typed: string): Promise<{ items: DeclSummary[]; complete: boolean }> | null };
}

const items = data as DataItem[];

/**
 * \begin and \end: put the cursor inside the braces and open the environment list
 * (the \begin{ / \end{ source below), instead of inserting a "{environment}" placeholder to type over.
 * An existing "{" right after the cursor is reused rather than doubled.
 */
export function braceThenList(macro: "\\begin" | "\\end", trigger: (v: EditorView) => void = startCompletion) {
  return (view: EditorView, c: Completion, from: number, to: number) => {
    const hasBrace = view.state.doc.sliceString(to, to + 1) === "{";
    const insert = hasBrace ? macro : `${macro}{}`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + macro.length + 1 },
      annotations: pickedCompletion.of(c),
    });
    setTimeout(() => trigger(view), 0);
  };
}

const commandOptions: Completion[] = items
  .filter((i) => i.type === "command")
  .map((i): Completion => {
    const detail = i.detail ?? i.package;
    if (i.label === "\\begin" || i.label === "\\end") return { label: i.label, type: "keyword", detail: "environment…", apply: braceThenList(i.label) };
    return i.snippet ? snippetCompletion(i.snippet, { label: i.label, type: "keyword", detail }) : { label: i.label, type: "keyword", detail };
  });

const envNames = items.filter((i) => i.type === "environment").map((i) => i.label);

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Name of the innermost \begin{x} that has no matching \end before `pos`. */
export function unclosedEnv(text: string, pos: number): string | null {
  const stack: string[] = [];
  const re = /\\(begin|end)\{([A-Za-z*]+)\}/g;
  const before = text.slice(0, pos);
  let m: RegExpExecArray | null;
  while ((m = re.exec(before))) {
    if (m[1] === "begin") stack.push(m[2]);
    else {
      const i = stack.lastIndexOf(m[2]);
      if (i >= 0) stack.length = i;
    }
  }
  return stack.length ? stack[stack.length - 1] : null;
}

const commandSource: CompletionSource = (ctx) => {
  const m = ctx.matchBefore(/\\[A-Za-z@]*$/);
  if (!m) return null;
  if (m.text === "\\" && !ctx.explicit && ctx.pos === m.from) return null;
  return { from: m.from, options: commandOptions, validFor: /^\\[A-Za-z@]*$/ };
};

const envSource: CompletionSource = (ctx) => {
  const m = ctx.matchBefore(/\\(begin|end)\{[A-Za-z*]*$/);
  if (!m) return null;
  const isBegin = m.text.startsWith("\\begin");
  const from = m.from + m.text.indexOf("{") + 1;
  const options: Completion[] = envNames.map((name) => ({
    label: name,
    type: "class",
    apply: (view: EditorView, c: Completion, f: number, t: number) => {
      const next = view.state.doc.sliceString(t, t + 1);
      const end = next === "}" ? t + 1 : t;
      if (isBegin) snippet(`${name}}\n\t\${}\n\\end{${name}}`)(view, c, f, end);
      else view.dispatch({ changes: { from: f, to: end, insert: name + "}" }, selection: { anchor: f + name.length + 1 } });
    },
  }));
  if (!isBegin) {
    const open = unclosedEnv(ctx.state.doc.toString(), m.from);
    if (open) {
      const i = options.findIndex((o) => o.label === open);
      const o: Completion = { label: open, type: "class", boost: 99, detail: "close", apply: (view, _c, f, t) => {
        const next = view.state.doc.sliceString(t, t + 1);
        const end = next === "}" ? t + 1 : t;
        view.dispatch({ changes: { from: f, to: end, insert: open + "}" }, selection: { anchor: f + open.length + 1 } });
      } };
      if (i >= 0) options.splice(i, 1);
      options.unshift(o);
    }
  }
  return { from, options, validFor: /^[A-Za-z*]*$/ };
};

const REF_RE = /\\(?:ref|eqref|pageref|autoref|cref|Cref|vref|nameref)\*?\{([^}]*)$/;
const CITE_RE = /\\(?:cite|citep|citet|citealp|citeauthor|citeyear|parencite|textcite|autocite|footcite|nocite|Cite|Parencite|Textcite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)$/;

function lastSegmentFrom(ctx: CompletionContext, m: { from: number; text: string }, inner: string): number {
  const lead = inner.length - inner.replace(/^.*,\s*/, "").length;
  return m.from + m.text.length - (inner.length - lead);
}

const LEAN_ARG_RE = /\\lean(?![A-Za-z@])\s*\{[^}\n]*$/;
const LEAN_STOP = /[,}\s]/;

/** Completion inside \lean{ ... }: Lean declarations, for the comma-separated segment being typed. */
export function makeLeanSource(lean: NonNullable<CompletionHost["lean"]>): CompletionSource {
  return async (ctx) => {
    const m = ctx.matchBefore(LEAN_ARG_RE);
    if (!m) return null;
    const inner = m.text.slice(m.text.indexOf("{") + 1);
    const typed = inner.replace(/^.*,\s*/s, "");
    const from = m.to - typed.length;
    if (!ctx.explicit && typed.length === 0) return null;
    const res = lean.declarations(typed);
    if (!res) return null;
    const { items, complete } = await res;
    if (ctx.aborted) return null;
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const d of items) {
      if (seen.has(d.name)) continue;
      seen.add(d.name);
      options.push({ label: d.name, type: d.kind === "def" || d.kind === "definition" ? "function" : d.kind === "structure" || d.kind === "inductive" || d.kind === "class" ? "class" : "variable", detail: d.kind, info: `${d.file}:${d.line}` });
    }
    return {
      from,
      options,
      validFor: complete ? (text: string) => !LEAN_STOP.test(text) : (text: string) => text.startsWith(typed) && !LEAN_STOP.test(text),
    };
  };
}

export function makeSources(host: CompletionHost): CompletionSource[] {
  const refSource: CompletionSource = (ctx) => {
    const m = ctx.matchBefore(new RegExp(REF_RE.source));
    if (!m) return null;
    const inner = REF_RE.exec(m.text)![1];
    const from = lastSegmentFrom(ctx, m, inner);
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const l of host.labels()) {
      if (seen.has(l.label)) continue;
      seen.add(l.label);
      options.push({ label: l.label, type: "variable", detail: `${basename(l.file)}:${l.line}` });
    }
    return { from, options, validFor: /^[^},]*$/ };
  };
  const citeSource: CompletionSource = (ctx) => {
    const m = ctx.matchBefore(new RegExp(CITE_RE.source));
    if (!m) return null;
    const inner = CITE_RE.exec(m.text)![1];
    const from = lastSegmentFrom(ctx, m, inner);
    const options: Completion[] = host.bibEntries().map((b) => ({ label: b.key, type: "text", detail: b.title ?? b.type, info: b.title ? `${b.title} (${b.type}, ${basename(b.file)})` : undefined }));
    return { from, options, validFor: /^[^},]*$/ };
  };
  const obsidianSource: CompletionSource = (ctx) => {
    let m = ctx.matchBefore(/\\obsidian(?:\[[^\]\n]*\])?\{[^}\n]*$/);
    let bracket = false;
    let q: string;
    let qStart: number;
    if (m) {
      const open = m.text.lastIndexOf("{");
      q = m.text.slice(open + 1);
      qStart = m.from + open + 1;
    } else {
      m = ctx.matchBefore(/\[\[[^\]\n]*$/);
      if (!m) return null;
      bracket = true;
      q = m.text.slice(2);
      qStart = m.from + 2;
    }
    const hash = q.indexOf("#");
    const finish = (view: EditorView, text: string, from: number, to: number, keepOpen = false) => {
      if (bracket) {
        // swallow auto-closed "]]" and rewrite "[[" to the macro
        let end = to;
        if (view.state.doc.sliceString(end, end + 2) === "]]") end += 2;
        else if (view.state.doc.sliceString(end, end + 1) === "]") end += 1;
        const ins = `\\obsidian{${text}${keepOpen ? "" : "}"}`;
        view.dispatch({ changes: { from: qStart - 2, to: end, insert: ins }, selection: { anchor: qStart - 2 + ins.length } });
      } else {
        const next = view.state.doc.sliceString(to, to + 1);
        const hasClose = next === "}";
        const ins = keepOpen ? text : hasClose ? text : text + "}";
        view.dispatch({ changes: { from, to, insert: ins }, selection: { anchor: from + text.length + (!keepOpen && hasClose ? 1 : keepOpen ? 0 : 1) } });
      }
    };
    if (hash >= 0) {
      const note = q.slice(0, hash);
      const rest = q.slice(hash + 1);
      if (rest.startsWith("^")) {
        const from = qStart + hash + 2;
        return { from, options: host.blocksOf(note).map((b) => ({ label: b, type: "constant", detail: "block", apply: (v: EditorView, _c: Completion, f: number, t: number) => finish(v, `${note}#^${b}`, qStart, t) })), filter: true };
      }
      const from = qStart + hash + 1;
      return {
        from,
        options: host.headingsOf(note).map((h) => ({ label: h, type: "property", detail: "heading", apply: (v: EditorView, _c: Completion, _f: number, t: number) => finish(v, `${note}#${h}`, qStart, t) })),
        filter: true,
      };
    }
    const options: Completion[] = host.notes().map((n) => ({
      label: n.name,
      type: "class",
      detail: n.path.replace(/\.md$/, ""),
      apply: (v: EditorView, _c: Completion, _f: number, t: number) => finish(v, n.name, qStart, t),
    }));
    return { from: qStart, options, validFor: /^[^#}\]]*$/ };
  };
  const sources = [obsidianSource, refSource, citeSource, envSource, commandSource];
  if (host.lean) sources.unshift(makeLeanSource(host.lean));
  return sources;
}

export function latexAutocomplete(host: CompletionHost) {
  return autocompletion({ override: makeSources(host), activateOnTyping: true, maxRenderedOptions: 80, defaultKeymap: true, closeOnBlur: true });
}
