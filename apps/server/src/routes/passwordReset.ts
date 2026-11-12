import { Hono, type Context } from "hono";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type postgres from "postgres";
import { hashPassword, setSessionCookies, type OwnerClaims } from "./owner.ts";
import { openSession, SESSION_S } from "../orgs.ts";
import { maintenance } from "../db/scope.ts";
import { isConfigured, type MailerStatus } from "../mail/index.ts";
import type { AddressSource } from "../instance/address.ts";
import { firstOrgId } from "../instance/settings.ts";
import { looksLikeEmail } from "../email.ts";

/**
 * A forgotten password.
 *
 * The sign-in page told a person who had forgotten their password to run
 * `snagset passwd` on the server. That is right for whoever runs the server,
 * and no help to a member of the studio, who has no shell. Where the instance
 * can send mail, a single-use link sent to the account's own address does it.
 *
 *   POST /auth/reset/request   public: mail a reset link, if the address has an account
 *   POST /auth/reset/lookup    public: what is this link?
 *   POST /auth/reset/confirm   public: choose a new password, and be signed in
 *
 * ── ONLY WHERE THE INSTANCE CAN SEND MAIL ──
 *
 * A fresh self-host has no transport, and there `snagset passwd` stays the
 * answer: nothing here is offered, and the routes say why. Connect a
 * transport and the sign-in page changes on its next load, with no setting
 * to remember.
 *
 * ── THE TOKEN, AND WHERE IT TRAVELS ──
 *
 * An invite's shape, for an invite's reasons (invites.ts): 32 random bytes,
 * stored only as sha256, carried in the FRAGMENT of the link so it reaches no
 * access log, and presented back in a POST body. The row is the authority,
 * as it is for sessions: a link works while a row says so and not a moment
 * longer, which a signed token could not promise.
 *
 * ── SENT AFTER THE RESPONSE, NEVER QUEUED ──
 *
 * Not the outbox, for the reason an invite is not: the row would hold the
 * raw link at rest. And not before the response, because "we mailed you" and
 * "there is no such account" must look the same from outside, down to how
 * long they take. So EVERYTHING that depends on the address — whether it has
 * an account, its mailbox's budget, the link, the send — happens after the
 * 202 has been decided, on the platform's keep-alive (the hook). What a
 * request does before answering is the same for every address there is:
 * check the caller's budget, and nothing else. Where a platform has no
 * keep-alive the response waits for that work, which costs the uniform
 * timing there and never the mail.
 *
 * ── THE BUDGETS ──
 *
 * Durable, in `rate_counters` under the instance's first studio, because the
 * requests they count arrive before the caller is anybody and a serverless
 * instance's memory is not a place a limit can live:
 *
 *   ten requests an hour per caller — past it, 429.
 *   three mails an hour per mailbox, counted when a mail is about to go —
 *     past it nothing more is sent, so nobody can be buried in reset mail
 *     they did not ask for, and whoever's count is spent is holding three
 *     links that work. That is only true if a count can be spent by
 *     nothing but mail its owner receives, so two spellings are one mailbox
 *     (`mailboxOf`) ONLY where they are known to be one inbox: Gmail's
 *     `+tag` and its dots. Everywhere else an address counts as typed.
 *
 * There is no ceiling for the instance and none is needed: a reset only ever
 * goes to an account's own address, so this cannot be made to mail a
 * stranger.
 *
 * The caller is the first `X-Forwarded-For` hop, as for every limit here:
 * exact on a platform that writes the header itself, and only as good as the
 * proxy in front of a self-host. The mailbox cap does not depend on it.
 *
 * The lookup and the confirm are counted in process memory, as an invite's
 * are: a 256-bit token cannot be guessed, and what the count bounds there is
 * scrypt, not secrecy.
 */

type Env = { Variables: { owner?: OwnerClaims; requestId: string; noBodyLogging?: boolean } };
type Ctx = Context<Env>;

export interface PasswordResetDeps {
  sql: postgres.Sql;
  /** Where a link points. */
  address: AddressSource;
  /** The transport, read live. Absent or `none`, and none of this is offered. */
  mailer: () => Promise<MailerStatus>;
  /** The server's own origin, for the check `/auth/login` runs: a confirm signs somebody in. */
  origin: string;
  secure: boolean;
  /** The keep-alive. Whatever it returns is awaited before the response goes. */
  later?: (work: Promise<void>) => Promise<void> | void;
  now?: () => number;
}

/** An hour: long enough to find the mail, short enough that a mailbox read later is not a way in. */
export const RESET_TTL_MIN = 60;

