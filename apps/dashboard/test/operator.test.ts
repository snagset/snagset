import { test } from "node:test";
import assert from "node:assert/strict";
import { isOperator, storageRow } from "../src/lib/operator.ts";

const GB = 1024 ** 3;
/** As much of `/api/v1/me` as the two decisions read: whose the instance is, and the plan's storage number. */
const me = (operator: boolean | undefined, storageLimit: number | null = null) => ({
  org: { name: "Kilnwork", slug: "kilnwork", ...(operator === undefined ? {} : { operator }) },
  limits: {
    projects: { limit: null, used: 1 },
    members: { limit: null, used: 1 },
    storage: { limit: storageLimit, used: 0 },
    screenshots: true,
    integrations: true,
    source: "default" as const,
  },
});

test("the instance's rows are drawn for the operator's studio and left out of every other", () => {
  assert.equal(isOperator(me(true)), true);
  assert.equal(isOperator(me(false)), false, "another studio: the page does not ask, so it has no refusal to draw");
});

test("a server that does not say is one where every studio could: the rows stay", () => {
  assert.equal(isOperator(me(undefined)), true, "only an explicit false leaves them out");
  assert.equal(storageRow(me(undefined)), "instance");
});

test("another studio keeps the one storage number that is its own, and has no row without one", () => {
  assert.equal(storageRow(me(true)), "instance");
  assert.equal(storageRow(me(true, 5 * GB)), "instance", "the operator's row carries the number itself");
  assert.equal(storageRow(me(false, 5 * GB)), "usage", "The number comes with /me, not from the instance");
  assert.equal(storageRow(me(false, 0)), "usage", "a plan with no storage at all is still a number");
  assert.equal(storageRow(me(false)), "none", "no cap, no row: the bucket is not theirs to see");
});
