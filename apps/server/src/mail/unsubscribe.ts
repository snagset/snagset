import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type postgres from "postgres";
import type { Keyring } from "../keys.ts";
import { maintenance } from "../db/scope.ts";

/**
 * One-click unsubscribe — B2, and the thing that has to exist before a single
 * notification is sent to a reviewer.
 *
 * ── WHY THIS IS NOT OPTIONAL ──
 *
 * Until now the only notification went to the project OWNER, whose address was
 * verified at claim time. Reviewer addresses are self-declared, and a system
 * that mails a self-declared address on a stranger's trigger with no way out
 * is an open relay with better manners. RFC 8058 and the bulk-sender rules at
 * Gmail and Yahoo both say the same thing in different words: carry a
 * one-click opt-out or expect the spam folder.
 *
 * ── WHY IT CANNOT USE A SESSION ──
 *
 * The person clicking may have lost their review link, closed the tab, or
 * never held a session at all — and none of that is a reason to keep mailing
 * them. So the link is not authenticated by *who is asking*; it is
 * authenticated by being unforgeable. An HMAC over the reviewer's id, under
 * its own key purpose, is exactly that, and the separate purpose is
 * what stops an unsubscribe link from ever being accepted as a session or a
 * share signature.
 *
 * ── WHY GET DOES NOT UNSUBSCRIBE ──
 *
 * Mail clients and security scanners fetch every link in a message. A GET that
 * mutates would unsubscribe people who never clicked — silently, and in a way
 * they could not detect. So GET renders a confirmation and POST performs it,
 * which is also precisely what RFC 8058's `List-Unsubscribe-Post` specifies:
 * the client posts `List-Unsubscribe=One-Click`, and only a POST changes
 * anything.
 */

/** `<reviewerId>.<mac>` — the whole token, opaque to the reader. */
export function unsubscribeToken(keys: Keyring, reviewerId: string): string {
  const mac = createHmac("sha256", keys.derive("unsubscribe")).update(reviewerId).digest("base64url");
  return `${reviewerId}.${mac}`;
}

/**
 * The reviewer id this token vouches for, or null.
 *
 * No `kid` and therefore no rotation overlap, deliberately: an unsubscribe
 * link lives in somebody's mailbox for years, and the failure mode of a
 * rotated key here is "the opt-out link in a two-year-old email stops
 * working", which is the one outcome this whole file exists to prevent. The
 * token authorises exactly one irreversible-in-the-safe-direction act, so a
 * long-lived signature is the right trade.
 */
export function readUnsubscribeToken(keys: Keyring, token: string): string | null {
  const cut = token.lastIndexOf(".");
  if (cut <= 0) return null;
  const id = token.slice(0, cut);
  const given = Buffer.from(token.slice(cut + 1), "base64url");
  const want = createHmac("sha256", keys.derive("unsubscribe")).update(id).digest();
  // Length check first: timingSafeEqual THROWS on a length mismatch rather
  // than returning false, so a short token would be a 500 instead of a 404.
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return id;
}

/** The header pair a notification carries. RFC 8058. */
export function unsubscribeHeaders(baseUrl: string, token: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${baseUrl.replace(/\/+$/, "")}/unsubscribe?t=${encodeURIComponent(token)}>`,
    // Without this line the URL is treated as an ordinary link and the
    // provider renders no unsubscribe button — the header pair is the feature,
    // not either half of it.
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title>` +
  `<style>body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#16181d;background:#f7f7f5;` +
  `margin:0;display:grid;place-items:center;min-height:100vh;padding:24px}` +
  `main{background:#fff;border:1px solid #e3e3df;border-radius:6px;padding:28px 32px;max-width:34rem}` +
  `h1{font-size:20px;margin:0 0 12px}p{margin:0 0 16px;color:#5b6270}` +
  `button{font:inherit;padding:9px 16px;border-radius:6px;border:1px solid #2b53d8;background:#2b53d8;color:#fff;cursor:pointer}` +
  `@media(prefers-color-scheme:dark){body{background:#101216;color:#e9eaee}main{background:#171a20;border-color:#262a33}p{color:#a2a9b8}}` +
  `</style><main>${body}</main>`;

export interface UnsubscribeDeps {
  sql: postgres.Sql;
  keys: Keyring;
}

export function unsubscribeRoutes(deps: UnsubscribeDeps): Hono {
  const app = new Hono();
  const { sql, keys } = deps;

  /**
   * Look the reviewer up WITHOUT revealing whether the id exists.
   *
   * A valid signature already proves the id came from us, so there is nothing
   * to enumerate — but a "no such person" page would still tell a forwarded
   * recipient something about somebody else's account, and the useful answer
   * in every case is the same: you will not be mailed.
   */
  const nameFor = async (id: string): Promise<string | null> => {
    const [row] = await maintenance(sql, (tx) => tx<{ name: string }[]>`
      SELECT name FROM reviewers WHERE id = ${id}::uuid AND erased_at IS NULL`);
    return row?.name ?? null;
  };

  app.get("/unsubscribe", async (c: Context) => {
    const token = c.req.query("t") ?? "";
    const id = readUnsubscribeToken(keys, token);
    if (!id) {
      return c.html(
        page("Link not recognised", `<h1>That link is not one of ours</h1><p>It may have been altered in transit. If you are still receiving mail you did not ask for, reply to it and a person will sort it out.</p>`),
        404,
      );
    }
    const name = await nameFor(id).catch(() => null);
    return c.html(
      page(
        "Stop these emails?",
        `<h1>Stop emailing ${name ? escapeHtml(name) : "you"} about this review?</h1>` +
          `<p>You will stop receiving notifications about comments you wrote or replied to. ` +
          `Your comments stay exactly as they are, and you can still open your review link at any time.</p>` +
          `<form method="post" action="/unsubscribe"><input type="hidden" name="t" value="${escapeHtml(token)}">` +
          `<button type="submit">Stop the emails</button></form>`,
      ),
    );
  });

  app.post("/unsubscribe", async (c: Context) => {
    // The token arrives as a form field from our own confirmation page, or as
    // a query parameter from a provider's one-click POST, which sends
    // `List-Unsubscribe=One-Click` as the BODY and keeps the URL intact.
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const token = String((form as Record<string, unknown>)["t"] ?? c.req.query("t") ?? "");
    const id = readUnsubscribeToken(keys, token);
    if (!id) return c.text("not found", 404);

    // Idempotent: clicking twice, or a provider retrying, is the same outcome
    // as clicking once. `COALESCE` keeps the FIRST opt-out time, which is the
    // one a deliverability complaint asks about.
    await maintenance(sql, (tx) => tx`
      UPDATE reviewers
         SET notifications_off_at = COALESCE(notifications_off_at, now())
       WHERE id = ${id}::uuid`);

    return c.html(
      page("Unsubscribed", `<h1>Done — no more emails</h1><p>You will not be notified about this review again. Nothing else changed.</p>`),
    );
  });

  return app;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}
