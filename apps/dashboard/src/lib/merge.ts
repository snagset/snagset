import type { Comment, Thread } from "./api.ts";

/**
 * Fold a `?since=` delta into the list already on screen.
 *
 * Extracted from the visibility handler because it is the only part of that
 * effect with a decision in it, and because the branch that matters could not
 * be reached from the dashboard at all: tombstones exist for callers who LOSE
 * visibility of a thread, and the dashboard is signed in as the owner, who
 * never does. Proving it in the browser was impossible; proving it here is four
 * lines.
 *
 * ── ORDER MATTERS ──
 *
 * Tombstones first. A thread can appear in `deleted` for one caller in the same
 * response that carries an update for it — the update is what made it private —
 * and applying them the other way round would re-add the row this poll exists
 * to remove.
 *
 * ── WHY MERGE RATHER THAN REPLACE ──
 *
 * A re-list would replace the array and lose the selected thread's identity
 * while somebody is reading it. Existing rows are updated IN PLACE so the
 * detail pane keeps its subject, and new ones are appended rather than sorted
 * in: re-sorting under a reader's cursor moves the thing they were about to
 * click.
 */
export function mergeDelta(
  current: Thread[],
  incoming: readonly Thread[],
  deleted: readonly string[] = [],
): Thread[] {
  const gone = new Set(deleted);
  const merged = current.filter((t) => !gone.has(t.id));
  for (const t of incoming) {
    // …and a thread that is BOTH tombstoned and in `data` stays out. That
    // combination should not occur — the server partitions on one visibility
    // flag — but "deleted wins" is the safe reading of a contradiction, since
    // the alternative is showing a client something the studio hid.
    if (gone.has(t.id)) continue;
    const at = merged.findIndex((x) => x.id === t.id);
    if (at === -1) merged.push(t);
    else merged[at] = t;
  }
  return merged;
}

/**
 * The moderation writes, folded into a row the same way — pure, so the rules
 * in them are provable here rather than only by clicking.
 *
 * ── A DELETED COMMENT BECOMES A TOMBSTONE, IT DOES NOT LEAVE ──
 *
 * The row keeps its place and its author's name, and loses its words.
 * Filtering it out instead would leave the next reply answering nothing, and
 * the server agrees — the owner's reads carry tombstones, so the next poll
 * draws the same hole this does rather than taking it back.
 *
 * The author is cut down to the name for the same reason the server cuts it:
 * a tombstone must not keep matching "is this mine?" and offer an Edit for
 * words that no longer exist.
 */
export function tombstoneComment(t: Thread, commentId: string, deletedAt: string): Thread {
  return {
    ...t,
    comments: t.comments.map((c) =>
      c.id === commentId ? { id: c.id, body: null, createdAt: c.createdAt, deletedAt, author: { name: c.author.name } } : c,
    ),
  };
}

/** An edit lands on the one comment it names; every other field of the row is the server's to move. */
export function rewriteComment(t: Thread, commentId: string, body: string): Thread {
  return { ...t, comments: t.comments.map((c) => (c.id === commentId && c.body !== null ? { ...c, body } : c)) };
}

/**
 * Edit is offered on the signed-in person's OWN live comments and nowhere
 * else — the server refuses an owner rewriting anybody else's words, and a
 * menu item that can only fail is a lie in the menu.
 *
 * `myId` is the person's reviewer row on THIS site (the assignee pool's
 * `isMe`): a dashboard reply is written under it, so it is the id a reply of
 * theirs carries. Unknown — the pool not loaded yet — is "not mine".
 */
export function canEditComment(c: Comment, myId: string | undefined): boolean {
  return !!myId && c.body !== null && !c.deletedAt && c.author.id === myId;
}
