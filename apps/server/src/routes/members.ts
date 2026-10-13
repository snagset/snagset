import { Hono, type Context } from "hono";
import type postgres from "postgres";
import type { MemberRole, OwnerClaims } from "./owner.ts";
import { maintenance } from "../db/scope.ts";

/**
 * Members — the studio's own people. The maintainer, 2026-09-02: "should we allow for
 * different users on the backend like maybe there are several admins?"
 *
 * ── WHAT ALREADY EXISTED ──
 *
 * `memberships(org_id, user_id, role)` with owner|admin|member|viewer, since
 * migration 0001. Every writer inserted `owner`, the only readers asked "who
 * is the owner", and the session middleware never read the column — so the
 * table said four roles and the product had one. This file is the endpoints
 * that column was waiting for.
 *
 * ── WHAT IS WIRED, AND WHAT IS REFUSED ──
 *
 * `owner` and `admin`: identical powers, except that only an owner manages
 * members. `member` and `viewer` stay in the enum and are refused here with a
 * sentence, because a read-only studio seat means per-project visibility
 * rules (01 F-27) that are not designed, and a role the API accepts but the
 * product does not honour is a promise nobody can keep.
 *
 * ── HOW A PERSON GETS IN ──
 *
 * Through an invite link (invites.ts) — no longer here. Until
 * 2026-10-12 this file's POST made the account with an initial password the
 * owner chose and told the person out of band; the maintainer asked for "an invite
 * link, like Strapi", and the password path went rather than stay as a
 * second door with a weaker story (the owner knowing somebody else's
 * password). POST on this path now answers with a sentence that names the
 * new one. `snagset passwd` stays the recovery tool for a forgotten password.
 *
 * ── ADDRESSED BY EMAIL ──
 *
 * Not by a row id. Mints no `usr_` prefix and the dashboard
 * has never carried one; `users_email_uniq` makes a live email unique, and it
 * is the same handle `snagset passwd <email>` takes. Nothing can change an
 * email today, so it cannot go stale.
 */

type Env = { Variables: { owner?: OwnerClaims; requestId: string } };
type Ctx = Context<Env>;

function fail(c: Ctx, status: number, code: string, message: string) {
  return c.json({ error: { code, message, requestId: c.get("requestId") } }, status as 400);
}

/** Owner-only, said in one place. Admins can see the list; they cannot change it. */
function mustBeOwner(c: Ctx): OwnerClaims | Response {
  const owner = c.get("owner");
  if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
  if (owner.role !== "owner") {
    return fail(c, 403, "forbidden", "Only an owner can change who is in the studio.");
  }
  return owner;
}

const WIRED: readonly MemberRole[] = ["owner", "admin"];

function parseRole(v: unknown): MemberRole | string {
  if (v !== "owner" && v !== "admin") {
    return v === "member" || v === "viewer"
      ? `"${v}" is not available yet — a read-only seat needs visibility rules that are not built. Use owner or admin.`
      : "role must be owner or admin.";
  }
  return v;
}

export interface MemberRow {
  email: string;
  name: string;
  role: MemberRole;
  createdAt: string;
  /** The caller — so the UI can say "you" and refuse the self-removal it would refuse anyway. */
  you: boolean;
}

