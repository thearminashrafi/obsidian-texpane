# TeXPane manual test (macOS)

Prerequisites: MacTeX or BasicTeX with latexmk, Obsidian 1.8+, a scratch vault. Install the three files from `release/` into `<vault>/.obsidian/plugins/texpane/`, enable the plugin. Copy `test/fixtures/projects/*` and `test/fixtures/vault/*` into the vault (vault notes at the vault root: `Lit review.md`, `Methods.md`, `Folder/Intro.md`, `Attachments/figure.png`).

## M0 Foundation: plugin loads, toolchain detected
1. Enable the plugin: no error notice, no red errors in the dev console (Cmd+Opt+I).
2. Settings, TeXPane: the toolchain panel shows latexmk/pdflatex/synctex paths and versions. PASS if all found.
3. Launch Obsidian from the Dock (not Terminal). If not found, set the TeX bin directory to `/Library/TeX/texbin`, Re-check. PASS when detected.
4. Open a `.tex` file: it opens in the TeXPane view with syntax highlighting.

## M1 Compile and PDF
1. Open `single/main.tex`. PDF appears within a few seconds beside the editor.
2. Edit text, wait for auto-compile: PDF updates without flicker; scroll position and zoom preserved.
3. Press Cmd+Enter: recompiles. Press Cmd+S: saves and runs exactly one compile (spinner on the Recompile button). Right-click the Recompile button: the menu has an "Auto-compile while typing" toggle; when it is off the button shows a small orange dot and typing no longer compiles.
4. Drag the divider; reopen file: ratio remembered. Cycle layout (Cmd+Opt+V): split, editor only, PDF only.
5. Status bar shows build state. Disable auto-compile via command: edits no longer compile.

## M2 Diagnostics and log
1. Open `broken/main.tex`. Squiggles appear at the error lines; log drawer lists errors (red) and warnings.
2. Click an entry: cursor jumps to the line. F8/Shift+F8 cycle problems.
3. Fix the error: diagnostics clear; PDF updates.
4. Toggle log (Cmd+Opt+L). Raw log tab shows the full log.

## M3 Projects and bibliography
1. Open `multifile/chapters/*.tex` (with `% !TEX root`): saving a chapter builds the root document.
2. Open `bibtex/main.tex`: citations resolve, bibliography appears; `\cite{` completes keys, `\ref{` completes labels.
3. Open `unicode/` (path with spaces/non-ASCII) and `xelatex/` (switch engine to xelatex): both build.
4. Outline view lists sections; clicking navigates.

## M4 SyncTeX
1. Cmd+Opt+J in the editor: PDF scrolls to and highlights the matching spot.
2. Click text in the PDF: editor jumps to the matching source line and flashes it.
3. Works in multi-file projects (opens the right file).

## M5 `\obsidian` embeds
1. Open `embed/main.tex`. Build succeeds; PDF contains the embedded Lit review (headings, math, table, image, nested embed). The cycle fixture yields a warning, not a hang.
2. `\obsidian{Lit review#Heading}` and `#^block` select the section/block only.
3. Type `\obsidian{[[`: note completion lists vault notes. The "Embed note…" command opens the note picker.
4. Chips display for `\obsidian` lines; hovering shows a preview; clicking opens the note.
5. Edit the embedded note in Obsidian: auto-recompile triggers (or on next save); PDF updates.
6. Introduce a LaTeX error via a note (e.g. unmatched `$`): the diagnostic points at the `\obsidian` line and shows the note line.
7. Export flattened project: the output `.tex` compiles with plain `latexmk`.

## M6 Polish and release
1. Native look: switch light/dark and a community theme; editor, drawer, chips use theme colours. Syntax colours change with the "Syntax colours" setting.
2. PDF dark mode toggle works.
3. The "Toggle focus mode" command hides sidebars and restores them.
4. New LaTeX project / file commands create from templates. Clean build files removes the build folder. Reveal PDF opens Finder.
5. Close a file mid-build and quit Obsidian: no stray `latexmk`/`pdflatex` processes (`pgrep -fl latexmk`).
6. `release/` holds exactly main.js, manifest.json, styles.css.

## M7 Lean integration (needs LeanPane 0.1.0 and a Lean project; untested in automated runs)
Setup: a vault with a Lean project (`lake new demo`) and a blueprint `.tex` next to it (e.g. `demo/blueprint/src/content.tex` with a root `print.tex`), both plugins enabled.
1. Without LeanPane (disable it): `\lean{X}` chips are grey, hover says "LeanPane isn't installed"; the commands "Open blueprint progress", "Formalize this" and the Settings section "Lean integration" are absent; no new warnings in the log drawer. Compile a blueprint that uses `\lean`, `\leanok`, `\uses` without defining them: it builds with no "Undefined control sequence".
2. Enable LeanPane: chips recolour without reloading (api-ready event). Disable it again: chips go grey, warnings disappear.
3. Chips: a proved theorem is green, `sorry` orange, a theorem using a `sorry` lemma yellow, a Mathlib name cyan, a typo red dashed. Hover shows status and signature. Cmd+click opens the declaration in LeanPane; Alt+Cmd+click in a new tab.
4. Completion: type `\lean{` then a few letters; names from the Lean project appear. After a comma the second name completes too.
5. Mismatches: add `\leanok` to the proof of a `sorry` theorem: a warning with "Remove \leanok" appears on that line and in the log drawer; the quick fix removes it. Prove it in Lean (LeanPane): "Add \leanok" appears. Turn on "Sync \leanok automatically": both happen by themselves and settle (no flip-flopping while you type in Lean).
6. "Open blueprint progress": graph appears right of the active tab; totals match the colours; filters dim nodes; click jumps to LaTeX, double-click opens Lean; narrow the pane below ~480 px: list view; header button switches. Edit `\uses` in the LaTeX: graph updates within a second.
7. "Formalize this": cursor inside `\begin{lemma}\label{lem:x}…`: name prompt defaults to `lem_x`, pick or create a `.lean` file, the stub appears in LeanPane with the statement as docstring, `\lean{lem_x}` is inserted after the `\label` and the chip turns orange.
8. `% !LEAN project = <folder>` in the root file overrides the project; a wrong folder gives grey chips with "No Lean project found".
9. From LeanPane: "Jump to blueprint" opens the TeX file at the right line; "Add to blueprint" appends an entry before `\end{document}`.
