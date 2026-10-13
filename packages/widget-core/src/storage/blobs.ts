import { IDB } from "@snagset/types/names";
import { AdapterError } from "./types.ts";

/**
 * The v0.1 IndexedDB blob store.
 *
 * ONE database, ONE object store, registered (`snag:blobs`
 * / `blobs`): screenshots now, reviewer images now, and the v2 blob-capable
 * outbox REUSES it — "one blob store, not two" is the own sentence. Blobs are
 * stored as `Blob` objects, never base64 strings: base64-in-localStorage was
 * deleted from the spec as a quota grenade, and the data-URI form exists only
 * transiently at export time.
 *
 * Key = the client-minted attachment id (`att_…`), so an upload is retryable
 * and the v1 sync never re-keys. The `[uid, env]` index is export-and-clear's
 * enumeration path (the quota remedy).
 *
 * Note: this is a SOURCE module, bundled into whichever chunk imports it
 * (runtime via the local adapter, capture via export/import). The copies share
 * no live state — the DATABASE is the shared thing, by name, which is exactly
 * what IndexedDB is for.
 *
 * Failure vocabulary: quota → AdapterError("local_quota_exceeded") (the
 * client-only code web storage already uses); a browser with IndexedDB
 * unavailable (Firefox private mode historically; any engine behind a policy)
 * rejects on open — callers treat that the same way: the attachment is
 * dropped, the comment it decorates is NEVER lost (the rule).
 */

export interface BlobRecord {
  blob: Blob;
  uid: string;
  env: string;
  kind: "screenshot" | "image";
  width?: number;
  height?: number;
  createdAt: number;
}

/**
 * What the row actually holds: the BYTES, not the Blob. WebKit's ephemeral
 * sessions (private browsing — and every Playwright context) refuse to store
 * a Blob in IndexedDB outright ("Error preparing Blob/File data…"), so the
 * store keeps `ArrayBuffer` + mime and this module rebuilds the Blob on the
 * way out. The "Blob objects, not data URIs" contract is about never
 * holding base64 STRINGS — binary in, Blob-typed API out, both still true.
 */
interface StoredRecord {
  bytes: ArrayBuffer;
  type: string;
  uid: string;
  env: string;
  kind: "screenshot" | "image";
  width?: number;
  height?: number;
  createdAt: number;
}

/** One open per document lifetime, lazily — mount must never pay for it. */
let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(IDB.database, 1);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(IDB.store);
      store.createIndex("project", ["uid", "env"]);
    };
    req.onsuccess = () => {
      // A version change from another tab (a future migration) must not
      // deadlock it: close, and the next call reopens at the new version.
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error("indexeddb-unavailable"));
    req.onblocked = () => reject(new Error("indexeddb-blocked"));
  });
  // A failed open must not cache itself as the answer forever.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(IDB.store, mode);
        const req = run(t.objectStore(IDB.store));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error ?? req.error ?? new Error("indexeddb-error"));
        t.onabort = () => {
          const e = t.error;
          // Quota surfaces as a transaction ABORT with a QuotaExceededError —
          // mapped to the same client-only code web storage quota uses.
          if (e && (e.name === "QuotaExceededError" || /quota/i.test(e.message ?? ""))) {
            reject(new AdapterError("local_quota_exceeded"));
          } else reject(e ?? new Error("indexeddb-abort"));
        };
      }),
  );
}

export async function putBlob(id: string, record: BlobRecord): Promise<void> {
  const { blob, ...rest } = record;
  const stored: StoredRecord = { ...rest, bytes: await blob.arrayBuffer(), type: blob.type };
  await tx("readwrite", (s) => s.put(stored, id));
}

export function getBlob(id: string): Promise<BlobRecord | null> {
  return tx<StoredRecord | undefined>("readonly", (s) => s.get(id) as IDBRequest<StoredRecord | undefined>).then(
    (r) => {
      if (!r) return null;
      const { bytes, type, ...rest } = r;
      return { ...rest, blob: new Blob([bytes], { type }) };
    },
  );
}

export function deleteBlob(id: string): Promise<void> {
  return tx("readwrite", (s) => s.delete(id)).then(() => undefined);
}

/** Every key for one project — export-and-clear's enumeration. */
export function listBlobKeys(uid: string, env: string): Promise<string[]> {
  return tx<IDBValidKey[]>("readonly", (s) => s.index("project").getAllKeys(IDBKeyRange.only([uid, env]))).then(
    (keys) => keys.map(String),
  );
}

/**
 * A Blob as a `data:` URI — the EXPORT-TIME form only (the row:
 * "inlined as data URIs into export"); nothing persists this string.
 */
export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => (typeof r.result === "string" ? resolve(r.result) : reject(new Error("read-failed")));
    r.onerror = () => reject(r.error ?? new Error("read-failed"));
    r.readAsDataURL(blob);
  });
}

/** The inverse, for re-import: decode without fetch(), which a strict
 *  connect-src CSP would block for data: URLs on some engines. */
export function dataUriToBlob(uri: string): Blob {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (!m) throw new Error("not-a-data-uri");
  const type = m[1] ?? "application/octet-stream";
  if (!m[2]) return new Blob([decodeURIComponent(m[3]!)], { type });
  const bin = atob(m[3]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
