// Pure CSS generator for file-explorer project markers and hiding.
// Obsidian renders each folder as `.nav-folder` containing `.nav-folder-title[data-path]`
// and the folder's children. No Obsidian imports here: this module is unit-tested in Node.

/**
 * Escape a value for use inside a double-quoted CSS attribute selector.
 * Backslash and quote get a backslash; newline and other control characters
 * become a hex escape terminated by a space.
 */
export function cssAttrEscape(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\a ";
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(16)} `;
    else out += ch;
  }
  return out;
}

/**
 * Build the stylesheet for the given vault-relative folder roots.
 * - hide: the whole folder (title and children) is hidden. Mark rules are not emitted.
 * - mark: the folder title is tinted and gets a sigma marker after its name.
 * Empty and duplicate roots are ignored. Returns "" when nothing applies.
 */
export function explorerCss(roots: string[], opts: { mark: boolean; hide: boolean }): string {
  if (!opts.hide && !opts.mark) return "";
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const r of roots) {
    if (r === "" || seen.has(r)) continue;
    seen.add(r);
    unique.push(r);
  }
  if (unique.length === 0) return "";

  const title = (p: string) => `.nav-folder-title[data-path="${cssAttrEscape(p)}"]`;

  if (opts.hide) {
    const selectors = unique.map((p) => `.nav-folder:has(> ${title(p)})`);
    return `${selectors.join(",\n")} { display: none; }`;
  }

  const tint = unique.map((p) => title(p));
  const marker = unique.map((p) => `${title(p)} .nav-folder-title-content::after`);
  return [
    `${tint.join(",\n")} { color: var(--text-accent); }`,
    `${marker.join(",\n")} { content: "\\03A3"; font-size: 0.85em; opacity: 0.7; margin-left: 4px; }`,
  ].join("\n");
}
