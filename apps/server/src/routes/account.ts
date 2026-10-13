import { Hono, type Context } from "hono";
import type postgres from "postgres";
import { hashPassword, verifyPassword, type OwnerClaims } from "./owner.ts";
import { inOrg } from "../db/scope.ts";

/**
 * The studio's own settings, and yours — the three things the Studio
 * settings page can change. Until this file, the dashboard could rename a
 * site but not the studio, and a person handed an initial password by an
 * owner (members.ts) had no way to change it short of a shell on the server
 * and `snagset passwd`. That was the gap the maintainer's flow question found:
 * "add an admin → tell them the password → they sign in → …then what?"
 *
 *   PATCH /api/v1/org            { name }              owners only
 *   PATCH /api/v1/me             { name }              anyone signed in
 *   POST  /api/v1/me/password    { current, next }     anyone signed in
 *
 * A password change revokes every OTHER session for the account and keeps
 * this one — the same rule `passwd` applies, minus the sign-out of the very
 * session that asked, which would read as "changing my password logged me
 * out". The current password is required so a walked-away-from laptop
 * cannot be turned into a takeover by the next person at the keyboard.
 */

type Env = { Variables: { owner?: OwnerClaims; requestId: string } };
type Ctx = Context<Env>;
function fail(c: Ctx, status: number, code: string, message: string) {
  return c.json({ error: { code, message, requestId: c.get("requestId") } }, status as 400);
}
const MIN = 12; // Length is the rule, no composition theatre

export function accountRoutes(deps: { sql: postgres.Sql }): Hono<Env> {
  const { sql } = deps;
  const app = new Hono<Env>();

  app.patch("/api/v1/org", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    if (owner.role !== "owner") return fail(c, 403, "forbidden", "Only an owner can rename the studio.");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return fail(c, 400, "validation_failed", "The studio needs a name.");
    if (name.length > 120) return fail(c, 400, "validation_failed", "That name is too long — 120 characters at most.");
    // The slug stays. It is the studio's stable handle in URLs and mail; a
    // rename is a label changing, not an identity.
    await inOrg(sql, owner.orgId, (tx) => tx`UPDATE orgs SET name = ${name} WHERE id = ${owner.orgId}`);
    return c.json({ org: { name } });
  });

  app.patch("/api/v1/me", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
    await inOrg(sql, owner.orgId, (tx) => tx`UPDATE users SET name = ${name}, updated_at = now() WHERE id = ${owner.userId}`);
    return c.json({ user: { email: owner.email, name, role: owner.role } });
  });

  app.post("/api/v1/me/password", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const current = typeof body?.current === "string" ? body.current : "";
    const next = typeof body?.next === "string" ? body.next : "";
    if (next.length < MIN) {
      return fail(c, 400, "validation_failed", `The new password needs at least ${MIN} characters. A short phrase of real words is fine.`);
    }
    const [row] = await inOrg(sql, owner.orgId, (tx) => tx<{ password_hash: string | null }[]>`SELECT password_hash FROM users WHERE id = ${owner.userId}`);
    if (!verifyPassword(current, row?.password_hash ?? null)) {
      // Said plainly. There is no enumeration risk on your own account.
      return fail(c, 400, "wrong_password", "That is not your current password.");
    }
    await inOrg(sql, owner.orgId, async (tx) => {
      await tx`UPDATE users SET password_hash = ${hashPassword(next)}, updated_at = now() WHERE id = ${owner.userId}`;
      await tx`UPDATE user_sessions SET revoked_at = now() WHERE user_id = ${owner.userId} AND id <> ${owner.sessionId} AND revoked_at IS NULL`;
    });
    return c.json({ ok: true });
  });

  return app;
}
