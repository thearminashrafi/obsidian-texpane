/**
 * Cross-plugin API between LeanPane and TeXPane. This file is copied VERBATIM into both repositories
 * (src/integration/api-types.ts). It is the only coupling between the two plugins; change it in both or in neither.
 *
 * Access: `(app as any).plugins?.plugins?.["leanpane"]?.api` / `["texpane"]?.api`, always looked up through a getter
 * (never cache the plugin object across enable/disable). Each plugin calls
 * `app.workspace.trigger("leanpane:api-ready")` / `("texpane:api-ready")` on load (after layout ready) and
 * `"…:api-unload"` on unload. Consumers check `api.version === API_VERSION` (same major only).
 */

export const API_VERSION = 1 as const;

export const LEANPANE_PLUGIN_ID = "leanpane";
export const TEXPANE_PLUGIN_ID = "texpane";
export const LEANPANE_READY_EVENT = "leanpane:api-ready";
export const LEANPANE_UNLOAD_EVENT = "leanpane:api-unload";
export const TEXPANE_READY_EVENT = "texpane:api-ready";
export const TEXPANE_UNLOAD_EVENT = "texpane:api-unload";

export interface LeanPaneApiV1 {
  version: 1;
  projectForPath(vaultPath: string): Promise<LeanProjectInfo | null>; // walks up to lakefile
  getStatus(projectRoot: string, names: string[], opts?: { refresh?: boolean }): Promise<Record<string, DeclStatus>>;
  listDeclarations(projectRoot: string, prefix?: string): Promise<DeclSummary[]>;
  openDeclaration(projectRoot: string, name: string, opts?: { newLeaf?: boolean }): Promise<boolean>;
  createStub(projectRoot: string, req: { file: string; name: string; docstring: string }): Promise<{ file: string; line: number }>;
  onStatusChanged(cb: (projectRoot: string, names: string[] | "all") => void): () => void;
}
export interface LeanProjectInfo {
  root: string; // vault-relative
  absRoot: string;
  toolchain: string;
  usesMathlib: boolean;
}
export type DeclState = "missing" | "error" | "stated" | "proved-with-sorry-deps" | "proved" | "mathlib" | "unknown";
export interface DeclStatus {
  name: string;
  state: DeclState;
  file?: string;
  line?: number;
  kind?: string;
  signature?: string;
  source: "live" | "build" | "none";
  updatedAt: number;
}
export interface DeclSummary {
  name: string;
  kind: string;
  file: string;
  line: number;
}

export interface TeXPaneApiV1 {
  version: 1;
  blueprintRefs(leanName: string): Promise<BlueprintRef[]>; // across open/known blueprint projects
  openLocation(file: string, line: number): Promise<void>;
  addBlueprintEntry(req: { texFile: string; env: string; label: string; leanName: string; statement: string }): Promise<{ file: string; line: number }>;
  onBlueprintChanged(cb: () => void): () => void;
}
export interface BlueprintRef {
  file: string;
  line: number;
  label: string;
  env: string;
  title?: string;
  leanok: boolean;
}

/** Look up the other plugin's API; returns null when it is absent, disabled, or of an incompatible major version. */
export function getLeanPaneApi(app: unknown): LeanPaneApiV1 | null {
  const api = (app as { plugins?: { plugins?: Record<string, { api?: { version?: number } } | undefined> } })?.plugins?.plugins?.[LEANPANE_PLUGIN_ID]?.api;
  return api && api.version === API_VERSION ? (api as LeanPaneApiV1) : null;
}
export function getTeXPaneApi(app: unknown): TeXPaneApiV1 | null {
  const api = (app as { plugins?: { plugins?: Record<string, { api?: { version?: number } } | undefined> } })?.plugins?.plugins?.[TEXPANE_PLUGIN_ID]?.api;
  return api && api.version === API_VERSION ? (api as TeXPaneApiV1) : null;
}
