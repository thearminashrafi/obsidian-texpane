import { describe, it, expect } from "vitest";
import { layoutGraph } from "../src/core/blueprintGraph";

const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layoutGraph", () => {
  it("puts prerequisites left of what depends on them (longest path layering)", () => {
    const l = layoutGraph(["a", "b", "c", "d"], [["a", "b"], ["b", "c"], ["a", "c"], ["a", "d"]]);
    const layer = Object.fromEntries(l.nodes.map((n) => [n.id, n.layer]));
    expect(layer).toEqual({ a: 0, b: 1, c: 2, d: 1 });
    const x = Object.fromEntries(l.nodes.map((n) => [n.id, n.x]));
    expect(x.a).toBeLessThan(x.b);
    expect(x.b).toBeLessThan(x.c);
    expect(l.layers).toBe(3);
    expect(l.width).toBe(x.c + 150);
  });

  it("no two nodes overlap and everything is inside the reported size", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
    const edges: Array<[string, string]> = [];
    for (let i = 1; i < 40; i++) {
      edges.push([`n${(i * 7) % i}`, `n${i}`]);
      if (i > 3) edges.push([`n${i - 3}`, `n${i}`]);
    }
    const l = layoutGraph(ids, edges);
    for (let i = 0; i < l.nodes.length; i++) {
      const n = l.nodes[i];
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(l.width);
      expect(n.y + n.h).toBeLessThanOrEqual(l.height + 0.001);
      for (let j = i + 1; j < l.nodes.length; j++) expect(overlap(n, l.nodes[j])).toBe(false);
    }
    expect(l.edges.length).toBe(new Set(edges.map((e) => e.join(">"))).size);
  });

  it("long edges are routed through the layers they cross, not through nodes", () => {
    const l = layoutGraph(["a", "b", "c", "d"], [["a", "b"], ["b", "c"], ["c", "d"], ["a", "d"]]);
    const long = l.edges.find((e) => e.from === "a" && e.to === "d")!;
    expect(long.points.length).toBe(4); // a, two dummy slots, d
    for (const [px, py] of long.points.slice(1, -1)) {
      for (const n of l.nodes) expect(px >= n.x && px <= n.x + n.w && py >= n.y && py <= n.y + n.h).toBe(false);
    }
    expect(long.d.startsWith("M")).toBe(true);
    expect(long.d).toContain("C");
  });

  it("copes with cycles, self loops, duplicates, unknown ids and isolated nodes", () => {
    const l = layoutGraph(["a", "b", "c", "a"], [["a", "b"], ["b", "a"], ["a", "a"], ["a", "b"], ["z", "a"], ["c", "q"]]);
    expect(l.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(l.edges.length).toBe(2);
    expect(l.edges.filter((e) => e.back).length).toBe(1);
    expect(l.nodes.find((n) => n.id === "c")!.layer).toBe(0);
  });

  it("empty graph", () => {
    expect(layoutGraph([], [])).toMatchObject({ nodes: [], edges: [], width: 0, height: 0, layers: 0 });
  });

  it("barycenter ordering untangles a simple crossing", () => {
    // sources s1,s2; targets t1,t2 connected straight (s1-t1, s2-t2) but given in crossed order
    const l = layoutGraph(["s1", "s2", "t2", "t1"], [["s1", "t1"], ["s2", "t2"]]);
    const y = Object.fromEntries(l.nodes.map((n) => [n.id, n.y]));
    expect(Math.sign(y.s1 - y.s2)).toBe(Math.sign(y.t1 - y.t2));
  });
});