const WINDOW_MS = 60 * 60 * 1000;
const CALLER_PER_WINDOW = 10;
const MAILBOX_PER_WINDOW = 3;
const ATTEMPTS_PER_WINDOW = 20;

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

function fail(c: Ctx, status: number, code: string, message: string, details?: unknown) {
  return c.json({ error: { code, message, ...(details ? { details } : {}), requestId: c.get("requestId") } }, status as 400);
}

/** The link. One function, so the mail and a test cannot point at different places. */
export function resetUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/reset#${token}`;
}

interface LinkRow {
  id: string;
  email: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
}

type Gone = "link_used" | "link_expired";
/** Ordered so the more useful sentence wins: a used link that has since expired was USED. */
function gone(r: { used_at: Date | null; expires_at: Date }, at: Date): Gone | null {
  if (r.used_at) return "link_used";
  if (r.expires_at <= at) return "link_expired";
  return null;
}

const SENTENCE: Record<Gone | "link_not_found", string> = {
  link_not_found: "This reset link is not valid. Check that you copied all of it, or ask for a new one.",
  link_used: "This reset link has already been used. Sign in with the password you chose, or ask for a new link.",
  link_expired: "This reset link has expired. They last an hour. Ask for a new one.",
};

/** Why a link cannot be used, as the status and the sentence a route answers with. */
class Refused extends Error {
  readonly status: number;
  readonly code: string;
  constructor(why: Gone | "link_not_found") {
    super(SENTENCE[why]);
    // 404 for a token nobody minted, 410 for one that existed and no longer
    // works: the page can tell "typo" from "too late", as an invite's does.
    this.status = why === "link_not_found" ? 404 : 410;
    this.code = why;
  }
}

/** A link that can still be used, or the refusal that says why not. The maintenance claim: whose it is, is what this finds out. */
async function liveLink(sql: postgres.Sql, token: string, at: Date): Promise<LinkRow> {
  const [row] = token
    ? await maintenance(sql, (tx) => tx<LinkRow[]>`
        SELECT id, email, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ${sha256(token)}
      `)
    : [];
  if (!row) throw new Refused("link_not_found");
  const why = gone(row, at);
  if (why) throw new Refused(why);
  return row;
}

/**
 * Bump one hourly counter under the instance's first studio, and say whether
 * it is past its limit. The same statement the mail and MCP budgets run.
 */
async function over(sql: postgres.Sql, anchor: string, key: string, limit: number, nowMs: number): Promise<boolean> {
  const now = new Date(nowMs);
  const windowStart = new Date(nowMs - WINDOW_MS);
  const expires = new Date(nowMs + WINDOW_MS);
  const [row] = await maintenance(sql, (tx) => tx<{ count: string }[]>`
    INSERT INTO rate_counters (org_id, bucket_key, window_start, count, expires_at)
    VALUES (${anchor}::uuid, ${key}, ${now}, 1, ${expires})
    ON CONFLICT (org_id, bucket_key) DO UPDATE
      SET count = CASE WHEN rate_counters.window_start < ${windowStart} THEN 1 ELSE rate_counters.count + 1 END,
          window_start = CASE WHEN rate_counters.window_start < ${windowStart} THEN ${now} ELSE rate_counters.window_start END,
          expires_at = CASE WHEN rate_counters.window_start < ${windowStart} THEN ${expires} ELSE rate_counters.expires_at END
    RETURNING count::text
  `);
  return !!row && Number(row.count) > limit;
}

const callerOf = (c: Ctx): string => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip")?.trim() || "local";
const bucket = (what: "from" | "to", value: string): string => `reset:${what}:${sha256(value).toString("base64url")}`;

/**
 * The inbox an address delivers to, for COUNTING only — never for identity,
 * where `a+x@` and `a@` stay two accounts.
 *
 * Folded only where two spellings are KNOWN to be one inbox, which is Gmail:
 * a tag after `+`, and dots anywhere. There one inbox with several accounts
 * would otherwise be as many mailboxes as it has spellings. A tag is a
 * provider's feature and not a rule of mail, and folding it everywhere was a
 * way to lock somebody out: where `victim+1@corp` is not delivered to
 * `victim@corp`, whoever held an account spelled that way spent the other
 * person's three an hour on mail that person never saw.
 */
export function mailboxOf(email: string): string {
  const at = email.lastIndexOf("@");
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    const plus = local.indexOf("+");
    if (plus > 0) local = local.slice(0, plus);
    local = local.replace(/\./g, "");
  }
  return `${local}@${domain}`;
}

