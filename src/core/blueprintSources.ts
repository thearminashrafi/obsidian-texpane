/** Find the .tex files of a project (root + \input/\include/\subfile), in reading order. Pure: file access is injected. */
import * as path from "node:path";
import { extractInputs } from "./indexers";
import type { BlueprintSource } from "./blueprint";

/**
 * Vault paths, posix. The root comes first, then each included file right after the file that includes it
 * (depth first). A file is read once even when it is included twice.
 */
export async function collectBlueprintSources(root: string, read: (vaultPath: string) => Promise<string | null>): Promise<BlueprintSource[]> {
  const out: BlueprintSource[] = [];
  const seen = new Set<string>();
  const rootDir = path.posix.dirname(root) === "." ? "" : path.posix.dirname(root);
  const resolve = (base: string, name: string) => path.posix.normalize(path.posix.join(base, name));

  const visit = async (file: string, depth: number): Promise<void> => {
    if (seen.has(file) || depth > 12) return;
    seen.add(file);
    const text = await read(file);
    if (text === null) return;
    out.push({ file, text });
    const dir = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    for (const inp of extractInputs(text)) {
      const n = /\.[A-Za-z0-9]+$/.test(inp) ? inp : inp + ".tex";
      for (const cand of [...new Set([resolve(rootDir, n), resolve(dir, n)])]) {
        if (cand.startsWith("../") || seen.has(cand)) continue;
        if ((await read(cand)) !== null) {
          await visit(cand, depth + 1);
          break;
        }
      }
    }
  };
  await visit(root, 0);
  return out;
}
