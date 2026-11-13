import { ID_PREFIX } from "@snagset/types/names";

/**
 * Client-minted ids, in the v1 wire form (*"Ids are client-minted
 * exactly as in v1 (`thr_`, `cmt_`, UUIDv7 underneath), so a project that later
 * gains a backend syncs its local threads without re-keying them"*).
 *
 * The first version minted `thr_${new Date().toISOString()}_${performance.now()}`,
 * which defeats the only reason to mint client-side at all: it carries `:`, `.`
 * and `Z`, so a server strict about its id alphabet rejects every locally
 * created thread on first sync — precisely the re-keying this is meant to avoid.
 * Worse, the first comment was `cmt_${now}` with no entropy below the
 * millisecond, and comment ids are matched GLOBALLY across threads, so two
 * snags created in the same millisecond shared a comment id and editing one
 * edited the other.
 *
 * UUIDv7 rather than v4 because it is time-ordered: ids sort by creation, which
 * is what makes them usable as a database key later.
 */
export function uuidv7(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);

  // 48-bit big-endian millisecond timestamp in the first six bytes.
  const t = Date.now();
  b[0] = Math.floor(t / 2 ** 40) & 0xff;
  b[1] = Math.floor(t / 2 ** 32) & 0xff;
  b[2] = Math.floor(t / 2 ** 24) & 0xff;
  b[3] = Math.floor(t / 2 ** 16) & 0xff;
  b[4] = Math.floor(t / 2 ** 8) & 0xff;
  b[5] = t & 0xff;

  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** `thr_0191f0…` — the prefix comes from the registry, never a literal. */
export const newThreadId = (): string => ID_PREFIX.thread + uuidv7();
export const newCommentId = (): string => ID_PREFIX.comment + uuidv7();
// Client-minted like the others "so an upload is retryable" — the id
// exists before any store or wire sees the bytes, and re-sending reuses it.
export const newAttachmentId = (): string => ID_PREFIX.attachment + uuidv7();
