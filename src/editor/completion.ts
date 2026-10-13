import { autocompletion, snippet, snippetCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
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
}

const items = data as DataItem[];

const commandOptions: Completion[] = items
  .filter((i) => i.type === "command")
  .map((i) => {
    const detail = i.detail ?? i.package;
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
  return [obsidianSource, refSource, citeSource, envSource, commandSource];
}

export function latexAutocomplete(host: CompletionHost) {
  return autocompletion({ override: makeSources(host), activateOnTyping: true, maxRenderedOptions: 80, defaultKeymap: true, closeOnBlur: true });
}
