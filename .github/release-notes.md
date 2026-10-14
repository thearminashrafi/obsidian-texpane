TeXPane 0.2.0

Lean integration with the new LeanPane plugin (everything below appears only while LeanPane is installed and enabled; TeXPane works exactly as before without it).

- `\lean{Name}` chips in the editor, coloured by declaration status (proved, in Mathlib, proved with `sorry` dependencies, stated, error, missing). Hover shows the status and Lean signature; Cmd/Ctrl+click opens the declaration in LeanPane.
- Completion of declaration names inside `\lean{ ... }`, comma-separated lists included.
- Checks that `\leanok` matches Lean: warnings in the editor and the log drawer with quick fixes to add or remove `\leanok`. New setting "Sync \leanok automatically" (off by default).
- "Open blueprint progress": dependency graph of the blueprint (from `\uses`) coloured by Lean status, totals ("18 of 31 proved"), filters (all, ready to prove, blocked, not formalized), click to jump to the LaTeX, double-click to open the Lean declaration, list view for narrow panes.
- "Formalize this": creates a `theorem name : sorry := by sorry` stub through LeanPane from the statement under the cursor and inserts `\lean{name}` after the `\label`.
- `% !LEAN project = <folder>` magic comment to point at a Lean project; otherwise it is found by walking up to the nearest lakefile.
- Blueprint macros (`\lean`, `\leanok`, `\uses`, `\mathlibok`, `\notready`, `\proves`, `\discussion`) get empty fallback definitions in the build when your document uses them without defining them, so blueprints compile with plain pdfLaTeX. Line numbers are unchanged.
- TeXPane API v1 for LeanPane (blueprint references, open location, add blueprint entry, change notifications).
