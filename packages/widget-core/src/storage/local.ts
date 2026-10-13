import { storageKey } from "@snagset/types/names";
import { newAttachmentId } from "./ids.ts";
import type { BlobRecord } from "./blobs.ts";
import {
  AdapterError,
  threadFromRequest,
  type AdapterCapabilities,
  type AdapterContext,
  type Attachment,
  type AttachmentMeta,
  type Comment,
  type CreateCommentRequest,
  type CreateThreadRequest,
  type ProjectConfig,
  type Snag,
  type StorageAdapter,
  type Thread,
  type ThreadList,
  type ThreadPatch,
  type ThreadQuery,
} from "./types.ts";

/**
 * v0's storage: `localStorage`, one key per project+environment.
 * **No server, no signup, no network** — the whole of v0 lives here.
 *
 * Reads are defensive by design. This data outlives the code that wrote it —
 * a reviewer can return to a page weeks later, after the widget has shipped a
 * new version — so a malformed or half-written entry must degrade to "no snags"
 * rather than throw during boot and take the whole widget down with it.
 *
 * Writes are the opposite: a full disk must be LOUD. The design is explicit that
 * the adapter raises `local_quota_exceeded` and the UI offers export-and-clear,
 * because *"it never silently drops a thread"*. An earlier version swallowed
 * the error and logged, which loses a reviewer's comment quietly — the one
 * failure mode this product cannot have.
 */

const CAPABILITIES: AdapterCapabilities = {
  // v0.1: "direct" — the blob store exists and `uploadAttachment`
  // writes it. local.test.ts asserts capability and method agree — a
  // capability that lies is worse than one that says no.
  attachments: "direct",
  realtime: "none",
  anchorReports: false,
  identity: ["guest"],
  export: ["json", "md"],
  serverSideSearch: false,
  // Everything is in one localStorage origin, so "private" would mean *this
  // browser is not showing them*, not *nobody can read them*. We do
  // not offer a lock icon we cannot honour.
  privateThreads: false,
  // No membership list without a server.
  assignees: false,
};

/**
 * Does `localStorage` actually work? (F-01)
 *
 * Not `typeof localStorage`, and not a read: private-mode Safari HAS the object
 * and reads from it perfectly happily — it throws only on WRITE. So the probe
 * has to write, and has to clean up after itself, because a probe key left
 * behind is a storage key outside the registry. The key it writes is
 * derived from the registered template for that reason rather than invented.
 *
 * Until this existed, the failure was completely silent: `writeAll` swallowed
 * the throw, every comment stayed on screen for the whole session, and the
 * reviewer found out on reload — having been told nothing.
 */
