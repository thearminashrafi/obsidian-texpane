/** Parsed blueprint per LaTeX project (root file, vault path), cached until something changes. No Obsidian imports. */
import { parseBlueprint, type BlueprintNode, type BlueprintSource } from "../core/blueprint";
import { collectBlueprintSources } from "../core/blueprintSources";

export interface ParsedBlueprint {
  root: string;
  nodes: BlueprintNode[];
  sources: BlueprintSource[];
}

export class BlueprintStore {
  private cache = new Map<string, Promise<ParsedBlueprint>>();
  private listeners = new Set<() => void>();
  private generation = 0;

  /** `read` returns the current text of a vault file (open editors first), or null. */
  constructor(private read: (vaultPath: string) => Promise<string | null>) {}

  get(root: string): Promise<ParsedBlueprint> {
    let p = this.cache.get(root);
    if (!p) {
      const gen = this.generation;
      p = collectBlueprintSources(root, this.read).then((sources) => ({ root, sources, nodes: parseBlueprint(sources) }));
      this.cache.set(root, p);
      // do not keep a failed parse around
      p.catch(() => {
        if (gen === this.generation) this.cache.delete(root);
      });
    }
    return p;
  }

  /** Something in a .tex file changed. Listeners hear about it. */
  invalidate() {
    this.generation++;
    this.cache.clear();
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (e) {
        console.error("[TeXPane] blueprint listener failed", e);
      }
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  dispose() {
    this.listeners.clear();
    this.cache.clear();
  }
}
