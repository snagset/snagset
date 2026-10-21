import { Hono, type Context } from "hono";
import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import { ensureStudioReviewers } from "../studioReviewers.ts";
import { hashPassword, setSessionCookies, verifyPassword, type MemberRole, type OwnerClaims } from "./owner.ts";
import { LimitReached, planLimitReached, usage, type LimitsSource } from "../plan.ts";
import { openSession, SESSION_S } from "../orgs.ts";
import { inOrg, maintenance } from "../db/scope.ts";
import { parseRole } from "./members.ts";
import { can, invitable, withArticle } from "@snagset/types/roles";
import { isConfigured, type MailerStatus } from "../mail/index.ts";
import type { AddressSource } from "../instance/address.ts";

/**
 * Member invites, amending the "how a person gets in".
 *
 * The maintainer, 2026-10-12: *"To add a member needs an initial password — is there
 * a better way? Like Strapi has an invite link."* An owner used to choose a
 * password for somebody else and tell it to them; now an owner mints a link,
 * and whoever opens it chooses their own.
 *
 *   POST   /api/v1/members/invites            owner, or admin for a member: mint one — the link appears ONCE
 *   GET    /api/v1/members/invites            owner or admin: the pending ones
 *   DELETE /api/v1/members/invites/:id        owner, or admin for a member: withdraw one
 *   POST   /api/v1/members/invites/:id/send   owner, or admin for a member: mail it, holding the link
 *
 * An admin brings designers in. They invite MEMBERS only — making an
 * owner or an admin is giving away powers the owner kept for themselves
 * (members.ts), so it stays the owner's — and the invite they can withdraw
 * or mail is one for a member, whoever minted it. A member invites nobody.
 *   POST   /auth/invites/lookup               public: what is this link?
 *   POST   /auth/invites/accept               public: join, and be signed in
 *
 * ── THE TOKEN ──
 *
 * Review links' shape, for review links' reasons (reviewLinks.ts): 32 random
 * bytes, unpadded base64url, stored only as sha256. The create response is
 * its one appearance, so "show me that link again" is answered by revoking
 * and minting another, never by a route that can produce it.
 *
 * ── IN THE FRAGMENT: `<address>/invite#<token>` ──
 *
 * A fragment never leaves the browser: it is not in the request line, so it
 * is not in this server's access log, a proxy's, or the `Referer` the invite
 * page sends to anything it loads. That is the argument `#snag_k=` made for
 * review links, and it is stronger here — this token makes an account. The
 * dashboard reads it and presents it in a POST BODY, which is why the lookup
 * is a POST although it changes nothing: a GET would put the token right back
 * into the URL the fragment kept it out of. Both public routes are marked
 * `noBodyLogging`, as the review-link exchange is (app.ts).
 *
 * ── THE ACCEPT ──
 *
 * One transaction: consume the invite, make the person (or find them), make
 * the membership, open a session. The consume is a single conditional UPDATE
 * on "still pending", so two browsers racing one token serialise on the row
 * lock and the second matches nothing — no SELECT-then-UPDATE window. Any
 * failure after it rolls the consume back with everything else, so an invite
 * is never spent on an accept that did not happen.
 *
 * ── ONE PERSON, SEVERAL STUDIOS ──
 *
 * Made a person able to belong to more than one studio (the
 * switcher, `POST /api/v1/orgs`), and `users_email_uniq` makes an email one
 * account on the instance. So an invite to an address that already has an
 * account adds a MEMBERSHIP to that account rather than failing on the
 * unique index — but only after its existing password verifies, because the
 * link proves who the owner meant to invite, not that the holder controls
 * that account.
 */

type Env = { Variables: { owner?: OwnerClaims; requestId: string; noBodyLogging?: boolean } };
type Ctx = Context<Env>;

export interface InviteDeps {
  sql: postgres.Sql;
  limits: LimitsSource;
  /** Where the link points — the environment's address, the owner's, or this machine's. */
  address: AddressSource;
  /** The transport, read live. Absent or `none` and the mail option simply is not offered. */
  mailer: () => Promise<MailerStatus>;
  /** The server's own origin, for the login-CSRF check `/auth/login` runs — an accept signs somebody in. */
  origin: string;
  secure: boolean;
  now?: () => number;
}

