# LaTeX Projects: keep LaTeX work apart from notes (TeXPane 0.1.5)

## Goal
Make LaTeX projects easy to find and work on without mixing them into the notes in the file explorer, while keeping `\obsidian{Note}` embeds working (same vault).

## What the user gets
1. **Projects panel** (sidebar view `texpane-projects`, icon `sigma`, ribbon button + command "Open LaTeX projects").
   - Lists every LaTeX project in the vault: a folder whose `.tex` file has `\documentclass` (outside comments).
   - Row: chevron, project name (folder name; the main file name for a project at the vault root), a status dot (green = last build ok, red = errors, orange = building, grey = not built in this session), the relative time of the last build.
   - Expanding a row shows the project's files (`.tex`, `.bib`, `.sty`, `.cls`, images, other PDFs), as a flat list with paths relative to the project root, `.tex` first.
   - Click a project: opens its main file in TeXPane. Click a file: opens it. Right-click a project: Open, Open PDF, Reveal in file explorer, Recompile (if open), New file in project.
   - Header buttons: New project (+), Collapse all, Refresh.
   - A filter box at the top (type to filter projects by name).
   - Empty state: short text and a "New LaTeX project" button.
2. **Home folder for projects**: setting "Projects folder" (default `LaTeX`). The "New LaTeX project" command and the panel's + button create projects there (folder created if missing). The file-menu entry still creates the project where you right-clicked.
3. **File explorer markers** (setting, on by default): project folders get a small sigma icon after their name and a muted accent tint. Done with a generated `<style>` element using `[data-path="…"]` selectors on `.nav-folder-title`.
4. **Optional: hide projects from the file explorer** (setting, off by default): the same generated CSS hides project folders in the explorer; the Projects panel is then the way in.
5. **Optional: separate LaTeX window** (setting, off by default): projects and files opened from the panel go to one pop-out window (`workspace.getLeaf("window")` the first time, then reuse a leaf in that window).

## Architecture
| File | Owner | What |
| --- | --- | --- |
| `src/core/projectIndex.ts` + `test/projectIndex.test.ts` | Haiku worker A | Pure project detection. No Obsidian imports. |
| `src/core/explorerCss.ts` + `test/explorerCss.test.ts` | Haiku worker B | Pure CSS generator for explorer markers / hiding. No Obsidian imports. |
| `src/view/ProjectsView.ts` | Sonnet lead | The sidebar panel. |
| `src/settings.ts`, `src/main.ts`, `styles.css` | Sonnet lead | Settings, wiring, index refresh on vault events, ribbon, commands, explorer style element, window routing, project status. |

### Interfaces (fixed before work starts)
```ts
// src/core/projectIndex.ts
export interface LatexProject {
  /** Folder path relative to the vault, "" for the vault root. */
  root: string;
  /** Vault path of the main .tex file. */
  main: string;
  /** Display name: folder name, or the main file's basename when root is "". */
  name: string;
  /** Vault paths of the files that belong to this project (main included), sorted: .tex first, then by path. */
  files: string[];
}
export const PROJECT_FILE_EXTS: string[]; // tex bib sty cls png jpg jpeg pdf eps svg
export function isMainTex(content: string): boolean;
export function buildProjectIndex(
  texFiles: { path: string; content: string }[],
  allFiles: string[],
  opts?: { ignore?: string[] },
): LatexProject[];
export function projectFor(path: string, projects: LatexProject[]): LatexProject | null;

// src/core/explorerCss.ts
export function cssAttrEscape(value: string): string;
export function explorerCss(roots: string[], opts: { mark: boolean; hide: boolean }): string;
```

## Rules for detection
- `isMainTex`: true when a line contains `\documentclass` before any unescaped `%` on that line.
- One project per folder. With several main files in one folder, the main is `main.tex` if present, else the alphabetically first; the others are ordinary project files.
- A file belongs to the project with the deepest root that contains it. The vault-root project (root `""`) only owns files directly in the vault root.
- Files under any `ignore` prefix (the build folder, `.texpane/`, `.obsidian/`, `.trash/`) are skipped, and so are main files there.
- Output sorted by name (case-insensitive), then root.

## Steps
1. Haiku workers A and B in parallel (pure modules + tests).
2. Sonnet lead: settings, panel, wiring, styles; uses A and B.
3. Review (orchestrator): typecheck, all tests, colour lint, a rendered screenshot of the panel in light and dark.
4. Release 0.1.5: version bump, release notes, push, install on the Mac with checksum verification.