export function memberRoutes(deps: { sql: postgres.Sql }): Hono<Env> {
  const { sql } = deps;
  const app = new Hono<Env>();

  /** Org-scoped transaction, the same five lines threads.ts keeps for itself. */
  const inOrg = <T>(orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      return fn(tx as postgres.TransactionSql);
    });

  const list = async (orgId: string, me: string): Promise<MemberRow[]> => {
    const rows = await inOrg(orgId, (tx) =>
      tx<{ email: string; name: string; role: MemberRole; created_at: Date; user_id: string }[]>`
        SELECT u.email, u.name, m.role, m.created_at, u.id AS user_id
          FROM memberships m
          JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
         WHERE m.org_id = ${orgId}
         ORDER BY m.created_at, u.email
      `,
    );
    return rows.map((r) => ({
      email: r.email, name: r.name, role: r.role, createdAt: r.created_at.toISOString(), you: r.user_id === me,
    }));
  };

  app.get("/api/v1/members", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    return c.json({ data: await list(owner.orgId, owner.userId) });
  });

  /**
   * Gone, said rather than 404'd: a script written against the
   * create-with-password reads where members come from now, instead of
   * "no route", which reads as a typo.
   */
  app.post("/api/v1/members", (c) =>
    fail(c, 404, "not_found", "Members join through an invite now: POST /api/v1/members/invites, then send them the link."),
  );

  app.patch("/api/v1/members/:email", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    const email = decodeURIComponent(c.req.param("email")).trim().toLowerCase();
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const role = parseRole(body?.role);
    if (!WIRED.includes(role as MemberRole)) return fail(c, 400, "validation_failed", role);

    const result = await inOrg(owner.orgId, async (tx) => {
      const [target] = await tx<{ user_id: string; role: MemberRole }[]>`
        SELECT m.user_id, m.role FROM memberships m JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
         WHERE m.org_id = ${owner.orgId} AND u.email = ${email}
      `;
      if (!target) return "missing" as const;
      if (target.role === "owner" && role !== "owner") {
        // The last owner cannot be demoted: an org with no owner has nobody
        // who can manage members, including making a new owner.
        const [owners] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM memberships WHERE org_id = ${owner.orgId} AND role = 'owner'`;
        if ((owners?.n ?? 0) <= 1) return "last_owner" as const;
      }
      await tx`UPDATE memberships SET role = ${role as MemberRole}::snag_member_role WHERE org_id = ${owner.orgId} AND user_id = ${target.user_id}`;
      return "ok" as const;
    });
    if (result === "missing") return fail(c, 404, "not_found", "Nobody with that email is in the studio.");
    if (result === "last_owner") return fail(c, 409, "last_owner", "That is the only owner. Make somebody else an owner first.");
    return c.json({ data: await list(owner.orgId, owner.userId) });
  });

  app.delete("/api/v1/members/:email", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    const email = decodeURIComponent(c.req.param("email")).trim().toLowerCase();
    if (email === owner.email.toLowerCase()) {
      // Removing yourself is refused rather than honoured-then-logged-out:
      // the person to remove you is another owner, and the last-owner rule
      // below already covers the case where there is not one.
      return fail(c, 409, "self", "You cannot remove yourself. Ask another owner.");
    }
    const result = await inOrg(owner.orgId, async (tx) => {
      const [target] = await tx<{ user_id: string; role: MemberRole }[]>`
        SELECT m.user_id, m.role FROM memberships m JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
         WHERE m.org_id = ${owner.orgId} AND u.email = ${email}
      `;
      if (!target) return "missing" as const;
      if (target.role === "owner") {
        const [owners] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM memberships WHERE org_id = ${owner.orgId} AND role = 'owner'`;
        if ((owners?.n ?? 0) <= 1) return "last_owner" as const;
      }
      // They leave the assignee pool and keep what was already
      // assigned to them — blocked, which is the one mechanism the spec has
      // for that, and never un-assigned, which would rewrite history on
      // threads somebody is mid-conversation on.
      //
      // `identity_valid_after` too: a member can now hold a WIDGET
      // session on that row, signed in from a client's site, and this is the
      // column every widget request checks within ten seconds (reviewerCache)
      // — the refresh's membership check alone would leave them commenting
      // until their token next slid, up to fifteen minutes.
      await tx`UPDATE reviewers SET blocked_at = now(), identity_valid_after = now() WHERE org_id = ${owner.orgId} AND user_id = ${target.user_id} AND blocked_at IS NULL`;
      // Their MCP tokens go with them. Admins can mint tokens now, and a
      // token is checked against its row, not its maker — so without this an
      // admin removed from the studio kept an agent reading its comments.
      await tx`UPDATE mcp_tokens SET revoked_at = now() WHERE org_id = ${owner.orgId} AND created_by = ${target.user_id} AND revoked_at IS NULL`;
      // THIS STUDIO'S sessions, and the person only if this was their last
      // studio. Before invites could add an existing account to a
      // second studio, every user here had one membership and "remove from
      // the studio" and "delete the account" were the same act; now a person
      // in two studios removed from one keeps the other, and a soft-delete
      // here would have signed them out of a studio that never removed them.
      await tx`UPDATE user_sessions SET revoked_at = now() WHERE user_id = ${target.user_id} AND org_id = ${owner.orgId} AND revoked_at IS NULL`;
      const [other] = await maintenance(tx, (m) => m<{ org_id: string }[]>`
        SELECT org_id FROM memberships WHERE user_id = ${target.user_id} AND org_id <> ${owner.orgId}
         ORDER BY created_at LIMIT 1
      `);
      if (other) {
        // Still somebody's member: re-home them if this was the home org
        // because /auth/login opens a session in the HOME org and a
        // session in a studio with no membership row is refused on arrival —
        // they would be unable to sign in at all. Done before the membership
        // goes, while users_org can still see the row.
        await tx`UPDATE users SET org_id = ${other.org_id}, updated_at = now() WHERE id = ${target.user_id} AND org_id = ${owner.orgId}`;
        await tx`DELETE FROM memberships WHERE org_id = ${owner.orgId} AND user_id = ${target.user_id}`;
      } else {
        // Their last studio: soft on the user, hard on the membership, as
        // before. users_email_uniq is partial on deleted_at IS NULL, so the
        // same email can be invited again later; every session goes with it,
        // because the session middleware requires a membership row.
        await tx`UPDATE user_sessions SET revoked_at = now() WHERE user_id = ${target.user_id} AND revoked_at IS NULL`;
        await tx`DELETE FROM memberships WHERE org_id = ${owner.orgId} AND user_id = ${target.user_id}`;
        await tx`UPDATE users SET deleted_at = now(), updated_at = now() WHERE id = ${target.user_id}`;
      }
      return "ok" as const;
    });
    if (result === "missing") return fail(c, 404, "not_found", "Nobody with that email is in the studio.");
    if (result === "last_owner") return fail(c, 409, "last_owner", "That is the only owner. Make somebody else an owner first.");
    return c.json({ data: await list(owner.orgId, owner.userId) });
  });

  return app;
}