/** Seven days, as the request asked. A constant rather than a variable: nobody has asked to tune it, and a setting nobody tunes is a row in for nothing. */
export const INVITE_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * The public routes' budget: twenty an hour per address, lookups and accepts
 * together — enough for a person who mistypes a password a few times and
 * reloads the page, nowhere near enough to farm scrypt verifications. In
 * process memory, as `/auth/register`'s ten-an-hour is (orgs.ts says why that
 * is a weaker limit on serverless rather than a missing one).
 */
const WINDOW_MS = 60 * 60 * 1000;
const PER_WINDOW = 20;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Bare uuids on the wire, as the agent tokens' (mcpTokens.ts): The prefixes are for ids that travel in webhooks and issue markers, and an invite never leaves the dashboard. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

function fail(c: Ctx, status: number, code: string, message: string, details?: unknown) {
  return c.json({ error: { code, message, ...(details ? { details } : {}), requestId: c.get("requestId") } }, status as 400);
}

/** The link. One function, so the dialog and the mail cannot point at different places. */
export function inviteUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/invite#${token}`;
}

interface Row {
  id: string;
  role: MemberRole;
  email: string | null;
  created_at: Date;
  expires_at: Date;
  creator_name: string | null;
  creator_email: string | null;
}

/** Never the token, never its hash. */
const shape = (r: Row) => ({
  id: r.id,
  role: r.role,
  email: r.email,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  createdBy: r.creator_email ? { name: r.creator_name ?? "", email: r.creator_email } : null,
});

/** Why a link no longer works — ordered so the most useful sentence wins: a used link that has since expired was USED. */
type Gone = "invite_used" | "invite_revoked" | "invite_expired";
function gone(r: { accepted_at: Date | null; revoked_at: Date | null; expires_at: Date }, at: Date): Gone | null {
  if (r.accepted_at) return "invite_used";
  if (r.revoked_at) return "invite_revoked";
  if (r.expires_at <= at) return "invite_expired";
  return null;
}

const SENTENCE: Record<Gone | "invite_not_found", (r?: { expires_at: Date }) => string> = {
  invite_not_found: () => "This invite link is not valid. Check that you copied all of it, or ask for a new one.",
  invite_used: () => "This invite has already been used. If that was you, sign in instead.",
  invite_revoked: () => "This invite was withdrawn. Ask whoever sent it for a new one.",
  invite_expired: (r) =>
    `This invite expired${r ? ` on ${r.expires_at.toISOString().slice(0, 10)}` : ""}. Ask whoever sent it for a new one.`,
};

/** 404 for a token nobody minted; 410 for one that existed and no longer works — the client can tell "typo" from "too late". */
function refuse(c: Ctx, why: Gone | "invite_not_found", r?: { expires_at: Date }) {
  return fail(c, why === "invite_not_found" ? 404 : 410, why, SENTENCE[why](r));
}

/** Raised inside the accept transaction; everything before it rolls back with it. */
class Refused extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function inviteRoutes(deps: InviteDeps): Hono<Env> {
  const { sql } = deps;
  const now = deps.now ?? (() => Date.now());
  const app = new Hono<Env>();
  const attempts = new Map<string, number[]>();

