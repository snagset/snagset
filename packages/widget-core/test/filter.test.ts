import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_STATUSES,
  activeFacets,
  countStatuses,
  defaultFilter,
  isUnread,
  listNarrow,
  pinPass,
  sortSnags,
  toggleStatus,
  type ListFilter,
} from "../src/storage/filter.ts";
import type { Snag, Status } from "../src/storage/types.ts";

/**
 * The model, unit-tested at the split: the pin-governing quartet and
 * the list-only quartet must never leak into each other — asserts
 * the same boundary on rendered bytes, this asserts it on the predicates.
 */

const who = (id: string, name: string) => ({ id, name, kind: "guest" as const });

function snag(over: Partial<Snag> & { id: string }): Snag {
  return {
    key: `SN-${over.id}`,
    route: "/a",
    anchor: { label: "x" } as Snag["anchor"],
    anchorState: "anchored",
    status: "open",
    comments: [],
    createdBy: who("rev_a", "Ada"),
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  } as Snag;
}

test("statuses: [] and all-four both mean no filter, and all four stay lit", () => {
  const s = snag({ id: "1", status: "resolved" });
  assert.ok(pinPass(s, defaultFilter()));
  assert.ok(pinPass(s, { ...defaultFilter(), statuses: [...ALL_STATUSES] as Status[] }));
  // Pastel's model: the fourth chip stays lit rather than collapsing to none.
  assert.deepEqual(toggleStatus(["open", "progress", "review"], "resolved"), ["open", "progress", "review", "resolved"]);
  assert.deepEqual(toggleStatus([], "open"), ["open"]);
  // The last lit chip stays lit (Pastel): never an empty selection.
  assert.deepEqual(toggleStatus(["open"], "open"), ["open"]);
  assert.deepEqual(toggleStatus(["open", "review"], "open"), ["review"]);
  // The default is all four lit, and that hides nothing.
  assert.deepEqual(defaultFilter().statuses, [...ALL_STATUSES]);
});

test("the pin-governing quartet filters; the list-only quartet never does (the split)", () => {
  const s = snag({ id: "1", status: "open" });
  assert.equal(pinPass(s, { ...defaultFilter(), statuses: ["resolved"] }), false);
  assert.equal(pinPass(s, { ...defaultFilter(), by: "rev_b" }), false);
  assert.equal(pinPass(s, { ...defaultFilter(), page: "/b" }), false);
  // q / pageOnly / newOnly / sort are not even parameters of the pin predicate:
  const listOnly: ListFilter = { ...defaultFilter(), q: "zzz", pageOnly: true, newOnly: true, sort: "newest" };
  assert.equal(pinPass(s, listOnly), true);
});

test("F-07b: an unknown status is never hidden by a status filter it cannot match", () => {
  const weird = snag({ id: "1", status: "wontfix" as Status });
  assert.ok(pinPass(weird, { ...defaultFilter(), statuses: ["open"] }));
  const counts = countStatuses([weird, snag({ id: "2" })]);
  assert.equal(counts.all, 2);
  assert.equal(counts.byStatus.get("wontfix"), 1);
  assert.equal(counts.byStatus.get("open"), 1);
});

test("q matches body, replies, and author names, case-insensitive, tombstones tolerated", () => {
  const s = snag({
    id: "1",
    comments: [
      { id: "c1", snagId: "thr_1", body: "the HERO wraps", author: who("rev_a", "Ada"), createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "c2", snagId: "thr_1", body: undefined as unknown as string, author: who("rev_b", "Grace"), createdAt: "2026-08-01T00:00:00.000Z" },
    ],
  });
  const f = (q: string): Snag[] => listNarrow([s], { ...defaultFilter(), q }, "/a");
  assert.equal(f("hero").length, 1);
  assert.equal(f("grace").length, 1);
  assert.equal(f("zeppelin").length, 0);
});

test("pageOnly narrows to the current route; the pill narrows to unseen", () => {
  const a = snag({ id: "1", route: "/a" });
  const b = snag({ id: "2", route: "/b", updatedAt: "2026-08-02T00:00:00.000Z" });
  assert.deepEqual(
    listNarrow([a, b], { ...defaultFilter(), pageOnly: true }, "/a").map((s) => s.id),
    ["1"],
  );
  const seen = new Map([["1", Date.parse("2026-08-03T00:00:00.000Z")]]);
  assert.equal(isUnread(a, seen), false);
  assert.equal(isUnread(b, seen), true);
  assert.deepEqual(
    listNarrow([a, b], { ...defaultFilter(), newOnly: true }, "/a", seen).map((s) => s.id),
    ["2"],
  );
});

test("date sorts flatten by CREATION time; page sort leaves the dock's grouping alone", () => {
  const early = snag({ id: "1", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" });
  const late = snag({ id: "2", createdAt: "2026-08-05T00:00:00.000Z" });
  assert.deepEqual(sortSnags([early, late], "newest").map((s) => s.id), ["2", "1"]);
  assert.deepEqual(sortSnags([late, early], "oldest").map((s) => s.id), ["1", "2"]);
  const input = [late, early];
  assert.equal(sortSnags(input, "page"), input);
});

test("the Filter button counts its own panel's facets, nothing else", () => {
  assert.equal(activeFacets(defaultFilter()), 0);
  assert.equal(activeFacets({ ...defaultFilter(), read: "unread", by: "rev_a", page: "/a" }), 3);
  // statuses, q, sort, pageOnly live OUTSIDE the Filter panel.
  assert.equal(activeFacets({ ...defaultFilter(), statuses: ["open"], q: "x", sort: "newest", pageOnly: true }), 0);
});

test("Assignee is pin-governing — a person, Unassigned (null), or anyone (absent)", () => {
  const ada = who("rev_a", "Ada");
  const withAda = snag({ id: "1", assignee: ada });
  const nobody = snag({ id: "2", assignee: null });
  const legacy = snag({ id: "3" }); // a local record never carries the field at all
  const f = (assignee: string | null): ListFilter => ({ ...defaultFilter(), assignee });
  assert.equal(pinPass(withAda, f("rev_a")), true);
  assert.equal(pinPass(withAda, f("rev_b")), false);
  assert.equal(pinPass(nobody, f("rev_a")), false);
  // Unassigned matches both spellings of "nobody": null and absent.
  assert.equal(pinPass(nobody, f(null)), true);
  assert.equal(pinPass(legacy, f(null)), true);
  assert.equal(pinPass(withAda, f(null)), false);
  // Absent is no filter.
  for (const s of [withAda, nobody, legacy]) assert.equal(pinPass(s, defaultFilter()), true);
  // It is a Filter-panel facet, and "Unassigned" counts as set even though it is null.
  assert.equal(activeFacets(f(null)), 1);
  assert.equal(activeFacets(f("rev_a")), 1);
});
