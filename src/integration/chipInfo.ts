/** What a \lean{..} name looks like and says on hover. Pure. */
import type { DeclStatus } from "./api-types";
import { STATUS_LABEL, visualOf, type VisualStatus } from "../core/blueprintModel";

/** State of the Lean side as seen from one LaTeX file. */
export type LeanAvailability = "ready" | "no-leanpane" | "no-project" | "pending";

export type ChipVisual = VisualStatus | "neutral";

export interface ChipInfo {
  visual: ChipVisual;
  tooltip: string;
}

const MAX_SIGNATURE = 400;

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export function chipInfo(name: string, availability: LeanAvailability, status: DeclStatus | undefined, mod = "Mod"): ChipInfo {
  if (availability === "no-leanpane") return { visual: "neutral", tooltip: `${name}\nLeanPane isn't installed (or isn't enabled), so there is no Lean status here.` };
  if (availability === "no-project") return { visual: "neutral", tooltip: `${name}\nNo Lean project found for this file. Add "% !LEAN project = <folder>" to the root .tex file.` };
  if (!status) return { visual: "neutral", tooltip: `${name}\nChecking Lean…` };
  const visual = visualOf(status.state);
  const lines = [name, STATUS_LABEL[visual]];
  if (status.signature) lines.push(truncate(status.signature, MAX_SIGNATURE));
  if (status.file) lines.push(`${status.file}${status.line ? ":" + status.line : ""}`);
  if (status.state !== "missing") lines.push(`${mod}+click to open in LeanPane`);
  return { visual, tooltip: lines.join("\n") };
}
