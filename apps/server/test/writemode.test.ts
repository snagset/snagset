import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveWriteMode } from "../src/routes/sessions.ts";

/**
 * `effectiveWriteMode` — the read-time downgrade.
 *
 * NO DATABASE. This is the pure decision `sessions.ts` makes before it will
 * even look at an `identity` — whether a guest gets a session at all — so a
 * wrong answer here is a wrong answer on every request, not a request-shaped
 * fixture problem. See the function's own comment in `../src/routes/sessions.ts`
 * for why this can't wait for a reaper.
 */

const AT = new Date("2026-08-19T12:00:00Z");
const hoursFromAt = (h: number) => new Date(AT.getTime() + h * 3_600_000);

test("open, no downgrade set, stays open", () => {
  assert.equal(effectiveWriteMode({ write_mode: "open", write_mode_downgrade_at: null }, AT), "open");
});

test("open with a downgrade timestamp in the past is link-required", () => {
  assert.equal(
    effectiveWriteMode({ write_mode: "open", write_mode_downgrade_at: hoursFromAt(-1) }, AT),
    "link-required",
  );
});

test("open with a downgrade timestamp exactly now is link-required — the boundary is inclusive", () => {
  assert.equal(effectiveWriteMode({ write_mode: "open", write_mode_downgrade_at: AT }, AT), "link-required");
});

test("open with a downgrade timestamp in the future stays open", () => {
  assert.equal(
    effectiveWriteMode({ write_mode: "open", write_mode_downgrade_at: hoursFromAt(1) }, AT),
    "open",
  );
});

test("link-required is link-required regardless of the downgrade column", () => {
  assert.equal(
    effectiveWriteMode({ write_mode: "link-required", write_mode_downgrade_at: null }, AT),
    "link-required",
  );
  assert.equal(
    effectiveWriteMode({ write_mode: "link-required", write_mode_downgrade_at: hoursFromAt(1) }, AT),
    "link-required",
  );
});

test("verified-only passes through untouched — the downgrade column only ever applies to open", () => {
  assert.equal(
    effectiveWriteMode({ write_mode: "verified-only", write_mode_downgrade_at: null }, AT),
    "verified-only",
  );
});