const NO_MAIL =
  "This instance cannot send mail, so it cannot mail a reset link. Whoever runs it can set a new password on the server: snagset passwd you@example.com";
const TOO_MANY = "Too many attempts from this address. Try again in an hour.";

export function passwordResetRoutes(deps: PasswordResetDeps): Hono<Env> {
  const { sql } = deps;
  const now = deps.now ?? (() => Date.now());
  const app = new Hono<Env>();
  const attempts = new Map<string, number[]>();

  /** invites.ts's limiter, the same shape: the lookup and the confirm, in this process's memory. */
  const overAttempts = (c: Ctx): boolean => {
    const who = callerOf(c);
    const t = now();
    const recent = (attempts.get(who) ?? []).filter((at) => t - at < WINDOW_MS);
    recent.push(t);
    attempts.set(who, recent);
    if (attempts.size > 10_000) attempts.clear();
    return recent.length > ATTEMPTS_PER_WINDOW;
  };

  /** `/auth/login`'s origin rule: a cross-site page must not be able to start any of this in a visitor's name. */
  const foreign = (c: Ctx): boolean => {
    const origin = c.req.header("Origin");
    const host = c.req.header("Host");
    const ours = new Set([deps.origin, host ? `http://${host}` : "", host ? `https://${host}` : ""]);
    return !!origin && !ours.has(origin);
  };

  /**
   * Hand the address-dependent half of a request to the platform. It never
   * becomes an unhandled rejection: the caller has been told 202, and what
   * went wrong is the operator's to read.
   */
  const afterwards = async (work: () => Promise<unknown>): Promise<void> => {
    const quiet = work().then(
      () => undefined,
      (e: unknown) => console.error("password reset: the mail did not go —", e instanceof Error ? e.message : e),
    );
    const wait = deps.later ? deps.later(quiet) : undefined;
    if (wait) await wait;
  };

  // Bodies here are a token or a password. Never logged, as the invite routes' are not.
  app.use("/auth/reset/*", async (c, next) => {
    c.set("noBodyLogging", true);
    await next();
  });

  app.post("/auth/reset/request", async (c) => {
    if (foreign(c)) return fail(c, 403, "forbidden", "That request came from another site.");
    const mailer = await deps.mailer();
    if (!isConfigured(mailer)) return fail(c, 409, "integration_not_configured", NO_MAIL);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!looksLikeEmail(email)) {
      return fail(c, 400, "validation_failed", "That does not look like an email address.", { field: "email" });
    }

    // No studio means no account to reset, and nowhere to count; the answer is the same.
    const anchor = await firstOrgId(sql);
    if (!anchor) return c.json({ ok: true }, 202);
    if (await over(sql, anchor, bucket("from", callerOf(c)), CALLER_PER_WINDOW, now())) return fail(c, 429, "quota_exceeded", TOO_MANY);

    // From here on nothing is awaited that knows whose address this is: the
    // answer below is already decided, and it is the same for all of them.
    await afterwards(async () => {
      const [user] = await maintenance(sql, (tx) => tx<{ id: string; org_id: string }[]>`
        SELECT id, org_id FROM users WHERE email = ${email} AND deleted_at IS NULL
      `);
      if (!user) return;
      if (await over(sql, anchor, bucket("to", mailboxOf(email)), MAILBOX_PER_WINDOW, now())) return;
      const token = randomBytes(32).toString("base64url");
      await maintenance(sql, (tx) => tx`
        INSERT INTO password_resets (id, org_id, user_id, token_hash, email, expires_at)
        VALUES (${randomUUID()}, ${user.org_id}::uuid, ${user.id}::uuid, ${sha256(token)}, ${email}, ${new Date(now() + RESET_TTL_MIN * 60_000)})
      `);
      const base = await deps.address();
      await mailer.send({
        to: email,
        subject: "Reset your Snagset password",
        text:
          `Somebody asked to reset the password for ${email} on ${hostOf(base)}.\n\n` +
          `Open this link to choose a new one:\n${resetUrl(base, token)}\n\n` +
          `It works once and expires in an hour. ` +
          `If that was not you, ignore this email: nothing changes unless the link is used.\n`,
      });
    });
    // One answer for an account, for no account, and for a mailbox over its cap.
    return c.json({ ok: true }, 202);
  });

  app.post("/auth/reset/lookup", async (c) => {
    if (overAttempts(c)) return fail(c, 429, "quota_exceeded", TOO_MANY);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    try {
      const link = await liveLink(sql, token, new Date(now()));
      return c.json({ email: link.email, expiresAt: link.expires_at.toISOString() });
    } catch (e) {
      if (e instanceof Refused) return fail(c, e.status, e.code, e.message);
      throw e;
    }
  });

  app.post("/auth/reset/confirm", async (c) => {
    if (foreign(c)) return fail(c, 403, "forbidden", "That request came from another site.");
    if (overAttempts(c)) return fail(c, 429, "quota_exceeded", TOO_MANY);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    let link: LinkRow;
    try {
      link = await liveLink(sql, token, new Date(now()));
    } catch (e) {
      if (e instanceof Refused) return fail(c, e.status, e.code, e.message);
      throw e;
    }
    // Twelve, no composition rules — said as setup, sign-up and the account page say it.
    if (password.length < 12) {
      return fail(c, 400, "validation_failed", "The password must be at least 12 characters. A short phrase of real words is fine.", { field: "password" });
    }
    // scrypt before the transaction, as the invite accept does: a tenth of a
    // second of work is not done holding a row lock a racing confirm waits on.
    const passwordHash = hashPassword(password);

    let out: { email: string; name: string; session: { token: string; csrf: string } };
    try {
      out = await sql.begin(async (tx) => {
        await tx`SET LOCAL app.maintenance = 'on'`;
        // The PERSON's row first, held to the end, and every confirm for
        // them in that order. Two links for one account confirmed together
        // used to take their locks crosswise — each its own link, then the
        // other's — and Postgres ended one as a deadlock, a 500. Queued on
        // this row, the second finds its link already spent and says so.
        // `/auth/login` waits on the same row (owner.ts), which is what
        // stops a sign-in already in flight from outliving the reset.
        const [held] = await tx<{ id: string }[]>`SELECT id FROM users WHERE id = ${link.user_id} AND deleted_at IS NULL FOR UPDATE`;
        // Removed from the instance after the link was sent: there is nothing to reset.
        if (!held) throw new Refused("link_not_found");
        // THE consume. One statement on the whole live predicate: a link is
        // never used twice, and anything that fails below rolls it back, so
        // it is never spent on nothing.
        const [won] = await tx<{ id: string }[]>`
          UPDATE password_resets SET used_at = now()
           WHERE id = ${link.id} AND used_at IS NULL AND expires_at > now()
          RETURNING id
        `;
        if (!won) {
          const [again] = await tx<{ used_at: Date | null; expires_at: Date }[]>`SELECT used_at, expires_at FROM password_resets WHERE id = ${link.id}`;
          throw new Refused(again ? gone(again, new Date()) ?? "link_used" : "link_used");
        }
        // The mailbox is proven by the link having arrived, whatever the column said before.
        const [user] = await tx<{ id: string; org_id: string; email: string; name: string }[]>`
          UPDATE users SET password_hash = ${passwordHash}, email_verified = true, updated_at = now()
           WHERE id = ${link.user_id} AND deleted_at IS NULL
          RETURNING id, org_id, email, name
        `;
        if (!user) throw new Refused("link_not_found");
        // What `snagset passwd` does: whoever knew the old password is signed out everywhere.
        await tx`UPDATE user_sessions SET revoked_at = now() WHERE user_id = ${user.id} AND revoked_at IS NULL`;
        // Everywhere includes the widget. A member's widget session was minted
        // from a dashboard session and refreshes on its own for twelve hours;
        // this is the per-identity sign-out a removal uses (members.ts), so
        // one minted before this instant is refused at its next request.
        await tx`UPDATE reviewers SET identity_valid_after = now() WHERE user_id = ${user.id}`;
        // And every other reset link still out for this person dies with the password it would have replaced.
        await tx`UPDATE password_resets SET used_at = now() WHERE user_id = ${user.id} AND used_at IS NULL`;
        // Signed in exactly as `/auth/login` signs in, to the home studio.
        const session = await openSession(tx, { orgId: user.org_id, userId: user.id, userAgent: c.req.header("User-Agent") ?? "" });
        return { email: user.email, name: user.name, session };
      });
    } catch (e) {
      if (e instanceof Refused) return fail(c, e.status, e.code, e.message);
      throw e;
    }
    setSessionCookies(c, out.session.token, out.session.csrf, deps.secure, SESSION_S);
    return c.json({ user: { email: out.email, name: out.name }, csrfToken: out.session.csrf });
  });

  return app;
}

/** The instance's name in a mail: its host, which is what the person typed to get here. */
function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}
