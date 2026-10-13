// Fails if styles.css (or source) contains hex colours outside the Parchment & Ink syntax block.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
let bad = 0;

const css = readFileSync(join(root, "styles.css"), "utf8");
const begin = css.indexOf("/* TP-SYNTAX-BEGIN */");
const end = css.indexOf("/* TP-SYNTAX-END */");
if (begin < 0 || end < begin) {
  console.error("styles.css: syntax block markers missing");
  process.exit(1);
}
const outside = css.slice(0, begin) + css.slice(end);
css.slice(0, begin).split("\n");
outside.split("\n").forEach((line, i) => {
  const m = line.replace(/\/\*.*?\*\//g, "").match(HEX);
  if (m) {
    console.error(`styles.css (outside syntax block): ${line.trim()}  -> ${m.join(", ")}`);
    bad++;
  }
});
// rgb()/hsl() literals are also forbidden outside the block
outside.split("\n").forEach((line) => {
  if (/\b(rgba?|hsla?)\(\s*\d/.test(line)) {
    console.error(`styles.css: literal colour function: ${line.trim()}`);
    bad++;
  }
});
// colours in TS source (inline styles) are forbidden too
function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts") && !p.includes("/core/")) {
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        const l = line.replace(/\/\/.*$/, "");
        if (/["'`]#[0-9a-fA-F]{3,8}["'`]/.test(l)) {
          console.error(`${p}:${i + 1}: hex colour in source`);
          bad++;
        }
      });
    }
  }
}
walk(join(root, "src"));
if (bad) {
  console.error(`lint:colors failed with ${bad} problem(s)`);
  process.exit(1);
}
console.log("lint:colors ok: no hex colours outside the Parchment & Ink syntax block");
