# TeXPane user guide

TeXPane gives Obsidian an Overleaf-style LaTeX workspace: editor, live PDF and error log in one tab, compiled on your own computer.

> **Status: beta.** Well tested automatically (including real `latexmk` runs), but young. Please [report problems](https://github.com/thearminashrafi/obsidian-texpane/issues/new/choose).

## 1. What you need

| Need | Notes |
| --- | --- |
| Obsidian 1.8 or newer, **desktop** | macOS first; Linux and Windows should work but get less testing. No mobile. |
| **A TeX distribution with `latexmk`** | See below. |
| (optional) LeanPane | For Lean blueprints. |

### Install TeX (once)
- **macOS**: install [MacTeX](https://tug.org/mactex/) (large, complete) or BasicTeX (small): `brew install --cask basictex`, then in a new terminal `sudo tlmgr update --self && sudo tlmgr install latexmk collection-latexrecommended biber`.
- **Linux**: `sudo apt install texlive-full latexmk` (or your distribution's equivalent).
- **Windows**: [MiKTeX](https://miktex.org/) or TeX Live (both include latexmk; MiKTeX also needs Perl).

Check in a terminal: `latexmk -v` prints a version.

## 2. Install the plugin

Obsidian's plugin browser does not list TeXPane yet, so use one of these.

**A. With BRAT (easiest, updates itself)**
1. Settings → Community plugins → Browse → install **Obsidian42 - BRAT**, enable it.
2. Command palette → "BRAT: Add a beta plugin for testing".
3. Paste `thearminashrafi/obsidian-texpane`, choose the latest version, add.
4. Settings → Community plugins → enable **TeXPane**.

**B. By hand**
1. Download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/thearminashrafi/obsidian-texpane/releases/latest).
2. Put them in `<vault>/.obsidian/plugins/texpane/` (hidden folder; Cmd+Shift+. shows it in macOS Finder).
3. Restart Obsidian and enable **TeXPane**.

**Several vaults (macOS/Linux):** `scripts/add-texpane.sh "/path/to/Vault A" "/path/to/Vault B"` keeps one shared copy (see the README).

### Check that TeX was found
Settings → TeXPane shows the detected toolchain. If `latexmk` is not found (typical on macOS when Obsidian starts from the Dock), run `which latexmk` in Terminal, paste that folder (usually `/Library/TeX/texbin`) into **TeX bin directory**, and press **Re-check**.

## 3. Your first document (3 minutes)

1. Click the **Σ** button in the left ribbon: the **LaTeX projects** panel opens.
2. **New → New LaTeX project**, give it a name. A `main.tex` is created in the `LaTeX/` folder and opens: editor on the left, PDF on the right.
3. Edit the text. After a short pause the PDF rebuilds on its own (or press Cmd/Ctrl+S, or Cmd/Ctrl+Enter).
4. Introduce an error (for example misspell `\section`): it is underlined, listed in the log drawer at the bottom, and clicking it jumps to the line. F8 steps through problems.
5. Double-click a spot in the PDF to jump to the matching source line; Cmd/Ctrl+Alt+J jumps from source to PDF.

The first build can take a minute while LaTeX loads fonts; later builds are fast.

## 4. Everyday use

### The LaTeX projects panel (Σ)
- Shows everything LaTeX in the vault: your *LaTeX* folder as a tree (sub-folders, single `.tex` files, multi-file projects), plus projects elsewhere ("Elsewhere in the vault", with "Move into LaTeX/").
- **New** → project (folder with `main.tex`), LaTeX file, or folder.
- Status dots: green last build ok, red errors, orange building, none not built yet. Right-click: open, open PDF, recompile, new file, reveal, **delete** (asks first, goes to trash).
- Filter box at the top. Optional settings: Σ markers in the file explorer, hide project folders there, open LaTeX in its own window.

### Editor
- Completion for commands, environments, `\ref`, `\cite` keys and notes. Choosing `\begin` offers environments and inserts the whole block.
- Cmd/Ctrl+F finds in the document (with replace). Cmd/Ctrl+/ comments, Cmd/Ctrl+B / I bold / italic.
- Multi-file projects: put `% !TEX root = ../main.tex` at the top of sub-files, or just include them from the main file.
- Layout button cycles editor | PDF | both. Right-click Recompile to switch auto-compile on or off.

### Using your Obsidian notes in LaTeX
```
\obsidian{Note name}                % whole note
\obsidian{Note name#Heading}        % one section
\obsidian[level=subsection]{Note}   % heading level
```
Typing `[[` lists your notes. Notes are converted to LaTeX when building. "Export flattened project" writes a plain `.tex` with everything inlined, ready to send to a journal or collaborator.

### Bibliographies
Put a `.bib` file in the project and use `\cite{key}` with biblatex/bibtex as usual; TeXPane runs the needed tools.

## 5. Lean blueprints (with LeanPane)
With [LeanPane](https://github.com/thearminashrafi/obsidian-leanpane) installed, `\lean{Name}` becomes a status chip, `\leanok` is checked against Lean, "Open blueprint progress" draws the dependency graph and "Formalize this" creates the Lean statement. Details: README, section "Lean integration". Nothing changes without LeanPane.

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| "latexmk not found" | Set **TeX bin directory** (macOS: `/Library/TeX/texbin`), Re-check. Restart Obsidian after installing TeX. |
| `File 'xxx.sty' not found` | Install the package: `sudo tlmgr install xxx` (BasicTeX) or let MiKTeX install on demand. |
| Build never finishes | Raise **Build timeout** in settings; check the log drawer for a stuck prompt or a shell-escape package. |
| `\write18`/`minted` errors | Shell escape is off by default; enable it only for documents you trust. |
| PDF looks stale | Press Recompile; clear the build folder (`.texpane/build` in the vault). |
| My project is missing from the panel | A project is a folder containing a `.tex` with `\documentclass` (not in a comment). Press the refresh button. |
| Colours are odd in dark mode | Toggle *PDF dark mode* in settings. |

## 7. Reporting problems
Open an issue with: OS, Obsidian and TeXPane versions, `latexmk -v`, steps, and the log drawer text. Remove anything private.

## 8. Privacy and safety
TeXPane makes no network requests itself. LaTeX runs locally with shell escape **off**. Builds go to `.texpane/build` inside the vault.
