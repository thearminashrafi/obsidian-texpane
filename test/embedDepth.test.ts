import { describe, it, expect } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EmbedBuilder } from "../src/core/embeds";
import { FolderNoteProvider } from "../src/core/folderNotes";
import { scanEmbeds } from "../src/core/embedScanner";

async function vault(files: Record<string, string>) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "texpane-depth-"));
  for (const [n, t] of Object.entries(files)) await fsp.writeFile(path.join(d, n), t);
  return d;
}
const builder = (d: string, mode: "build" | "export") =>
  new EmbedBuilder({ notes: new FolderNoteProvider(d), mode, embedsDir: path.join(d, ".e"), assetsDir: path.join(d, ".e", "a"), assetRefPrefix: "", wikilinkFootnote: false, highlightEmph: true, amssymbLoaded: false, listingsLoaded: false });

describe("nested embeds", () => {
  it("stops at depth 5 with a warning", async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 7; i++) files[`N${i}.md`] = `Text${i}\n\n![[N${i + 1}]]\n`;
    const d = await vault(files);
    for (const mode of ["export", "build"] as const) {
      const o = await builder(d, mode).embed(scanEmbeds("\\obsidian{N1}")[0]);
      expect(o.ok).toBe(true);
      expect(o.notePaths.sort()).toEqual(["N1.md", "N2.md", "N3.md", "N4.md", "N5.md"]);
      expect(o.warnings.some((w) => /depth limit/.test(w.message) && w.notePath === "N5.md")).toBe(true);
      if (mode === "export") {
        expect(o.replacement).toContain("Text5");
        expect(o.replacement).not.toContain("Text6");
      }
    }
  });
  it("reports a cycle once and still converts the rest", async () => {
    const d = await vault({ "A.md": "Alpha\n\n![[B]]\n", "B.md": "Beta\n\n![[a]]\n" });
    const o = await builder(d, "export").embed(scanEmbeds("\\obsidian{A}")[0]);
    expect(o.replacement).toContain("Alpha");
    expect(o.replacement).toContain("Beta");
    expect(o.warnings.filter((w) => /cycle/i.test(w.message))).toHaveLength(1);
  });
});
