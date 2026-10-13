/**
 * Where a screenshot's bytes come from when the dock wants to paint one
 *
 * Two homes, decided by the attachment ref itself rather than by asking which
 * adapter is mounted:
 *
 *  · A server-held picture carries an absolute `url` — the instance's
 *    `GET /api/v1/attachments/:id/blob`, a capability URL served with
 *    `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy:
 *    cross-origin` precisely so a page on any origin can read it. Fetched
 *    with credentials OMITTED: the id is the authority, and a cookie for the
 *    API host has no business riding along from a client's site.
 *  · A local one carries `url: ""` (stored as a Blob, inlined only
 *    at export) and lives in this browser's IndexedDB blob store.
 *
 * The dock used to read ONLY the local store, so on a server-backed instance
 * every thumbnail silently rendered nothing: the blob was uploaded, never
 * written locally, and the lookup returned null on every browser — the
 * capturing one included. The dashboard showed the same picture, because it
 * reads the server route.
 *
 * A remote miss does NOT fall back to the local store. In server mode that
 * store is never written, and opening it would create an IndexedDB database
 * on the client's origin for nothing — the rule that a server-backed
 * flow performs zero IndexedDB calls.
 *
 * Returns a Blob, never a URL: the caller draws it into a canvas via
 * createImageBitmap, which a host's `img-src` CSP cannot block. The
 * fetch is `connect-src`, which the widget already needs for the API host.
 */
export async function loadShotBlob(
  att: { id: string; url?: string },
  local: (id: string) => Promise<Blob | null>,
): Promise<Blob | null> {
  if (att.url && /^https?:/i.test(att.url)) {
    try {
      const res = await fetch(att.url, { credentials: "omit" });
      if (!res.ok) return null;
      const blob = await res.blob();
      // A JSON error body that slipped past `ok` (a proxy's 200 HTML page)
      // must not reach createImageBitmap, which rejects with an opaque error.
      return blob.type && !blob.type.startsWith("image/") ? null : blob;
    } catch {
      return null; // the picture is lost, never the thread (the rule)
    }
  }
  return local(att.id);
}
