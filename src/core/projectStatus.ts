// Pure helpers for the Projects panel: status mapping, relative time, build-folder filter. No Obsidian imports.

export type ProjectState = "ok" | "error" | "building" | "none";
export interface ProjectStatus {
  state: ProjectState;
  /** Epoch ms of the last finished build in this session. */
  lastBuild?: number;
}

/** Queue state of a live session (or undefined) plus the last finished build's status (or undefined). */
export function projectState(queue: string | undefined, last: string | undefined): ProjectState {
  if (queue === "running" || queue === "queued") return "building";
  if (last === "ok") return "ok";
  if (last === "errors" || last === "failed" || last === "timeout") return "error";
  return "none";
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". Future or invalid times read as "just now". */
export function formatRelativeTime(then: number, now: number): string {
  const s = Math.floor((now - then) / 1000);
  if (!Number.isFinite(s) || s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(s / 3600);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** True when a vault path lies inside a project-relative build folder (at any depth). */
export function inBuildFolder(path: string, buildFolder: string): boolean {
  const segs = buildFolder.split(/[\\/]/).filter((x) => x && x !== ".");
  if (segs.length === 0) return false;
  const marker = "/" + segs.join("/") + "/";
  return ("/" + path).includes(marker);
}
