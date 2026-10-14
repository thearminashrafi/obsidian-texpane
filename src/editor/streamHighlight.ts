import { StringStream, type StreamParser } from "@codemirror/language";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/**
 * Syntax colours drawn directly as CSS-class marks from a StreamParser, without Lezer highlight tags.
 * (Tag-based highlighting produced no colours inside Obsidian although it works in plain CodeMirror, so the
 * classes are applied here instead.) A token name "<prefix>-<kind>" becomes the class "<classPrefix>-<kind>".
 */
export function streamHighlight<S>(parser: StreamParser<S>, tokenPrefix: string, classPrefix: string): Extension {
  const cls = new Map<string, Decoration>();
  const markFor = (token: string): Decoration | null => {
    // a token may carry several space separated names; use the first one with our prefix
    for (const name of token.split(" ")) {
      if (!name.startsWith(tokenPrefix + "-")) continue;
      let d = cls.get(name);
      if (!d) cls.set(name, (d = Decoration.mark({ class: `${classPrefix}-${name.slice(tokenPrefix.length + 1)}` })));
      return d;
    }
    return null;
  };

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      /** states[i] = parser state at the start of line i+1 (computed lazily, in order). */
      private states: S[] = [];
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) {
          let first = Infinity;
          u.changes.iterChangedRanges((fromA) => {
            first = Math.min(first, u.startState.doc.lineAt(fromA).number);
          });
          if (first !== Infinity) this.states.length = Math.min(this.states.length, first); // keep states of lines before the edit
          this.decorations = this.build(u.view);
        } else if (u.viewportChanged) this.decorations = this.build(u.view);
      }
      private tokenize(text: string, state: S, onToken?: (from: number, to: number, token: string | null) => void): void {
        if (text.length === 0) {
          parser.blankLine?.(state, 2);
          return;
        }
        const stream = new StringStream(text, 4, 2);
        let guard = 0;
        while (!stream.eol() && guard++ < 10000) {
          stream.start = stream.pos;
          const token = parser.token(stream, state);
          if (stream.pos <= stream.start) stream.pos = stream.start + 1; // always advance
          onToken?.(stream.start, stream.pos, token);
        }
      }
      private build(view: EditorView): DecorationSet {
        try {
          const doc = view.state.doc;
          const clone = (s: S): S => (parser.copyState ? parser.copyState(s) : JSON.parse(JSON.stringify(s)));
          if (this.states.length === 0) this.states[0] = parser.startState!(2);
          const lastVisible = Math.min(doc.lines, doc.lineAt(Math.min(view.viewport.to, doc.length)).number);
          // advance cached states up to the first visible line
          const firstVisible = doc.lineAt(view.viewport.from).number;
          for (let n = this.states.length; n < firstVisible; n++) {
            const s = clone(this.states[n - 1]);
            this.tokenize(doc.line(n).text, s);
            this.states[n] = s;
          }
          const builder = new RangeSetBuilder<Decoration>();
          for (let n = firstVisible; n <= lastVisible; n++) {
            const line = doc.line(n);
            const s = clone(this.states[n - 1]);
            this.tokenize(line.text, s, (from, to, token) => {
              const d = token ? markFor(token) : null;
              if (d && to > from) builder.add(line.from + from, line.from + to, d);
            });
            if (this.states.length === n) this.states[n] = s;
          }
          return builder.finish();
        } catch (e) {
          console.error("[syntax] highlighting failed", e);
          return Decoration.none;
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
