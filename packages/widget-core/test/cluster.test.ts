import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterPoints } from "../src/runtime/cluster.ts";

/**
 * The algorithm contract, asserted the way the DoD demands: "single-pass
 * … by an instrumented counter, not by timing". `visits` counts points
 * visited; a pairwise implementation cannot produce visits === n while still
 * grouping correctly, because grouping requires it to LOOK at other points —
 * which the grid does through constant-size cell buckets instead.
 */

test("every point is visited exactly once — the instrumented single pass", () => {
  const pts = Array.from({ length: 500 }, (_, i) => ({
    x: (i * 137) % 1900,
    y: (i * 89) % 4000,
  }));
  const c = clusterPoints(pts, 24);
  assert.equal(c.visits, pts.length);
  // Every point landed in exactly one group, and the groups partition the set.
  assert.equal(
    c.members.reduce((a, g) => a + g.length, 0),
    pts.length,
  );
});

test("centres within the threshold cluster; distant ones do not", () => {
  const c = clusterPoints(
    [
      { x: 100, y: 100 },
      { x: 110, y: 112 }, // 15.6 px away — clusters at 24
      { x: 100, y: 300 }, // far — its own group
    ],
    24,
  );
  assert.equal(c.members.length, 2);
  assert.deepEqual(c.members[0], [0, 1]);
  assert.deepEqual(c.members[1], [2]);
});

test("the coarse threshold widens membership (24 → 32)", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 0, y: 28 }, // 28 px apart
  ];
  assert.equal(clusterPoints(pts, 24).members.length, 2);
  assert.equal(clusterPoints(pts, 32).members.length, 1);
});

test("seed distance stops a cluster smearing down a column of pins", () => {
  // A chain: each 20 px from the last, 24-px threshold. Pairwise-transitive
  // grouping would merge all five; seed-distance keeps groups within one
  // threshold of their seed, so the chain breaks into more than one group.
  const pts = Array.from({ length: 5 }, (_, i) => ({ x: 0, y: i * 20 }));
  const c = clusterPoints(pts, 24);
  assert.ok(c.members.length >= 2, `chain merged into ${c.members.length} group(s)`);
  for (const g of c.members) {
    const seed = pts[g[0]!]!;
    for (const i of g) {
      const p = pts[i]!;
      assert.ok(Math.hypot(p.x - seed.x, p.y - seed.y) <= 24, "member beyond its seed's threshold");
    }
  }
});

test("empty input is a no-op, not an error", () => {
  const c = clusterPoints([], 24);
  assert.equal(c.visits, 0);
  assert.deepEqual(c.members, []);
});
