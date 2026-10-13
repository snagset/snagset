#!/usr/bin/env node
/**
 * Where the bytes in each chunk actually went — plan task 2, (v0).
 *
 * This task definition of done: *"the harness exists from day one: the
 * module-size map prints the anchor core's bytes inside `snag.runtime.js`
 * .8's 6 KB, and prints the redaction predicates' bytes
 * separately."* It did not exist, so the anchor core's sub-budget — the
 * *"≤ 6 KB gz inside `snag.runtime.js`… Not 8 KB, not 12 KB"* — was measured by
 * nothing at all.
 *
 * That is a different gap from the size gate. `pnpm size` bounds each ARTEFACT;
 * this bounds a REGION inside one, which is the number that decides whether the
 * anchor cascade can grow. Two things were explicitly landed into that region
 * since the budget was set — `@medv/finder` (task 22) and the redaction
 * predicates (task 23) — and nobody could say what either cost.
 *
 * ── HOW THE BYTES ARE ATTRIBUTED ──
 *
 * From the build's own source map, which is the only honest source: it maps
 * every byte of output back to the module that produced it, AFTER minification
 * and tree-shaking. Summing the source files would measure something nobody
 * downloads.
 *
 * Gzip is estimated by compressing each region's extracted output separately.
 * That is not the same as its share of the whole chunk's gzip — a shared
 * dictionary makes the parts sum to more than the whole — so the number is
 * reported as an upper bound and says so. An honest over-estimate is the right
 * direction for a budget.
 */
import { gzipSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "packages/widget-core/dist");
// The registry stores SUFFIXES; `derive` turns them into filenames. Reading it
// raw gives `{stub:"", runtime:"runtime", …}` and every lookup silently misses —
// which is how the first run of this file printed a header, no rows and exit 0.
const reg = JSON.parse(readFileSync(join(ROOT, "packages/types/registry.json"), "utf8"));
const { derive } = await import(join(ROOT, "packages/types/scripts/registry-derive.mjs"));
const artefacts = derive(reg).artifacts;

/**
 * The regions worth naming, and the budget each is measured against.
 *
 * `null` means "reported, not gated" — the same distinction draws for the
 * per-file rows: a number nobody has ratified should be visible and should not
 * fail a build.
 */
const REGIONS = [
  {
    name: "anchor core",
    chunk: "runtime",
    match: /\/src\/anchor\//,
    // 6000, not 6 * 1024. The envelope re-derivation settled the unit for the
    // whole repository at 1000 bytes — resolving the ambiguity in the row
    // everyone watches and leaving it in the row nobody does is how the two
    // drift apart.
    budget: 6000,
    cite: "\"≤ 6 KB gz inside snag.runtime.js. Not 8 KB, not 12 KB\"",
  },
  {
    // In the CAPTURE chunk, not the runtime — `selector.ts` is creation-side,
    // and creation only happens with a composer open. Worth stating: the budget
    // note in task 2 assumed finder would land in the anchor core's allowance
    // and it does not, so the 6 KB has more room than that note implies.
    name: "  finder (capture)",
    chunk: "capture",
    match: /node_modules\/@medv\/finder/,
    budget: null,
    cite: "task 22 — a new resident of the anchor core's allowance",
  },
  {
    name: "redaction predicates",
    chunk: "runtime",
    match: /\/src\/redact\//,
    budget: null,
    cite: "resident in the RUNTIME; capture bundles its own copy from the same source",
  },
  {
    name: "string catalogues",
    chunk: "panels",
    match: /\/src\/strings\//,
    budget: null,
    cite: "were 16.6% of this chunk before the four-way split",
  },
];

/** Decoded VLQ segments are not needed — only which sources exist and their sizes. */
function regionBytes(chunkFile, match) {
  const mapPath = join(DIST, `${chunkFile}.map`);
  if (!existsSync(mapPath)) return null;
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const code = readFileSync(join(DIST, chunkFile), "utf8");

  // Which source indices belong to the region.
  const wanted = new Set(
    map.sources.map((s, i) => (match.test(s) ? i : -1)).filter((i) => i >= 0),
  );
  if (!wanted.size) return { raw: 0, gz: 0, modules: 0 };

  /* Walk the mappings, accumulating the output span attributed to each source.
     Format: groups separated by ';' (one per generated line), segments by ','.
     Field 1 of a segment is the generated column delta, field 2 the source
     index delta. A segment owns output up to the next segment's column. */
  let outIdx = 0;
  let srcIdx = 0;
  let owned = 0;
  const lines = code.split("\n");
  map.mappings.split(";").forEach((group, line) => {
    if (!group) return;
    let col = 0;
    const segs = group.split(",").map(decode);
    segs.forEach((seg, i) => {
      col += seg[0] ?? 0;
      if (seg.length >= 4) srcIdx += seg[1] ?? 0;
      const nextCol = i + 1 < segs.length ? col + (segs[i + 1][0] ?? 0) : (lines[line]?.length ?? col);
      if (wanted.has(srcIdx)) owned += Math.max(0, nextCol - col);
    });
    outIdx += 1;
  });
  void outIdx;

  // A representative slice, compressed on its own — see the header on why this
  // is an upper bound rather than a share.
  const ratio = gzipSync(Buffer.from(code)).length / code.length;
  return { raw: owned, gz: Math.round(owned * ratio), modules: wanted.size };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decode(seg) {
  const out = [];
  let shift = 0;
  let value = 0;
  for (const ch of seg) {
    const d = B64.indexOf(ch);
    if (d < 0) continue;
    value += (d & 31) << shift;
    if (d & 32) {
      shift += 5;
    } else {
      const neg = value & 1;
      value >>= 1;
      out.push(neg ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

const kb = (n) => `${(n / 1024).toFixed(2)} KB`;
let failed = false;
let rows = 0;

console.log("\n  MODULE-SIZE MAP\n");
for (const r of REGIONS) {
  const file = artefacts[r.chunk];
  if (!file) continue;
  const got = regionBytes(file, r.match);
  if (!got) {
    console.log(`  ? ${r.name.padEnd(22)} no source map for ${file} — build with sourcemap:true`);
    continue;
  }
  if (got.raw > 0) rows++;
  const over = r.budget !== null && got.gz > r.budget;
  if (over) failed = true;
  const limit = r.budget === null ? "reported" : `${kb(got.gz)} / ${kb(r.budget)}`;
  console.log(
    `  ${over ? "✗" : "✓"} ${r.name.padEnd(22)} ${kb(got.gz).padStart(9)} gz (est, upper bound) · ` +
      `${String(got.modules).padStart(3)} modules · ${r.budget === null ? "no gate" : limit}`,
  );
  console.log(`      ${r.cite}`);
}

/**
 * A MAP THAT ATTRIBUTES NOTHING MUST NOT PASS.
 *
 * The same lesson as `lint-names`, learned the same way an hour earlier: the
 * first version of this file resolved every artefact filename to `undefined`,
 * printed a header with no rows, and exited 0. A tool whose silence is
 * indistinguishable from success is worse than no tool.
 */
if (!rows) {
  console.error(
    "\n✗ module-map attributed no bytes to any region — the source-map walk or the\n" +
      "  artefact names are wrong, and a map that measures nothing is not a map.\n",
  );
  process.exit(1);
}

console.log(
  `\n  gz figures are an UPPER BOUND: each region is compressed alone, so it loses\n` +
    `  the dictionary it shares with the rest of its chunk. Over-estimating is the\n` +
    `  right direction for a budget.\n`,
);

if (failed) {
  console.error("✗ a gated region is over its budget — the budgets are not targets.\n");
  process.exit(1);
}
