import { test } from "node:test";
import assert from "node:assert/strict";
import { canEditComment, mergeDelta, rewriteComment, tombstoneComment } from "../src/lib/merge.ts";
import type { Comment, Thread } from "../src/lib/api.ts";

/** Only the fields the merge touches; the rest never reaches it. */
const t = (id: string, key: string, status = "open"): Thread =>
  ({ id, key, status }) as unknown as Thread;

test("a new thread is appended, not sorted in", () => {
  // Re-sorting under a reader's cursor moves the thing they were about to click.
  const out = mergeDelta([t("thr_1", "SN-1"), t("thr_3", "SN-3")], [t("thr_2", "SN-2")]);
  assert.deepEqual(out.map((x) => x.key), ["SN-1", "SN-3", "SN-2"]);
});

test("an updated thread is replaced IN PLACE", () => {
  // So the detail pane keeps its subject while somebody is reading it.
  const out = mergeDelta(
    [t("thr_1", "SN-1"), t("thr_2", "SN-2"), t("thr_3", "SN-3")],
    [t("thr_2", "SN-2", "resolved")],
  );
  assert.deepEqual(out.map((x) => x.key), ["SN-1", "SN-2", "SN-3"]);
  assert.equal(out[1]!.status, "resolved");
});

test("a tombstoned thread leaves, A36", () => {
  // The branch that could not be reached from the dashboard in a browser: the
  // owner never loses visibility of a thread, so this only happens to a
  // reviewer whose thread the studio just made team-only.
  const out = mergeDelta([t("thr_1", "SN-1"), t("thr_2", "SN-2")], [], ["thr_2"]);
  assert.deepEqual(out.map((x) => x.key), ["SN-1"]);
});

test("tombstones are applied BEFORE the upsert", () => {
  // A thread can be tombstoned by the very update that carries it — the write
  // that made it private bumped `updated_at`. Applying them the other way
  // round re-adds the row this poll exists to remove.
  const out = mergeDelta([t("thr_1", "SN-1")], [t("thr_1", "SN-1", "resolved")], ["thr_1"]);
  assert.deepEqual(out, [], "deleted wins over data");
});

test("an empty delta changes nothing, and that is the common case", () => {
  const before = [t("thr_1", "SN-1"), t("thr_2", "SN-2")];
  assert.deepEqual(mergeDelta(before, []).map((x) => x.key), ["SN-1", "SN-2"]);
});

test("the input array is not mutated", () => {
  // `setThreads` compares by reference; mutating `cur` would produce a state
  // update Preact can skip.
  const before = [t("thr_1", "SN-1")];
  const after = mergeDelta(before, [t("thr_2", "SN-2")]);
  assert.equal(before.length, 1);
  assert.notEqual(before, after);
});

test("a tombstone for something we never had is harmless", () => {
  // Two tabs, one already refreshed. Not an error.
  assert.deepEqual(mergeDelta([t("thr_1", "SN-1")], [], ["thr_9"]).map((x) => x.key), ["SN-1"]);
});

// ── Moderation: what a delete and an edit do to a row on screen ──

const said = (id: string, author: string, body: string): Comment => ({
  id,
  body,
  createdAt: "2026-10-01T10:00:00.000Z",
  author: { id: author, name: author === "rev_me" ? "Olu" : "Ada", kind: author === "rev_me" ? "verified" : "guest" },
});
const conversation = (): Thread =>
  ({ id: "thr_1", key: "SN-1", status: "open", comments: [said("cmt_1", "rev_ada", "It wraps."), said("cmt_2", "rev_me", "On it.")] }) as unknown as Thread;

test("a deleted comment stays in its place as a tombstone with its author's name", () => {
  // The conversation keeps its shape. Filtering it out would leave
  // "On it." answering nothing.
  const out = tombstoneComment(conversation(), "cmt_1", "2026-10-02T09:00:00.000Z");
  assert.deepEqual(out.comments.map((c) => c.id), ["cmt_1", "cmt_2"]);
  assert.deepEqual(out.comments[0], {
    id: "cmt_1",
    body: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    deletedAt: "2026-10-02T09:00:00.000Z",
    author: { name: "Ada" },
  });
  assert.equal(out.comments[1]!.body, "On it.", "nothing else moved");
});

test("a tombstone's author has no id, so it can never be 'mine' again", () => {
  const out = tombstoneComment(conversation(), "cmt_2", "2026-10-02T09:00:00.000Z");
  assert.equal(canEditComment(out.comments[1]!, "rev_me"), false);
});

test("Edit is offered on my own live comments only, and not before I am known", () => {
  const t = conversation();
  assert.equal(canEditComment(t.comments[1]!, "rev_me"), true);
  assert.equal(canEditComment(t.comments[0]!, "rev_me"), false, "an owner deletes a client's words, never rewrites them");
  assert.equal(canEditComment(t.comments[1]!, undefined), false, "the pool has not loaded");
});

test("an edit lands on the comment it names, and never revives a tombstone", () => {
  const edited = rewriteComment(conversation(), "cmt_2", "On it — fixed in staging.");
  assert.equal(edited.comments[1]!.body, "On it — fixed in staging.");
  assert.equal(edited.comments[0]!.body, "It wraps.");
  const dead = tombstoneComment(conversation(), "cmt_2", "2026-10-02T09:00:00.000Z");
  assert.equal(rewriteComment(dead, "cmt_2", "back from the dead").comments[1]!.body, null);
});
