import { SCHEMA_VERSION, storageKey } from "@snagset/types/names";
import { blobToDataUri, dataUriToBlob, getBlob, putBlob } from "../storage/blobs.ts";
import type { Snag } from "../storage/types.ts";
import type { AttachmentUris } from "./serialize.ts";

/**
 * The async halves of the export story, kept OUT of serialize.ts so the
 * serialisers stay synchronous and pure: resolve blob-store refs into data:
 * URIs before an export, and put them back after an import.
 *
 * Ships with the CAPTURE chunk (AC G5 — an export must be producible with the
 * Preact chunk never loaded), which is also where buildExport already lives.
 */

/**
 * Attachment id → data: URI for every ref the given snags carry.
 *
 * The empty-case guard is a REQUIREMENT, not an optimisation: with
 * `data-snag-host` set the HTTP adapter never writes attachments, no snag
 * carries a ref, and the blob store must be BYPASSED — plan asserts
 * that on the IndexedDB call count, so this function must not even open the
 * database when there is nothing to resolve.
 */
export async function resolveAttachmentUris(snags: Snag[]): Promise<Map<string, string>> {
  // LOCAL refs only. A server-held picture (an absolute `url`, which threads
  // read back from an instance now carry — see http.ts's `toSnag`) is not in
  // this browser's store, and looking for it would open IndexedDB on the
  // client's origin in exactly the mode the guard below exists to keep out of
  // it. Its export keeps the instance URL rather than a data: URI.
  const wanted = snags.flatMap((s) => s.attachments ?? []).filter((a) => !/^https?:/i.test(a.url ?? ""));
  const map = new Map<string, string>();
  if (wanted.length === 0) return map;
  // All blobs in parallel — the 20-thread DoD bound (< 3 s) is IO-bound and
  // sequential reads are what would blow it.
  await Promise.all(
    wanted.map(async (a) => {
      // A missing or unreadable blob drops THIS attachment from the export,
      // never the export: the record's text is the part that cannot be redone.
      const rec = await getBlob(a.id).catch(() => null);
      if (rec) map.set(a.id, await blobToDataUri(rec.blob));
    }),
  );
  return map;
}

export interface ImportResult {
  threads: number;
  blobs: number;
}

/**
 * The inverse path — plan the re-import DoD ("the archive re-imports into
 * a fresh browser profile with every image intact"; v1's parity criterion is
 * P11). Parses an exported JSON archive, writes the threads snapshot, and
 * puts every inlined image back into the blob store as a Blob — the stored
 * records carry `url: ""` again, because a data: URI in localStorage is the
 * exact quota grenade 05 deleted.
 *
 * REPLACES the project's threads rather than merging: the fresh-profile round
 * trip is the contract; a merge policy is a product decision no spec has made.
 */
export async function importArchive(json: string, uid: string, env: string): Promise<ImportResult> {
  const parsed = JSON.parse(json) as { schemaVersion?: unknown; threads?: unknown };
  if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.threads)) {
    throw new Error(`not a ${SCHEMA_VERSION} archive`);
  }
  const threads: Snag[] = [];
  let blobs = 0;
  for (const t of parsed.threads as Snag[]) {
    if (!t.attachments?.length) {
      threads.push(t);
      continue;
    }
    const atts = [];
    for (const a of t.attachments) {
      if (a.url.startsWith("data:")) {
        const blob = dataUriToBlob(a.url);
        await putBlob(a.id, {
          blob,
          uid,
          env,
          kind: a.kind,
          ...(a.width !== undefined ? { width: a.width } : {}),
          ...(a.height !== undefined ? { height: a.height } : {}),
          createdAt: Date.now(),
        });
        blobs++;
        atts.push({ ...a, url: "" });
      } else {
        atts.push(a);
      }
    }
    threads.push({ ...t, attachments: atts });
  }
  localStorage.setItem(storageKey.threads(uid, env), JSON.stringify(threads));
  return { threads: threads.length, blobs };
}
