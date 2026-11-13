import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stamp, placeholder, SLOT, HASH_LENGTH } from "../scripts/build-id.mjs";
import { VERSION } from "../src/build.ts";

/**
 * The build id — the `?cv=`, which was the constant "0.0.0".
 *
 * A cache-buster that never changes busts nothing: after every release the
 * page asked for `snag.runtime.js?cv=0.0.0` exactly as before, so the browser's
 * copy stayed fresh and the reviewer ran the old widget. These tests stamp two
 * miniature dist/ directories and read the chunk URL the stub would build.
 */

const V = "1.4.2";

/** A miniature dist/: a stub and a runtime carrying the placeholder, one leaf. */
function dist(leaf: string): string {
  const dir = mkdtempSync(join(tmpdir(), "snagset-build-id-"));
  const ph = JSON.stringify(placeholder(V));
  writeFileSync(join(dir, "snag.js"), `(function(){const S=${ph};import(new URL("snag.runtime.js?cv="+S,location.href).href)})();`);
  writeFileSync(join(dir, "snag.runtime.js"), `const V=${ph};export const panels="snag.panels.js?cv="+V;`);
  writeFileSync(join(dir, "snag.panels.js"), leaf);
  return dir;
}

/** The `cv` the stamped stub would put on its chunk URLs. */
const cvIn = (dir: string): string => /const S="([^"]+)"/.exec(readFileSync(join(dir, "snag.js"), "utf8"))![1]!;

test("two builds with different content produce different chunk URLs", () => {
  // The leaf differs and nothing else does — and the leaf is not even a
  // carrier of the id. Its bytes still have to rename every chunk URL, or a
  // fix to a lazy chunk would sit behind the old URL's year-long cache.
  const a = dist("export const p = 1;");
  const b = dist("export const p = 2;");
  const cvA = stamp(a, V);
  const cvB = stamp(b, V);
  assert.notEqual(cvA, cvB);
  assert.equal(cvIn(a), cvA, "the stub carries the id it was stamped with");
  assert.notEqual(
    new URL(`snag.runtime.js?cv=${encodeURIComponent(cvIn(a))}`, "https://x.test/").href,
    new URL(`snag.runtime.js?cv=${encodeURIComponent(cvIn(b))}`, "https://x.test/").href,
  );
});

test("the same content builds the same id — deterministic, so a rebuild busts nothing", () => {
  assert.equal(stamp(dist("export const p = 1;"), V), stamp(dist("export const p = 1;"), V));
});

test("the id is semver build metadata: <release>+<hash>, and nothing is left unstamped", () => {
  const dir = dist("export const p = 1;");
  const cv = stamp(dir, V);
  assert.match(cv, new RegExp(`^1\\.4\\.2\\+[0-9a-f]{${HASH_LENGTH}}$`));
  for (const f of ["snag.js", "snag.runtime.js"]) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.ok(!text.includes(SLOT), `${f} has no placeholder left`);
    assert.ok(text.includes(cv), `${f} carries ${cv}`);
  }
  // The placeholder and the id are the same length, so source-map columns
  // after it do not move (tools/module-map.mjs reads them).
  assert.equal(placeholder(V).length, cv.length);
  // And the server's half: build.json is how it knows which `cv` is current.
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "build.json"), "utf8")), { version: V, cv });
});

test("stamping twice is refused — a stamped build has no placeholder to hash", () => {
  const dir = dist("export const p = 1;");
  stamp(dir, V);
  assert.throws(() => stamp(dir, V), /carries/);
});

test("from SOURCE (the playground mounts the runtime that way), VERSION is an ordinary string", () => {
  assert.equal(VERSION, "0.0.0");
});
