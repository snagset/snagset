import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Assignee, type Comment, type Reviewer, type Round, type Thread, type Tracker } from "./api";
import { mergeDelta, rewriteComment, tombstoneComment } from "./merge";
import { q, queryClient } from "./query";
import { reason } from "./mutations";

/**
 * A site's threads, kept fresh by DELTAS, rule 2.
 *
 * The first read lists; every read after it sends the previous response's
 * `serverTime` as `?since=` (never a clock this browser owns) and
 * folds the answer into what is on screen with `mergeDelta`, so a row being
 * read keeps its identity and a row that moved moves in place. A re-list
 * would replace the array and lose the selected thread's identity mid-read.
 *
 * The round, the page and the search go to the server. Status does NOT: it
 * filters client-side so the chips can carry whole-round counts, the way the
 * widget's do — a count that only knows the rows already filtered by itself
 * is a count of 1.
 */
export interface ListFilters {
  round?: number;
  route?: string;
  q?: string;
}

export interface ThreadList {
  data: Thread[];
  serverTime: string;
}

/** The cursor per query, outside the cache so a refetch can read it. */
const cursors = new Map<string, string>();

export function threadsQuery(uid: string, f: ListFilters = {}) {
  const key = ["threads", uid, f] as const;
  const ck = JSON.stringify(key);
  return queryOptions({
    queryKey: key,
    queryFn: async (): Promise<ThreadList> => {
      const prev = queryClient.getQueryData<ThreadList>(key);
      const since = prev ? cursors.get(ck) : undefined;
      const res = await api.threads(uid, { ...f, ...(since ? { since } : {}) });
      cursors.set(ck, res.serverTime);
      if (prev && since) return { data: mergeDelta(prev.data, res.data, res.deleted), serverTime: res.serverTime };
      return { data: res.data, serverTime: res.serverTime };
    },
    // Every 30 s while the tab is visible, and on focus — TanStack pauses the
    // interval in a background tab, which is the widget's own floor.
    refetchInterval: 30_000,
  });
}

type ListKey = ReturnType<typeof threadsQuery>["queryKey"];

function patchRow(qc: ReturnType<typeof useQueryClient>, key: ListKey, id: string, fn: (t: Thread) => Thread) {
  qc.setQueryData<ThreadList>(key, (cur) => (cur ? { ...cur, data: cur.data.map((t) => (t.id === id ? fn(t) : t)) } : cur));
}

/**
 * A status change — optimistic, WHOLE-ROW snapshot: `resolvedAt` and
 * `updatedAt` move with a status too, and reverting one field of three
 * leaves a row claiming to be open with a resolved timestamp on it.
 */
export function useSetStatus(uid: string, key: ListKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: Thread["status"] }) => api.setStatus(uid, id, status),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: key });
      const was = qc.getQueryData<ThreadList>(key)?.data.find((t) => t.id === id);
      patchRow(qc, key, id, (t) => ({ ...t, status }));
      return { was };
    },
    onSuccess: (fresh, { id }) => patchRow(qc, key, id, (t) => ({ ...t, ...fresh })),
    onError: (err, { id }, ctx) => {
      if (ctx?.was) patchRow(qc, key, id, () => ctx.was!);
      toast.error(reason(err));
    },
    // The sidebar's count and the round's "to go" come from the server.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: q.me().queryKey });
      void qc.invalidateQueries({ queryKey: q.rounds(uid).queryKey });
    },
  });
}

/**
 * An assignment — optimistic like a status, and the same whole-row snapshot
 * for the same reason. The variables carry the PERSON, not the id, so the row
 * can show the name before the server answers.
 */
export function useSetAssignee(uid: string, key: ListKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, assignee }: { id: string; assignee: Assignee | null }) => api.setAssignee(uid, id, assignee?.id ?? null),
    onMutate: async ({ id, assignee }) => {
      await qc.cancelQueries({ queryKey: key });
      const was = qc.getQueryData<ThreadList>(key)?.data.find((t) => t.id === id);
      patchRow(qc, key, id, (t) => ({ ...t, assignee }));
      return { was };
    },
    onSuccess: (fresh, { id }) => patchRow(qc, key, id, (t) => ({ ...t, ...fresh })),
    onError: (err, { id }, ctx) => {
      if (ctx?.was) patchRow(qc, key, id, () => ctx.was!);
      toast.error(reason(err));
    },
  });
}

