import type postgres from "postgres";

/**
 * Where a notification's link goes: the thread, open, in the dashboard.
 *
 * Until every mail linked `<address>/dashboard`, and the dashboard is
 * served at the ROOT of the address (`app.ts`'s fallback), so that link
 * landed on a route the SPA does not have. The comments page has always taken
 * the thread as a search parameter — every view there is a link, — and the
 * round with it, because the list shows the latest round unless told
 * otherwise, and a thread from an earlier round would open to nothing.
 *
 * One function for both mails, the per-comment one and the digest, so the two
 * cannot drift into linking different places for the same thread.
 */
export function threadUrl(baseUrl: string, site: string, key: string, round: number | null): string {
  const q = new URLSearchParams({ thread: key });
  if (round !== null) q.set("round", String(round));
  return `${baseUrl}/s/${encodeURIComponent(site)}/comments?${q.toString()}`;
}

/** The dashboard itself — what a mail links to when it is about no one thread. */
export function dashboardUrl(baseUrl: string): string {
  return `${baseUrl}/`;
}

/**
 * The link for a row that names a thread, read at SEND time: the round and
 * the site's uid are not in the event, and a row queued before the decision has
 * neither. A thread that has gone since falls back to the dashboard rather
 * than to a link that opens nothing.
 */
export async function threadLink(
  sql: postgres.Sql | postgres.TransactionSql,
  threadId: string | null,
  baseUrl: string,
): Promise<string> {
  if (!threadId) return dashboardUrl(baseUrl);
  const [t] = await sql<{ uid: string; key: string; round: number | null }[]>`
    SELECT p.uid, t.key, r.number AS round
      FROM threads t
      JOIN projects p ON p.id = t.project_id
      LEFT JOIN rounds r ON r.id = t.round_id
     WHERE t.id = ${threadId}::uuid AND t.deleted_at IS NULL`;
  return t ? threadUrl(baseUrl, t.uid, t.key, t.round) : dashboardUrl(baseUrl);
}
