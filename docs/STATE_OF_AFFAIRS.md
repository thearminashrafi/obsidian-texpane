# TeXPane: state of affairs

*Last updated 14 Oct 2026, version 0.2.4. Keep this file current: update it with every release (newest entry on top of the log).*

## In one paragraph
TeXPane is a **beta**. The editor, PDF preview, log drawer, find and replace, `\obsidian{}` embeds and the LaTeX projects panel (Σ) are in daily use by the author on macOS, and the Σ panel, the editor and the Lean chips have been seen working in real Obsidian. The Lean integration (new in 0.2.0) and the delete actions are newer and mostly tested only automatically. Nobody other than the author has tried it yet.

## What works
| Area | Status | How we know |
| --- | --- | --- |
| Editor, auto-compile, PDF preview, log drawer, SyncTeX jumps | Works | Automated tests including real `latexmk` runs; daily use |
| Find and replace (Cmd/Ctrl+F), dark mode styling | Works | Used in Obsidian |
| LaTeX projects panel (Σ): tree, New menu, status dots, filter | Works since 0.1.8 (earlier versions showed a blank panel, fixed) | Screenshots |
| Syntax colours for LaTeX and BibTeX | Works since 0.2.2 (earlier versions showed no colours in Obsidian) | Fixed after a screenshot; needs one more look |
| `\obsidian{Note}` embeds, flattened export | Works | Automated tests, manual use |
| Lean integration with LeanPane (chips, `\leanok` checks, blueprint graph, Formalize this) | Implemented; chip colours seen in Obsidian | Automated tests (346 in total for the plugin); the rest not yet used |
| Delete project, file or folder from the Σ panel (to trash) | Implemented in 0.2.1 | Not yet used |

## Not yet verified in Obsidian
Checklist: `docs/MANUAL_TEST.md`. Highest priority: delete from the panel, the blueprint progress graph, "Formalize this", the `\leanok` quick fixes, building a blueprint from a sub-file such as `blueprint/src/content.tex` (the root should resolve to `print.tex`), Windows and Linux.

## Known issues and limitations
- Desktop only; macOS is the tested platform. Linux and Windows are untested.
- Biber output parsing is covered only by a synthetic log; bibtex is tested against real runs.
- No LSP (texlab); completion is built in.
- No Vim keybindings.
- PDF dark mode is a colour inversion and can look off for coloured figures.
- Embedded Markdown: callouts, Dataview and other plugin syntax are not converted.
- Blueprint graph uses a simple built-in layout (crossings possible on very large blueprints).
- A debug branch (`debug/projects-panel`) is still on GitHub and a stray `debug.log` may exist in the shared plugin folder on the author's Mac; both harmless.
- Not listed in Obsidian's community plugin store; install with BRAT or by hand (see the README).

## Next (ideas)
- Make the Lean connection discoverable but optional everywhere (it already works without LeanPane).
- Rename and move actions in the Σ panel.
- Templates for new projects (article, beamer, thesis).
- Community store submission once the interface has had more use.

## Log (newest first)
- **0.2.4**: Cmd/Ctrl+F now jumps to and selects the first match while you type (no Enter needed).
- **0.2.3**: tighter indentation in the Σ panel tree.
- **0.2.2**: fixed missing syntax colours (colour marks are now applied directly).
- **0.2.1**: delete project, file or folder from the Σ panel, with confirmation, to the trash.
- **0.2.0** (14 Oct 2026): Lean integration with LeanPane: `\lean{}` status chips, completion, `\leanok` checks and fixes, blueprint progress graph, Formalize this, TeXPane API v1. Independent review found and fixed several issues.
- **0.1.8**: fixed the blank Σ panel (a helper method named `open()` was replacing Obsidian's own). 0.1.5 to 0.1.7: LaTeX projects panel, projects folder, explorer markers, optional LaTeX window, folder tree, New menu.
- **0.1.4**: find card appears instantly. 0.1.3 and 0.1.2: find and replace card restyled for dark mode. **0.1.1**: Cmd/Ctrl+F find and replace.
- **0.1.0**: first public release: editor, PDF preview, log drawer, `\obsidian{}` embeds, multi-vault install script.