  /** orgs.ts's limiter, the same shape: counted before any work, so a flood costs a Map lookup. */
  const overLimit = (c: Ctx): boolean => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip")?.trim() || "local";
    const t = now();
    const recent = (attempts.get(ip) ?? []).filter((at) => t - at < WINDOW_MS);
    recent.push(t);
    attempts.set(ip, recent);
    if (attempts.size > 10_000) attempts.clear();
    return recent.length > PER_WINDOW;
  };

  /** `/auth/login`'s origin rule: an accept signs a browser in, so a cross-site page must not be able to make one. */
  const foreign = (c: Ctx): boolean => {
    const origin = c.req.header("Origin");
    const host = c.req.header("Host");
    const ours = new Set([deps.origin, host ? `http://${host}` : "", host ? `https://${host}` : ""]);
    return !!origin && !ours.has(origin);
  };

  /** Owners and admins; which invites an admin may touch is `mayTouch` below. */
  const mayInvite = (c: Ctx): OwnerClaims | Response => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    if (!can(owner.role, "invite")) return fail(c, 403, "forbidden", "Only an owner or an admin can invite people to the studio.");
    return owner;
  };
  /** An admin acts on member invites only; an owner on any. Null when allowed. */
  const mayTouch = (c: Ctx, owner: OwnerClaims, role: MemberRole): Response | null =>
    can(owner.role, "people") || (invitable(owner.role) as MemberRole[]).includes(role)
      ? null
      : fail(c, 403, "forbidden", `Only an owner can invite ${withArticle(role)}. An admin invites members.`);

  const canMail = async (): Promise<boolean> => isConfigured(await deps.mailer().catch(() => ({ kind: "none" as const, reason: "" })));

  const pending = (orgId: string) =>
    inOrg(sql, orgId, (tx) => tx<Row[]>`
      SELECT i.id, i.role, i.email, i.created_at, i.expires_at, u.name AS creator_name, u.email AS creator_email
        FROM member_invites i
        LEFT JOIN users u ON u.id = i.created_by
       WHERE i.org_id = ${orgId}
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${new Date(now())}
       ORDER BY i.created_at DESC
    `);

  // ── The studio's side ───────────────────────────────────────────────────

  app.get("/api/v1/members/invites", async (c) => {
    const owner = mayInvite(c);
    if (owner instanceof Response) return owner;
    // `mail` rides along so the dialog knows whether to offer sending before
    // it is asked — the same answer Studio › General's mail row gives.
    return c.json({ data: (await pending(owner.orgId)).map(shape), mail: await canMail() });
  });

  app.post("/api/v1/members/invites", async (c) => {
    const owner = mayInvite(c);
    if (owner instanceof Response) return owner;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const role = parseRole(body?.role);
    if (role !== "owner" && role !== "admin" && role !== "member") return fail(c, 400, "validation_failed", role);
    const refused = mayTouch(c, owner, role);
    if (refused) return refused;
    const raw = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (raw && !EMAIL.test(raw)) return fail(c, 400, "validation_failed", "That does not look like an email address.", { field: "email" });
    const email = raw || null;

    // A full studio is told now, not after the invitee has typed a password.
    // The accept counts again inside its own transaction, which is the check
    // that holds; this one only saves somebody a wasted link.
    const cap = (await deps.limits(owner.orgId)).members;
    const already = await inOrg(sql, owner.orgId, async (tx) => {
      if (cap !== null) {
        const used = (await usage(tx, owner.orgId)).members;
        if (used >= cap) throw new LimitReached("members", cap, used);
      }
      if (!email) return false;
      const [hit] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
         WHERE m.org_id = ${owner.orgId} AND u.email = ${email}
      `;
      return (hit?.n ?? 0) > 0;
    }).catch((e) => {
      if (e instanceof LimitReached) return e;
      throw e;
    });
    if (already instanceof LimitReached) return planLimitReached(c, already);
    if (already) return fail(c, 409, "already_a_member", "Somebody with that email is already in the studio.", { field: "email" });

    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const expires = new Date(now() + INVITE_TTL_DAYS * DAY_MS);
    await inOrg(sql, owner.orgId, (tx) => tx`
      INSERT INTO member_invites (id, org_id, token_hash, role, email, created_by, expires_at)
      VALUES (${id}, ${owner.orgId}, ${sha256(token)}, ${role}::snag_member_role, ${email}, ${owner.userId}, ${expires})
    `);
    return c.json(
      {
        invite: shape({ id, role, email, created_at: new Date(now()), expires_at: expires, creator_name: owner.name, creator_email: owner.email }),
        // The one and only time, as with a review link.
        token,
        url: inviteUrl(await deps.address(), token),
        mail: await canMail(),
      },
      201,
    );
  });

  app.delete("/api/v1/members/invites/:id", async (c) => {
    const owner = mayInvite(c);
    if (owner instanceof Response) return owner;
    const id = c.req.param("id");
    if (!UUID.test(id)) return fail(c, 404, "not_found", "No pending invite with that id.");
    if (!can(owner.role, "people")) {
      // An admin: the invite's role decides, read before the write so the
      // refusal can say why rather than pretending the invite is not there.
      const [inv] = await inOrg(sql, owner.orgId, (tx) => tx<{ role: MemberRole }[]>`
        SELECT role FROM member_invites WHERE id = ${id} AND org_id = ${owner.orgId}
      `);
      if (inv) {
        const refused = mayTouch(c, owner, inv.role);
        if (refused) return refused;
      }
    }
    // Org-scoped in the WHERE as well as by the claim: on a role that
    // bypasses RLS (every dev machine) the claim alone filters nothing.
    const [hit] = await inOrg(sql, owner.orgId, (tx) => tx<{ id: string }[]>`
      UPDATE member_invites SET revoked_at = now()
       WHERE id = ${id} AND org_id = ${owner.orgId} AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING id
    `);
    if (!hit) return fail(c, 404, "not_found", "No pending invite with that id.");
    return c.json({ data: (await pending(owner.orgId)).map(shape) });
  });

  /**
   * Mail the link. SENT HERE, NOT QUEUED, and it has to be: an outbox row
   * would hold the raw link in `outbox.event` until it was delivered and
   * after (done rows stay), which is the copy of the token at rest this
   * whole table was shaped to avoid. So it goes the way Studio › General's
   * test message goes — inline, to a person who is watching, with the
   * provider's own sentence when it fails — and the link in the dialog works
   * whether or not it did.
   *
   * The caller presents the token it was shown, and it must hash to this
   * row: the server cannot rebuild a link it never kept, and taking a token
   * on trust would let an owner mail a link to an invite it does not name.
   */
  app.post("/api/v1/members/invites/:id/send", async (c) => {
    const owner = mayInvite(c);
    if (owner instanceof Response) return owner;
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const token = typeof body?.token === "string" ? body.token : "";
    if (!UUID.test(id)) return fail(c, 404, "not_found", "No pending invite with that id.");
    const [row] = await inOrg(sql, owner.orgId, (tx) => tx<{ token_hash: Buffer; email: string | null; role: MemberRole; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null; org_name: string }[]>`
      SELECT i.token_hash, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, o.name AS org_name
        FROM member_invites i JOIN orgs o ON o.id = i.org_id
       WHERE i.id = ${id} AND i.org_id = ${owner.orgId}
    `);
    if (!row || gone(row, new Date(now()))) return fail(c, 404, "not_found", "No pending invite with that id.");
    const refused = mayTouch(c, owner, row.role);
    if (refused) return refused;
    const want = sha256(token);
    if (!token || !timingSafeEqual(want, row.token_hash)) {
      return fail(c, 403, "forbidden", "That is not this invite's link. Copy it from the invite you just made.");
    }
    if (!row.email) return fail(c, 400, "validation_failed", "This invite has no email address to send it to. Copy the link instead.");
    const mailer = await deps.mailer();
    if (!isConfigured(mailer)) return fail(c, 409, "integration_not_configured", "No mail transport is connected yet.");
    const url = inviteUrl(await deps.address(), token);
    const who = owner.name || owner.email;
    const studio = row.org_name || "a studio";
    try {
      await mailer.send({
        to: row.email,
        subject: `${who} invited you to ${studio}`,
        text:
          `${who} has invited you to join ${studio} as ${withArticle(row.role)}.\n\n` +
          `Open this link to choose your password and sign in:\n${url}\n\n` +
          `It works once and expires on ${row.expires_at.toISOString().slice(0, 10)}. ` +
          `If you were not expecting it, you can ignore this email.\n`,
      });
    } catch (e) {
      return fail(c, 502, "mail_send_failed", e instanceof Error ? e.message : String(e));
    }
    return c.json({ to: row.email });
  });

  // ── The invitee's side — public, rate-limited, bodies never logged ──────

  app.use("/auth/invites/*", async (c, next) => {
    c.set("noBodyLogging", true);
    await next();
  });

  /** Find a live invite by its token. The maintenance claim: the org is what this is finding out. */
  const byToken = (token: string) =>
    maintenance(sql, (tx) => tx<{ id: string; org_id: string; role: MemberRole; email: string | null; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null; org_name: string; org_slug: string; creator_name: string | null; creator_email: string | null }[]>`
      SELECT i.id, i.org_id, i.role, i.email, i.expires_at, i.accepted_at, i.revoked_at,
             o.name AS org_name, o.slug AS org_slug, u.name AS creator_name, u.email AS creator_email
        FROM member_invites i
        JOIN orgs o ON o.id = i.org_id AND o.deleted_at IS NULL
        LEFT JOIN users u ON u.id = i.created_by
       WHERE i.token_hash = ${sha256(token)}
    `).then((r) => r[0] ?? null);

  app.post("/auth/invites/lookup", async (c) => {
    if (overLimit(c)) return fail(c, 429, "quota_exceeded", "Too many attempts from this address. Try again in an hour.");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const inv = token ? await byToken(token) : null;
    if (!inv) return refuse(c, "invite_not_found");
    const why = gone(inv, new Date(now()));
    if (why) return refuse(c, why, inv);
    return c.json({
      org: { name: inv.org_name },
      role: inv.role,
      // Present only when the invite fixed it; the page then shows it rather than asking.
      email: inv.email,
      invitedBy: inv.creator_email ? inv.creator_name || inv.creator_email : null,
      expiresAt: inv.expires_at.toISOString(),
    });
  });

  app.post("/auth/invites/accept", async (c) => {
    if (foreign(c)) return fail(c, 403, "forbidden", "That request came from another site.");
    if (overLimit(c)) return fail(c, 429, "quota_exceeded", "Too many attempts from this address. Try again in an hour.");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string).trim() : "");
    const token = str("token");
    const name = str("name").slice(0, 120);
    const password = typeof body?.password === "string" ? body.password : "";

    const inv = token ? await byToken(token) : null;
    if (!inv) return refuse(c, "invite_not_found");
    const early = gone(inv, new Date(now()));
    if (early) return refuse(c, early, inv);

    const typed = str("email").toLowerCase();
    if (inv.email && typed && typed !== inv.email) {
      return fail(c, 403, "invite_email_mismatch", `This invite is for ${inv.email}. Join with that address, or ask for an invite to yours.`, { field: "email" });
    }
    const email = inv.email ?? typed;
    if (!EMAIL.test(email)) return fail(c, 400, "validation_failed", "That does not look like an email address.", { field: "email" });

    // Who this is, read before the transaction so the expensive half of the
    // work — scrypt, a tenth of a second by design — is not done holding a
    // row lock that a racing accept is waiting on.
    const [existing] = await maintenance(sql, (tx) => tx<{ id: string; name: string; password_hash: string | null; member: boolean }[]>`
      SELECT u.id, u.name, u.password_hash,
             EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.org_id = ${inv.org_id}) AS member
        FROM users u WHERE u.email = ${email} AND u.deleted_at IS NULL
    `);
    if (existing?.member) {
      return fail(c, 409, "already_a_member", `${email} is already in ${inv.org_name || "this studio"}. Sign in instead.`, { field: "email" });
    }
    let passwordHash: string | null = null;
    if (existing) {
      // An account on this instance already: the invite adds a studio to it,
      // and its own password is what proves the holder is its owner.
      if (!verifyPassword(password, existing.password_hash)) {
        return fail(
          c,
          409,
          "account_exists",
          `There is already an account for ${email} on this instance. Enter its password to join ${inv.org_name || "the studio"} with it.`,
          { field: "password" },
        );
      }
    } else {
      // Twelve, no composition rules — said as setup and sign-up say it.
      if (password.length < 12) return fail(c, 400, "validation_failed", "The password must be at least 12 characters. A short phrase of real words is fine.", { field: "password" });
      passwordHash = hashPassword(password);
    }

    const cap = (await deps.limits(inv.org_id)).members;
    let out: { userId: string; userName: string; session: { token: string; csrf: string } };
    try {
      out = await sql.begin(async (tx) => {
        // The maintenance claim for the consume (found by hash, cross-tenant
        // by nature) and for a new users row, which no membership makes
        // visible yet — the reason setup and members.ts took it too.
        await tx`SET LOCAL app.maintenance = 'on'`;
        await tx`SELECT set_config('app.org_id', ${inv.org_id}, true)`;
        // THE consume. One statement on the whole pending predicate: a racing
        // accept blocks on this row's lock, re-reads it once we commit, and
        // finds accepted_at set.
        const [won] = await tx<{ id: string }[]>`
          UPDATE member_invites SET accepted_at = now()
           WHERE id = ${inv.id} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
          RETURNING id
        `;
        if (!won) {
          const [again] = await tx<{ accepted_at: Date | null; revoked_at: Date | null; expires_at: Date }[]>`
            SELECT accepted_at, revoked_at, expires_at FROM member_invites WHERE id = ${inv.id}
          `;
          const why = again ? gone(again, new Date()) ?? "invite_used" : "invite_used";
          throw new Refused(410, why, SENTENCE[why](again));
        }
        if (cap !== null) {
          const used = (await usage(tx, inv.org_id)).members;
          if (used >= cap) throw new LimitReached("members", cap, used);
        }
        const userId = existing?.id ?? randomUUID();
        if (!existing) {
          // The invite's org is the HOME org. email_verified only when
          // the owner named the address: an open invite's address is the
          // invitee's own say-so, which is all the column has ever meant.
          await tx`
            INSERT INTO users (id, org_id, email, name, password_hash, email_verified)
            VALUES (${userId}, ${inv.org_id}, ${email}, ${name}, ${passwordHash}, ${inv.email !== null})
          `;
        }
        await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${inv.org_id}, ${userId}, ${inv.role}::snag_member_role)`;
        await tx`UPDATE member_invites SET accepted_by = ${userId} WHERE id = ${inv.id}`;
        // Assignable in every site from the moment they join. A
        // person who was in this studio before and was removed kept their
        // reviewer rows, blocked (members.ts); coming back unblocks them.
        await ensureStudioReviewers(tx, { orgId: inv.org_id, userId });
        if (existing) {
          await tx`UPDATE reviewers SET blocked_at = NULL WHERE org_id = ${inv.org_id} AND user_id = ${userId} AND blocked_at IS NOT NULL`;
        }
        // Signed in exactly as `/auth/login` signs in: a user_sessions row is
        // the authority, the raw token goes into the cookie once.
        const session = await openSession(tx, { orgId: inv.org_id, userId, userAgent: c.req.header("User-Agent") ?? "" });
        return { userId, userName: existing?.name ?? name, session };
      });
    } catch (e) {
      if (e instanceof Refused) return fail(c, e.status, e.code, e.message);
      if (e instanceof LimitReached) return planLimitReached(c, e);
      const pg = e as { code?: string; constraint_name?: string };
      if (pg?.code === "23505") {
        // Lost a race to the same address: a sign-up, another invite, or
        // this one's twin with a different token. Said as the sentence the
        // slower request would have got had it arrived a moment later.
        return pg.constraint_name === "memberships_pkey"
          ? fail(c, 409, "already_a_member", `${email} is already in ${inv.org_name || "this studio"}. Sign in instead.`, { field: "email" })
          : fail(c, 409, "account_exists", `There is already an account for ${email} on this instance. Enter its password to join with it.`, { field: "password" });
      }
      throw e;
    }
    setSessionCookies(c, out.session.token, out.session.csrf, deps.secure, SESSION_S);
    return c.json(
      {
        org: { name: inv.org_name, slug: inv.org_slug },
        user: { email, name: out.userName },
        role: inv.role,
        csrfToken: out.session.csrf,
      },
      201,
    );
  });

  return app;
}