/** "Create … issue" — pessimistic (the button shows the gerund), the link lands on the row. */
export function useCreateIssue(uid: string, key: ListKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, provider }: { id: string; provider: Tracker }) => api.createIssue(uid, id, provider),
    onSuccess: ({ ref }, { id }) =>
      patchRow(qc, key, id, (t) => ({ ...t, refs: [...(t.refs ?? []).filter((r) => !(r.provider === ref.provider && r.kind === ref.kind)), ref] })),
    onError: (err) => toast.error(reason(err)),
  });
}

/** Naming a person who has not written yet — the pool refetches once they exist. */
export function useAddAssignee(uid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; email?: string }): Promise<Reviewer> => api.addAssignee(uid, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: q.assignees(uid).queryKey }),
  });
}

/** A reply waits — the composer shows the gerund — and lands in the row on success. */
export function useAddComment(key: ListKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => api.addComment(id, body),
    onSuccess: (comment: Comment, { id }) =>
      patchRow(qc, key, id, (t) => ({ ...t, comments: [...t.comments, comment], commentCount: t.commentCount + 1 })),
  });
}

/**
 * Editing your own reply — PESSIMISTIC, unlike a status. The field is what the
 * person is looking at and it stays open, locked, with Save showing it is
 * working until the server answers; on a refusal the draft is still
 * there to fix. An optimistic edit would have to put the old words back on a
 * failure, which reads as the edit being undone by somebody else.
 *
 * The delta poll is asked for afterwards because the server moved the
 * thread's `version` with the edit, and a Resolve sent with the old one would
 * meet a conflict nobody caused.
 */
export function useEditComment(key: ListKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, body }: { threadId: string; commentId: string; body: string }) => api.editComment(commentId, body),
    onSuccess: (fresh, { threadId, commentId }) => patchRow(qc, key, threadId, (t) => rewriteComment(t, commentId, fresh.body ?? "")),
    onError: (err) => toast.error(reason(err)),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });
}

/**
 * Deleting a comment — any comment, as the studio. Waits behind its confirm
 * like every delete here, and lands as the tombstone in place: the
 * author's name stays, the words go.
 */
export function useDeleteComment(key: ListKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId }: { threadId: string; commentId: string }) => api.deleteComment(commentId),
    onSuccess: (gone, { threadId, commentId }) => patchRow(qc, key, threadId, (t) => tombstoneComment(t, commentId, gone.deletedAt)),
    onError: (err) => toast.error(reason(err)),
    // The counters (public or not is the server's to know) and the version.
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });
}

/**
 * Deleting the whole thread. Waits; on success the row leaves this list at
 * once, and every OTHER list of this site (another round, another filter)
 * learns it from its own next poll's `deleted[]`, which is what that array is
 * for. The sidebar's counts and the rounds' "to go" are the server's.
 */
export function useDeleteThread(uid: string, key: ListKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) => api.deleteThread(uid, threadId),
    onSuccess: (_none, threadId) =>
      qc.setQueryData<ThreadList>(key, (cur) => (cur ? { ...cur, data: mergeDelta(cur.data, [], [threadId]) } : cur)),
    onError: (err) => toast.error(reason(err)),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: q.me().queryKey });
      void qc.invalidateQueries({ queryKey: q.rounds(uid).queryKey });
    },
  });
}

/** Opens the next round; the server closes the previous one in the same statement. */
export function useCreateRound(uid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createRound(uid, name),
    onSuccess: (_made: Round) => {
      void qc.invalidateQueries({ queryKey: q.rounds(uid).queryKey });
      void qc.invalidateQueries({ queryKey: ["threads", uid] });
      void qc.invalidateQueries({ queryKey: q.me().queryKey });
    },
    onError: (err) => toast.error(reason(err)),
  });
}
