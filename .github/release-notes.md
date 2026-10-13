First release of TeXPane: an Overleaf-style LaTeX workspace inside Obsidian (desktop).

- Editor, live PDF and log drawer in one tab; compiles locally with `latexmk` (pdfLaTeX, XeLaTeX, LuaLaTeX).
- Auto-compile while typing (toggle from the Recompile button's right-click menu); Cmd/Ctrl+S saves and compiles.
- Errors and warnings in the editor and log drawer, F8 to step through them.
- SyncTeX: double-click the PDF to jump to source; Cmd/Ctrl+Alt+J jumps to the PDF.
- Completion for commands, environments, labels, citations and vault notes.
- `\obsidian{Note}` embeds vault notes, converted from Markdown to LaTeX at build time; "Export flattened project" for use elsewhere.
- Native Obsidian look; multi-file projects with `% !TEX root`.

**Install:** download `main.js`, `manifest.json` and `styles.css` below into `<vault>/.obsidian/plugins/texpane/`, then enable TeXPane under Settings → Community plugins. For several vaults sharing one copy, see `scripts/add-texpane.sh` in the README.

Requires Obsidian 1.8+ (desktop) and a TeX distribution with `latexmk` (MacTeX, TeX Live or MiKTeX).
