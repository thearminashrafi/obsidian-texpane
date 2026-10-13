/**
 * Private-use sentinels that carry Obsidian-only syntax through the Markdown parser.
 * The preprocessor emits them; the serializer consumes them.
 *
 *   wikilink   \uE000 W enc(target) \uE002 enc(alias) \uE001
 *   embed      \uE000 E enc(target) \uE002 enc(extra) \uE001     (extra = size like "300" or "300x200", or alias)
 *   highlight  \uE000 H \uE001  ...text...  \uE000 h \uE001
 *
 * enc() output contains only [A-Za-z0-9.%-] so the Markdown parser never treats it as syntax.
 */
export const S_START = "\uE000";
export const S_END = "\uE001";
export const S_SEP = "\uE002";

export function enc(s: string): string {
  return encodeURIComponent(s).replace(/[_*~!'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}
export function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export const HL_OPEN = S_START + "H" + S_END;
export const HL_CLOSE = S_START + "h" + S_END;

export function makeWikilink(target: string, alias = ""): string {
  return S_START + "W" + enc(target) + S_SEP + enc(alias) + S_END;
}
export function makeEmbed(target: string, extra = ""): string {
  return S_START + "E" + enc(target) + S_SEP + enc(extra) + S_END;
}

export type Sentinel =
  | { kind: "wikilink"; target: string; alias: string }
  | { kind: "embed"; target: string; extra: string }
  | { kind: "hlOpen" }
  | { kind: "hlClose" };

/** Matches one sentinel; capture groups: 1 kind, 2 target, 3 extra */
export const SENTINEL_RE = /\uE000([WEHh])([^\uE001\uE002]*)(?:\uE002([^\uE001]*))?\uE001/g;

export function toSentinel(m: RegExpExecArray | RegExpMatchArray): Sentinel {
  const k = m[1];
  if (k === "W") return { kind: "wikilink", target: dec(m[2] ?? ""), alias: dec(m[3] ?? "") };
  if (k === "E") return { kind: "embed", target: dec(m[2] ?? ""), extra: dec(m[3] ?? "") };
  return k === "H" ? { kind: "hlOpen" } : { kind: "hlClose" };
}

/** Split text into plain strings and sentinels (in order). */
export function splitSentinels(text: string): Array<string | Sentinel> {
  const out: Array<string | Sentinel> = [];
  let last = 0;
  const re = new RegExp(SENTINEL_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(toSentinel(m));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
