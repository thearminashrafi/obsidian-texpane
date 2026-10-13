// Copies main.js, manifest.json and styles.css into release/ (and nothing else).
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
const root = new URL("..", import.meta.url).pathname;
const out = join(root, "release");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(join(root, f), join(out, f));
for (const f of readdirSync(out)) console.log(`release/${f}  ${(statSync(join(out, f)).size / 1024).toFixed(1)} KB`);
