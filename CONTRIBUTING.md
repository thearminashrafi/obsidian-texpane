# Contributing

Bug reports and pull requests are welcome.

- **Bug reports**: use the issue template; include versions and steps.
- **Development**: `npm install`, `npm run dev` (watch), `npm test` (the test suite; real latexmk tests need TeX installed), `npm run lint:colors`, `npx tsc --noEmit`. The design notes are in `docs/`; manual UI checks are in `docs/MANUAL_TEST.md`.
- **Style**: TypeScript, no Obsidian imports in `src/core/*` (keeps it unit-testable), only Obsidian CSS variables in `styles.css`. Do not name private methods after Obsidian `View` internals (`open`, `close`, `load`): they silently replace them.
- **Pull requests**: keep them small, add or update tests, and run the gate before pushing. Releases are cut automatically when the version in `manifest.json` changes on `main`.
