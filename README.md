# TeXPane

An Overleaf-style LaTeX workspace inside Obsidian (desktop only, macOS first): a CodeMirror 6 editor, a live PDF preview and a log drawer in one tab, plus `\obsidian{Note}` to embed vault notes in your document. Compilation runs locally with `latexmk`.

## Requirements

- Obsidian 1.8.0 or newer, desktop.
- A TeX distribution with `latexmk` (MacTeX or BasicTeX on macOS; TeX Live on Linux; MiKTeX/TeX Live on Windows). `biber`/`bibtex` for bibliographies. `synctex` (ships with TeX Live) for forward/inverse search.

## Install

**One vault:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest), put them in `<vault>/.obsidian/plugins/texpane/`, then enable "TeXPane" under Settings → Community plugins (turn off Restricted mode first if needed).

**Several vaults, one shared copy (macOS/Linux):** Obsidian installs plugins per vault. `scripts/add-texpane.sh` keeps a single copy in `~/Documents/.obsidian-shared-plugins/texpane` and links it into each vault, so one update reaches all of them:

```bash
npm install && npm run build                       # or put the release files in scripts/plugin/
bash scripts/add-texpane.sh "/path/to/Vault A" "/path/to/Vault B"
bash scripts/add-texpane.sh --update               # after a new build: refresh the shared copy
```

Open each vault in Obsidian once first (so it has a `.obsidian` folder), then reload plugins and switch TeXPane on. The script never deletes anything.

From source: `npm install && npm run build` (outputs to `release/`). `npm run dev` watches and bundles to `main.js`. `npm test` runs the test suite (integration tests need `latexmk` and skip or fail without it). `npm run lint:colors` checks that styles use only Obsidian CSS variables outside the marked syntax block.

## Usage

- Open any `.tex` file: it opens in the TeXPane view (editor | PDF, log drawer below). `.bib`, `.sty`, `.cls` open there too (setting, default on).
- "New LaTeX project" / "New LaTeX file" from the command palette or file menu. New projects from the command palette or the Projects panel go into the projects folder (default `LaTeX/`, set in Settings → Projects).
- **LaTeX projects panel** (sigma icon in the ribbon, or "Open LaTeX projects"): every project in the vault (a folder with a `\documentclass` file), with build status, last build time and its files. Click to open; right-click for Open PDF, Recompile, Reveal, New file.
- Project folders get a small Σ marker in the file explorer. Optional settings: hide project folders from the file explorer entirely, and open projects in their own LaTeX window.
- Multi-file projects: use `% !TEX root = ../main.tex` in sub-files. Otherwise the root is found by locating a `\documentclass` file that includes the current one.
- Auto-compile after a short pause in typing (configurable). Cmd/Ctrl+S saves and compiles; Cmd/Ctrl+Enter recompiles.
- Right-click the Recompile button for an auto-compile on/off toggle (a small orange dot on the button means auto-compile is off).
- Completion for commands, environments, `\ref` labels, `\cite` keys and vault notes. Picking `\begin` or `\end` opens the environment list; picking an environment inserts the whole block.
- Errors and warnings appear as editor squiggles and in the log drawer; click to jump. F8 / Shift+F8 step through problems.
- Double-click in the PDF to jump to source (inverse search); Cmd/Ctrl+Alt+J jumps from source to PDF (forward search).

### `\obsidian` syntax

```
\obsidian{Note name}               % whole note
\obsidian{Note name#Heading}       % one heading section
\obsidian{Note name#^blockid}      % one block
\obsidian[level=subsection]{Note}  % note's top heading becomes \subsection (default: section)
\obsidian[title=true]{Note name}    % add the note's name as a heading first
```

Notes are converted to LaTeX at build time (headings, emphasis, lists, links, footnotes, math, GFM tables, images, code, nested `![[embeds]]`). Embed cycles and depth over 5 produce warnings, not hangs. Diagnostics from embedded content point at the `\obsidian` line and the note line. Typing `[[` (or `\obsidian{`) lists vault notes; picking one writes `\obsidian{Note}`. `#` after a note name lists its headings. Export: "Export flattened project" writes a plain `.tex` with embeds inlined that compiles with ordinary latexmk.

## Shortcuts (all rebindable under Hotkeys)

| Action | Default |
| --- | --- |
| Recompile | Cmd/Ctrl+Enter (in editor) |
| Save and recompile | Cmd/Ctrl+S |
| Forward search | Cmd/Ctrl+Alt+J |
| Next / previous problem | F8 / Shift+F8 |
| Toggle log drawer | Cmd/Ctrl+Alt+L |
| Cycle layout | Cmd/Ctrl+Alt+V |
| Focus mode | none (Cmd+Option+F is Obsidian's search and replace on macOS) |
| Embed note | none (assign one under Hotkeys) |
| Bold / italic | Cmd/Ctrl+B / I |
| Toggle comment | Cmd/Ctrl+/ |

## Settings

Engine (pdflatex/xelatex/lualatex), TeX bin directory override, auto-compile and delay, build timeout, build folder (default `.texpane/build` in the vault), copy PDF beside source, shell escape (off), open mode, editor font size and wrap, PDF dark mode, extra latexmk arguments, syntax colours (TeXPane palette or theme), `[[wikilink]]` footnote handling, `==highlight==` as emphasis, registering bib/sty/cls, word count in status bar. The settings tab shows the detected toolchain and a "Re-check" button.

## macOS PATH troubleshooting

Obsidian launched from the Dock does not inherit your shell PATH, so `latexmk` may not be found. TeXPane searches your PATH, then `/Library/TeX/texbin`, `/usr/local/texlive/<year>/bin/*`, `/opt/homebrew/bin` and similar. If detection still fails, run `which latexmk` in Terminal and paste its directory into Settings, TeXPane, "TeX bin directory" (typically `/Library/TeX/texbin`), then click Re-check. BasicTeX users may need `sudo tlmgr install latexmk` plus any packages your document needs.

## Known limitations

- Desktop only; not tested on mobile (unsupported).
- Biber output parsing is covered only by a synthetic log; bibtex is tested against real runs.
- No LSP (texlab) integration; completion is built in (commands, environments, labels, citations, notes).
- Vim keybindings are not provided by the embedded editor.
- Word count relies on `texcount` if installed; otherwise a rough count is shown.
- PDF dark mode is a CSS inversion and may look off for coloured figures.
- Embedded Markdown: callouts, Dataview and other plugin syntax are not converted (passed through as text or dropped with a warning).
- Shell escape is off by default; enable it only for documents you trust.
- The Obsidian-facing UI could not be exercised in an automated environment; see `docs/MANUAL_TEST.md`.

## License

MIT, see [LICENSE](LICENSE).
