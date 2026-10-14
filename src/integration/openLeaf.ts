/** Finding an already open tab for a file, including tabs that Obsidian has not loaded yet (deferred views). No Obsidian imports. */
import * as path from "node:path";

export interface LeafLike {
  view?: object | null;
  getViewState(): { state?: { file?: unknown } | null };
  loadIfDeferred?(): Promise<void>;
  setEphemeralState(state: unknown): void;
}

/**
 * The leaf showing `filePath`. A deferred leaf has no real view yet, only a saved view state naming its file: it is loaded
 * first (`deferred` tells the caller, so it positions the cursor through the leaf's ephemeral state instead of the view).
 */
export async function findLeafForFile<L extends LeafLike>(leaves: readonly L[], filePath: string): Promise<{ leaf: L; deferred: boolean } | null> {
  for (const leaf of leaves) if ((leaf.view as { file?: { path: string } | null } | null | undefined)?.file?.path === filePath) return { leaf, deferred: false };
  for (const leaf of leaves) {
    let saved: unknown;
    try {
      saved = leaf.getViewState()?.state?.file;
    } catch {
      continue;
    }
    if (saved !== filePath) continue;
    try {
      await leaf.loadIfDeferred?.();
    } catch {
      /* older Obsidian: nothing is deferred */
    }
    return { leaf, deferred: true };
  }
  return null;
}

/** A Lean file path for display: vault-relative when it lies inside the vault, else as given (projects may live outside it). */
export function friendlyPath(file: string, vaultBase: string): string {
  const abs = path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file);
  if (!abs) return file;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const f = norm(file);
  const b = norm(vaultBase);
  return b && f.startsWith(b + "/") ? f.slice(b.length + 1) : file;
}
