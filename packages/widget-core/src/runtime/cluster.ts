/**
 * Pin clustering, the grouping half, pure on purpose.
 *
 * "Recomputed on every sync with a single-pass grid bucket (cell = threshold),
 * not pairwise — O(n)." The DoD asserts the single pass BY AN INSTRUMENTED
 * COUNTER, not by timing, which is why this is a function of plain points
 * rather than code threaded through pins.ts: the counter is testable against
 * the exact algorithm the pin layer runs.
 *
 * The pass: each point is visited ONCE (`visits` counts exactly that). Its
 * cell is `floor(coord / threshold)`; only the 3×3 cell neighbourhood can
 * contain a centre within one threshold, so membership is decided against the
 * constant-size set of groups already seeded there — never against every
 * other point. A point joins the first existing group whose SEED is within
 * the threshold, else it seeds a new group in its own cell. Chaining (A near
 * B near C with A far from C) therefore does not merge A and C — the spec's
 * sentence is about pin pairs within 24 px, and seed-distance keeps a cluster
 * from smearing down a column of pins.
 */

export interface ClusterPoint {
  x: number;
  y: number;
}

export interface Clusters {
  /** For each input index, the group it landed in. */
  group: number[];
  /** Group id → member input indices, in input order. */
  members: number[][];
  /** Points visited — the DoD's counter. MUST equal the input length. */
  visits: number;
}

export function clusterPoints(points: readonly ClusterPoint[], threshold: number): Clusters {
  const group: number[] = new Array(points.length);
  const members: number[][] = [];
  /** cell key → group ids seeded in that cell. */
  const seeds = new Map<string, number[]>();
  const seedAt: ClusterPoint[] = [];
  let visits = 0;

  for (let i = 0; i < points.length; i++) {
    visits++;
    const p = points[i]!;
    const cx = Math.floor(p.x / threshold);
    const cy = Math.floor(p.y / threshold);
    let g = -1;
    outer: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of seeds.get(`${cx + dx},${cy + dy}`) ?? []) {
          const s = seedAt[id]!;
          const ddx = p.x - s.x;
          const ddy = p.y - s.y;
          if (ddx * ddx + ddy * ddy <= threshold * threshold) {
            g = id;
            break outer;
          }
        }
      }
    }
    if (g === -1) {
      g = members.length;
      members.push([]);
      seedAt.push(p);
      const key = `${cx},${cy}`;
      const list = seeds.get(key);
      if (list) list.push(g);
      else seeds.set(key, [g]);
    }
    group[i] = g;
    members[g]!.push(i);
  }
  return { group, members, visits };
}
