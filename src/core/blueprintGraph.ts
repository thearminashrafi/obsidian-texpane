/**
 * Layered left-to-right layout for the blueprint dependency graph. Pure, no dependencies.
 * Prerequisites sit left of what depends on them. Long edges are routed through dummy slots in the
 * layers they cross, so they pass between nodes instead of through them.
 */
export interface LayoutOptions {
  nodeW: number;
  nodeH: number;
  gapX: number;
  gapY: number;
  /** barycenter sweeps */
  sweeps: number;
}
export const DEFAULT_LAYOUT: LayoutOptions = { nodeW: 150, nodeH: 34, gapX: 70, gapY: 14, sweeps: 6 };

export interface PlacedNode {
  id: string;
  layer: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PlacedEdge {
  from: string;
  to: string;
  /** SVG path data, start at the right edge of `from`, end at the left edge of `to` */
  d: string;
  /** edge points the path goes through */
  points: Array<[number, number]>;
  /** edge points against the layering (part of a cycle) */
  back: boolean;
}
export interface GraphLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
  layers: number;
}

interface Slot {
  id: string;
  dummy: boolean;
  layer: number;
  order: number;
  h: number;
  y: number;
}

export function layoutGraph(ids: readonly string[], rawEdges: ReadonlyArray<readonly [string, string]>, options: Partial<LayoutOptions> = {}): GraphLayout {
  const o = { ...DEFAULT_LAYOUT, ...options };
  const unique = [...new Set(ids)];
  const known = new Set(unique);
  const seenEdge = new Set<string>();
  const edges: Array<[string, string]> = [];
  for (const [a, b] of rawEdges) {
    if (a === b || !known.has(a) || !known.has(b)) continue;
    const k = `${a}\u0000${b}`;
    if (seenEdge.has(k)) continue;
    seenEdge.add(k);
    edges.push([a, b]);
  }

  // ---- break cycles: DFS, edges to a node on the stack are "back" edges and are ignored for layering
  const out = new Map<string, string[]>();
  for (const id of unique) out.set(id, []);
  for (const [a, b] of edges) out.get(a)!.push(b);
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  for (const root of unique) {
    if (state.get(root)) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: root, i: 0 }];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = out.get(top.id)![top.i++];
      if (next === undefined) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const s = state.get(next);
      if (s === 1) back.add(`${top.id}\u0000${next}`);
      else if (!s) {
        state.set(next, 1);
        stack.push({ id: next, i: 0 });
      }
    }
  }
  const forward = edges.filter(([a, b]) => !back.has(`${a}\u0000${b}`));

  // ---- layers: longest path from the sources
  const indeg = new Map<string, number>(unique.map((i) => [i, 0]));
  const succ = new Map<string, string[]>(unique.map((i) => [i, []]));
  for (const [a, b] of forward) {
    indeg.set(b, indeg.get(b)! + 1);
    succ.get(a)!.push(b);
  }
  const layer = new Map<string, number>(unique.map((i) => [i, 0]));
  const queue = unique.filter((i) => indeg.get(i) === 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of succ.get(u)!) {
      layer.set(v, Math.max(layer.get(v)!, layer.get(u)! + 1));
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }

  // ---- slots (real nodes + dummies on long edges)
  const slots = new Map<string, Slot>();
  const slotFor = (id: string, dummy: boolean, l: number, h: number) => {
    const s: Slot = { id, dummy, layer: l, order: 0, h, y: 0 };
    slots.set(id, s);
    return s;
  };
  for (const id of unique) slotFor(id, false, layer.get(id)!, o.nodeH);
  const chains = new Map<string, string[]>(); // edge key -> slot ids from `from` to `to`
  let dummyN = 0;
  for (const [a, b] of forward) {
    const chain = [a];
    for (let l = layer.get(a)! + 1; l < layer.get(b)!; l++) {
      const id = `\u0000d${dummyN++}`;
      slotFor(id, true, l, 6);
      chain.push(id);
    }
    chain.push(b);
    chains.set(`${a}\u0000${b}`, chain);
  }
  const nLayers = unique.length ? Math.max(...[...slots.values()].map((s) => s.layer)) + 1 : 0;
  const cols: Slot[][] = Array.from({ length: nLayers }, () => []);
  for (const s of slots.values()) cols[s.layer].push(s);
  cols.forEach((c) => c.forEach((s, i) => (s.order = i)));

  const up = new Map<string, string[]>(); // neighbours in the previous layer
  const down = new Map<string, string[]>(); // neighbours in the next layer
  for (const id of slots.keys()) {
    up.set(id, []);
    down.set(id, []);
  }
  for (const chain of chains.values()) {
    for (let i = 0; i + 1 < chain.length; i++) {
      down.get(chain[i])!.push(chain[i + 1]);
      up.get(chain[i + 1])!.push(chain[i]);
    }
  }
  // ---- crossing reduction: barycenter sweeps
  const reorder = (col: Slot[], nb: Map<string, string[]>) => {
    const key = new Map<string, number>();
    for (const s of col) {
      const ns = nb.get(s.id)!;
      key.set(s.id, ns.length ? ns.reduce((acc, n) => acc + slots.get(n)!.order, 0) / ns.length : s.order);
    }
    col.sort((a, b) => key.get(a.id)! - key.get(b.id)! || a.order - b.order);
    col.forEach((s, i) => (s.order = i));
  };
  for (let sweep = 0; sweep < o.sweeps; sweep++) {
    for (let l = 1; l < nLayers; l++) reorder(cols[l], up);
    for (let l = nLayers - 2; l >= 0; l--) reorder(cols[l], down);
  }

  // ---- coordinates
  const heights = cols.map((c) => c.reduce((acc, s) => acc + s.h, 0) + Math.max(0, c.length - 1) * o.gapY);
  const maxH = Math.max(0, ...heights);
  cols.forEach((c, l) => {
    let y = (maxH - heights[l]) / 2;
    for (const s of c) {
      s.y = y;
      y += s.h + o.gapY;
    }
  });
  const colX = (l: number) => l * (o.nodeW + o.gapX);
  const nodes: PlacedNode[] = unique.map((id) => {
    const s = slots.get(id)!;
    return { id, layer: s.layer, x: colX(s.layer), y: s.y, w: o.nodeW, h: o.nodeH };
  });
  const centre = (s: Slot): [number, number] => [colX(s.layer) + o.nodeW / 2, s.y + s.h / 2];
  const placed: PlacedEdge[] = edges.map(([a, b]) => {
    const isBack = back.has(`${a}\u0000${b}`);
    const sa = slots.get(a)!;
    const sb = slots.get(b)!;
    let points: Array<[number, number]>;
    if (isBack) {
      // right edge of the later node to the left edge of the earlier one: a straight line is enough
      points = [
        [colX(sa.layer) + o.nodeW, sa.y + sa.h / 2],
        [colX(sb.layer), sb.y + sb.h / 2],
      ];
    } else {
      const chain = chains.get(`${a}\u0000${b}`)!;
      points = chain.map((id, i) => {
        const s = slots.get(id)!;
        const [cx, cy] = centre(s);
        if (i === 0) return [colX(s.layer) + o.nodeW, cy];
        if (i === chain.length - 1) return [colX(s.layer), cy];
        return [cx, cy];
      });
    }
    return { from: a, to: b, back: isBack, points, d: pathOf(points, isBack) };
  });
  const width = nLayers ? colX(nLayers - 1) + o.nodeW : 0;
  return { nodes, edges: placed, width, height: maxH, layers: nLayers };
}

/** Smooth curve through the points with horizontal tangents (straight line for a back edge). */
function pathOf(pts: Array<[number, number]>, straight: boolean): string {
  const f = (n: number) => Math.round(n * 10) / 10;
  if (pts.length === 0) return "";
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (straight) d += ` L${f(x1)},${f(y1)}`;
    else {
      const mx = (x0 + x1) / 2;
      d += ` C${f(mx)},${f(y0)} ${f(mx)},${f(y1)} ${f(x1)},${f(y1)}`;
    }
  }
  return d;
}
