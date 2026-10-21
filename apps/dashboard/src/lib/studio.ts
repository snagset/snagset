import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Invite, type Me, type Member } from "./api";
import { reason } from "./mutations";
import { q } from "./query";

/**
 * The studio's own writes — its name, its people, you (account.ts).
 * Optimistic where the person is looking (a rename, a role, a withdrawn
 * invite), waiting where a refusal is the whole feedback (a password, a new
 * invite whose link only the server can mint).
 */
export function useRenameOrg() {
  const qc = useQueryClient();
  const key = q.me().queryKey;
  return useMutation({
    mutationFn: (name: string) => api.renameOrg(name),
    onMutate: async (name) => {
      await qc.cancelQueries({ queryKey: key });
      const was = qc.getQueryData<Me>(key);
      if (was) qc.setQueryData<Me>(key, { ...was, org: { ...was.org, name } });
      return { was };
    },
    onError: (err, _n, ctx) => {
      if (ctx?.was) qc.setQueryData(key, ctx.was);
      toast.error(reason(err));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useRenameMe() {
  const qc = useQueryClient();
  const key = q.me().queryKey;
  return useMutation({
    mutationFn: (name: string) => api.renameMe(name),
    onMutate: async (name) => {
      await qc.cancelQueries({ queryKey: key });
      const was = qc.getQueryData<Me>(key);
      if (was) qc.setQueryData<Me>(key, { ...was, user: { ...was.user, name } });
      return { was };
    },
    onError: (err, _n, ctx) => {
      if (ctx?.was) qc.setQueryData(key, ctx.was);
      toast.error(reason(err));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: q.members().queryKey });
    },
  });
}

/** Not optimistic: nothing on screen changes until the server has taken it, and
 *  the reason a refusal gives — "that is not your current password" — is the
 *  whole feedback. Every other session for the account ends; this one stays. */
export function useChangePassword() {
  return useMutation({ mutationFn: (v: { current: string; next: string }) => api.changePassword(v.current, v.next) });
}

/**
 * An invite does not exist until the server says so, and its link is
 * in this response only; the caller keeps it on screen. The pending list is
 * refreshed behind it.
 */
export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { role: "owner" | "admin" | "member"; email?: string }) => api.createInvite(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: q.invites().queryKey }),
  });
}

/** Optimistic: the row goes at once, and comes back with a toast if the server refuses. */
export function useRevokeInvite() {
  const qc = useQueryClient();
  const key = q.invites().queryKey;
  return useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key });
      const was = qc.getQueryData<{ data: Invite[]; mail: boolean }>(key);
      if (was) qc.setQueryData(key, { ...was, data: was.data.filter((i) => i.id !== id) });
      return { was };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.was) qc.setQueryData(key, ctx.was);
      toast.error(reason(err));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useSendInvite() {
  return useMutation({ mutationFn: (v: { id: string; token: string }) => api.sendInvite(v.id, v.token) });
}

export function useSetMemberRole() {
  const qc = useQueryClient();
  const key = q.members().queryKey;
  return useMutation({
    mutationFn: (v: { email: string; role: "owner" | "admin" | "member" }) => api.setMemberRole(v.email, v.role),
    onMutate: async ({ email, role }) => {
      await qc.cancelQueries({ queryKey: key });
      const was = qc.getQueryData<{ data: Member[] }>(key);
      if (was) qc.setQueryData(key, { data: was.data.map((m) => (m.email === email ? { ...m, role } : m)) });
      return { was };
    },
    onSuccess: (list, { email }) => {
      qc.setQueryData(key, list);
      // Demoting yourself changes what this screen may do; /me is where the
      // shell and this page learn the new role.
      if (list.data.find((m) => m.email === email)?.you) void qc.invalidateQueries({ queryKey: q.me().queryKey });
    },
    onError: (err, _v, ctx) => {
      if (ctx?.was) qc.setQueryData(key, ctx.was);
      toast.error(reason(err));
    },
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  const key = q.members().queryKey;
  return useMutation({
    mutationFn: (email: string) => api.removeMember(email),
    onMutate: async (email) => {
      await qc.cancelQueries({ queryKey: key });
      const was = qc.getQueryData<{ data: Member[] }>(key);
      if (was) qc.setQueryData(key, { data: was.data.filter((m) => m.email !== email) });
      return { was };
    },
    onSuccess: (list) => qc.setQueryData(key, list),
    onError: (err, _e, ctx) => {
      if (ctx?.was) qc.setQueryData(key, ctx.was);
      toast.error(reason(err));
    },
  });
}
