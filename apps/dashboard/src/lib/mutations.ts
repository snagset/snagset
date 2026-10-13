import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiFailure, type Me, type MintedLink, type ReviewLink, type Addresses, type SitePatch } from "./api";
import { q } from "./query";

/**
 * The writes, rule 3. Where the person is looking, the write is
 * OPTIMISTIC: the cache moves first, the server is told, and a refusal puts
 * the cache back with the reason in a toast. Creates and deletes wait, with a
 * gerund on the button.
 *
 * `revert` is what makes this honest rather than a lie that usually holds:
 * Snagset's whole pitch is that a client's words are safe, so the one thing
 * this must never do is claim a write landed when it did not.
 */
export function reason(err: unknown): string {
  return err instanceof ApiFailure ? err.message : "Could not reach the server — nothing was saved.";
}


export function useEditSite(uid: string) {
  const qc = useQueryClient();
  const meKey = q.me().queryKey;
  const originsKey = q.origins(uid).queryKey;
  return useMutation({
    mutationFn: (patch: SitePatch) => api.editSite(uid, patch),
    onMutate: async (patch) => {
      await Promise.all([qc.cancelQueries({ queryKey: meKey }), qc.cancelQueries({ queryKey: originsKey })]);
      const me = qc.getQueryData<Me>(meKey);
      const origins = qc.getQueryData<Addresses>(originsKey);
      if (me && (patch.name !== undefined || patch.writeMode !== undefined || patch.status !== undefined || patch.domain !== undefined)) {
        qc.setQueryData<Me>(meKey, {
          ...me,
          projects: me.projects.map((p) =>
            p.uid === uid
              ? {
                  ...p,
                  ...(patch.name !== undefined ? { name: patch.name } : {}),
                  ...(patch.writeMode !== undefined ? { writeMode: patch.writeMode } : {}),
                  ...(patch.status !== undefined ? { status: patch.status } : {}),
                  ...(patch.domain !== undefined ? { domain: patch.domain } : {}),
                }
              : p,
          ),
        });
      }
      if (patch.origins || patch.domain !== undefined) {
        qc.setQueryData<Addresses>(originsKey, (cur) => ({
          domain: patch.domain !== undefined ? patch.domain : (cur?.domain ?? null),
          origins: patch.origins ?? cur?.origins ?? [],
        }));
      }
      return { me, origins };
    },
    onError: (err, _patch, ctx) => {
      if (ctx?.me) qc.setQueryData(meKey, ctx.me);
      if (ctx?.origins) qc.setQueryData(originsKey, ctx.origins);
      toast.error(reason(err));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: meKey });
      void qc.invalidateQueries({ queryKey: originsKey });
    },
  });
}

/** Soft. The site goes; the client's words stay. Waits — there is no page left to revert on. */
export function useDeleteSite(uid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteSite(uid),
    onSuccess: () => qc.invalidateQueries({ queryKey: q.me().queryKey }),
    onError: (err) => toast.error(reason(err)),
  });
}

/** The ONE response with a raw token on it. Waits; the banner needs the answer. */
export function useMintLink(uid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; expiresAt?: string; roundId?: string }) => api.mintLink(uid, input),
    onSuccess: (_made: MintedLink) => qc.invalidateQueries({ queryKey: q.links(uid).queryKey }),
  });
}

export function useRevokeLink(uid: string) {
  const qc = useQueryClient();
  const key = q.links(uid).queryKey;
  return useMutation({
    mutationFn: (id: string) => api.revokeLink(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<{ data: ReviewLink[] }>(key);
      if (before) {
        qc.setQueryData(key, {
          data: before.data.map((l) => (l.id === id ? { ...l, revokedAt: new Date().toISOString() } : l)),
        });
      }
      return { before };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.before) qc.setQueryData(key, ctx.before);
      toast.error(reason(err));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useCreateSite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; origin: string }) => api.createProject(input.name, input.origin),
    onSuccess: () => qc.invalidateQueries({ queryKey: q.me().queryKey }),
  });
}