export function storageWorks(): boolean {
  const probe = storageKey.threads("probe", "probe");
  try {
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch (e) {
    // A FULL disk is not a disabled one — storage works, there is simply no
    // room. Reporting F-01 here would send the reviewer to the wrong remedy:
    // "export before you leave" rather than F-the "export and clear".
    return isQuotaError(e);
  }
}

/**
 * The blob store, INJECTED rather than imported (the CaptureDeps pattern).
 *
 * `storage/blobs.ts` is ~1.3 kB of IndexedDB plumbing that nothing can reach
 * until a screenshot exists — and a screenshot requires the capture and
 * screenshot chunks to have loaded already. Importing it here put it in the
 * EAGER runtime, where a reviewer who only browses paid for it. The capture
 * chunk already bundles the same module (export/attachments.ts needs it), so
 * the runtime hands these two functions down when it has that chunk in hand.
 * Same 1.3 kB, right side of the boundary — the move, repeated.
 */
export interface BlobPort {
  put(id: string, rec: BlobRecord): Promise<void>;
  del(id: string): Promise<void>;
}

export function createLocalAdapter(uid: string, env: string, blobs?: BlobPort): StorageAdapter {
  const key = storageKey.threads(uid, env);

  function readAll(): Snag[] {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      // Private-mode Safari and storage-partitioned iframes throw on access.
      // A reviewer with storage disabled gets a working, non-persisting widget
      // — not a broken page.
      return [];
    }
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isSnag) : [];
    } catch {
      return [];
    }
  }

  function writeAll(snags: Snag[]): void {
    try {
      localStorage.setItem(key, JSON.stringify(snags));
    } catch (e) {
      // Storage disabled is survivable and silent-ish: nothing was going to
      // persist anyway, and the widget still works for this session.
      if (!isQuotaError(e)) return;
      // A full quota is NOT survivable silently — the reviewer's work is at
      // risk and only they can decide what to drop.
      throw new AdapterError("local_quota_exceeded");
    }
  }

  const touch = (s: Snag): Snag => ({ ...s, updatedAt: new Date().toISOString() });

  return {
    kind: "local",
    capabilities: CAPABILITIES,

    async init(ctx: AdapterContext): Promise<ProjectConfig> {
      // Synthetic, as the design allows: there is no server to ask. v0.1 turns
      // screenshots on — capture is local, and no server gate applies to a
      // local install (the release table). `uploads` stays false: that
      // word means the WIRE, not the blob store.
      return { uid: ctx.uid, env: ctx.env, features: { screenshots: true, uploads: false } };
    },

    async listThreads(q: ThreadQuery = {}): Promise<ThreadList> {
      let data = readAll();
      if (q.route !== undefined) data = data.filter((s) => s.route === q.route);
      if (q.status?.length) data = data.filter((s) => q.status!.includes(s.status));
      // No cursor and no tombstones: one browser writes this store, so there is
      // never a page 2 and never a delete somebody else made.
      return { data, serverTime: new Date().toISOString() };
    },

    async getThread(id: string): Promise<Thread | null> {
      return readAll().find((s) => s.id === id) ?? null;
    },

    async createThread(input: CreateThreadRequest): Promise<Thread> {
      // The first comment is created in the same transaction as the thread,
      // exactly as endpoint 6 does, so v1 is a swap and not a reorder.
      const thread = threadFromRequest(input);
      writeAll([...readAll(), thread]);
      return thread;
    },

    async patchThread(id: string, patch: ThreadPatch): Promise<Thread | null> {
      const all = readAll();
      const i = all.findIndex((s) => s.id === id);
      if (i < 0) return null;
      // No assignees here (`capabilities.assignees` is false): an id with no
      // pool behind it would be a name nobody can read back.
      const { assignee: _none, ...rest } = patch;
      const next = touch({ ...all[i]!, ...stripUndefined(rest) });
      all[i] = next;
      writeAll(all);
      return next;
    },

    async deleteThread(id: string): Promise<void> {
      const all = readAll();
      const gone = all.find((s) => s.id === id);
      const next = all.filter((s) => s.id !== id);
      if (next.length !== all.length) writeAll(next);
      // The snag's blobs go with it — best-effort: an orphaned blob is a few
      // hundred KB of slack, never a correctness problem, and a failed IDB
      // delete must not fail the thread delete that already happened.
      for (const a of gone?.attachments ?? []) void blobs?.del(a.id).catch(() => undefined);
    },

    // The blob store write. "direct" in the local sense — no wire,
    // the IndexedDB row IS the upload. Quota rejects with the same
    // client-only code web storage uses; the CALLER decides what a failed
    // attachment costs, and the answer is: never the comment.
    async uploadAttachment(blob: Blob, meta: AttachmentMeta): Promise<Attachment> {
      if (!blobs) throw new AdapterError("attachments_unsupported");
      const id = newAttachmentId();
      await blobs.put(id, {
        blob,
        uid,
        env,
        kind: meta.kind,
        ...(meta.width !== undefined ? { width: meta.width } : {}),
        ...(meta.height !== undefined ? { height: meta.height } : {}),
        createdAt: Date.now(),
      });
      return {
        id,
        kind: meta.kind,
        url: "", // the id resolves it; a data: URI exists only in exports
        ...(meta.width !== undefined ? { width: meta.width } : {}),
        ...(meta.height !== undefined ? { height: meta.height } : {}),
        bytes: blob.size,
        contentType: blob.type,
      };
    },

    async createComment(threadId: string, input: CreateCommentRequest): Promise<Comment | null> {
      const all = readAll();
      const i = all.findIndex((s) => s.id === threadId);
      if (i < 0) return null;
      const comment: Comment = {
        id: input.id,
        snagId: threadId,
        body: input.body,
        author: input.author,
        createdAt: new Date().toISOString(),
      };
      all[i] = touch({ ...all[i]!, comments: [...all[i]!.comments, comment] });
      writeAll(all);
      return comment;
    },

    async patchComment(id: string, body: string): Promise<Comment | null> {
      const all = readAll();
      for (let i = 0; i < all.length; i++) {
        const c = all[i]!.comments.find((x) => x.id === id);
        if (!c) continue;
        const next: Comment = { ...c, body };
        all[i] = touch({
          ...all[i]!,
          comments: all[i]!.comments.map((x) => (x.id === id ? next : x)),
        });
        writeAll(all);
        return next;
      }
      return null;
    },

    async deleteComment(id: string): Promise<void> {
      const all = readAll();
      const i = all.findIndex((s) => s.comments.some((c) => c.id === id));
      if (i < 0) return;
      all[i] = touch({ ...all[i]!, comments: all[i]!.comments.filter((c) => c.id !== id) });
      writeAll(all);
    },
  };
}

/** A patch must not blank a field by carrying `undefined` for it. */
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Quota is reported by name on every engine we support, but the code differs
 * (Firefox uses 1014 / NS_ERROR_DOM_QUOTA_REACHED), so name-matching is the
 * portable test and the numeric code is a fallback rather than the check.
 */
function isQuotaError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return (
    e.name === "QuotaExceededError" ||
    e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    (e as { code?: number }).code === 22 ||
    (e as { code?: number }).code === 1014
  );
}

/** Structural check on data we did not necessarily write. */
function isSnag(v: unknown): v is Snag {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<Snag>;
  return (
    typeof s.id === "string" &&
    typeof s.key === "string" &&
    typeof s.route === "string" &&
    typeof s.anchor === "object" &&
    s.anchor !== null &&
    // `label` is what an orphaned snag falls back on in annotation mode, so a
    // record without it cannot do its job (R5).
    typeof (s.anchor as { label?: unknown }).label === "string" &&
    Array.isArray(s.comments)
  );
}
