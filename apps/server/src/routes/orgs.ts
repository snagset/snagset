import { Hono, type Context } from "hono";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { THREAD_REF_PREFIX } from "@snagset/types/names";
import { csrfOk, hashPassword, setSessionCookies, type OwnerClaims } from "./owner.ts";
import { addOwner, createFirstProject, createOrg, createOwner, openSession, SESSION_S, studiosOf } from "../orgs.ts";

/**
 * The second and third doors into a studio.
 *
 *   POST /auth/register   a stranger makes a studio and is its owner, signed in
 *   POST /auth/switch     a person in two studios moves their session to the other
 *   POST /api/v1/orgs     a signed-in person makes another studio, and is moved to it
 *
 * The first two doors are `SNAGSET_SIGNUP_OPEN`'s: `false`, which
 * is every self-host, answers `403 registration_closed` — the claim
 * stays the one way in, and members are added by an owner. `true` is
 * the cloud, or a self-host that wants to be one for its own people. The
 * rule holds: this ADDS a surface where the operator asked for it and
 * withholds nothing anywhere else. The switcher needs no flag: a membership
 * in two studios is a fact an owner created.
 *
 * A sign-up is rate-limited per address, in this process's memory — ten an
 * hour. On the serverless entry that memory is per instance and short-lived,
 * which is a weaker limit, not a missing one; the durable counter follows
 * with the cloud's abuse work (item 5).
 */

type Env = { Variables: { requestId: string; owner?: OwnerClaims } };
type Ctx = Context<Env>;

export interface OrgDeps {
  sql: postgres.Sql;
  /** The server's own origin, for the same login-CSRF check `/auth/login` runs. */
  origin: string;
  secure: boolean;
  signupOpen: () => boolean;
  graceHours: number;
  /** The first studio on an unclaimed instance IS its claim: boot's state moves on. */
  onFirstOrg?: () => void;
  now?: () => number;
}

const WINDOW_MS = 60 * 60 * 1000;
const PER_WINDOW = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(c: Ctx, status: number, code: string, message: string, details?: unknown) {
  return c.json({ error: { code, message, ...(details ? { details } : {}), requestId: c.get("requestId") } }, status as 400);
}

const CLOSED = "This instance does not take sign-ups. Ask its owner to add you, or run your own — npx snagset.";

export function orgRoutes(deps: OrgDeps): Hono<Env> {
  const { sql } = deps;
  const now = deps.now ?? (() => Date.now());
  const app = new Hono<Env>();
  const attempts = new Map<string, number[]>();

  /** True when this address has used its ten. Counted before any work, so a flood of bad bodies costs a Map lookup. */
  const overLimit = (c: Ctx): boolean => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip")?.trim() || "local";
    const t = now();
    const recent = (attempts.get(ip) ?? []).filter((at) => t - at < WINDOW_MS);
    recent.push(t);
    attempts.set(ip, recent);
    if (attempts.size > 10_000) attempts.clear();
    return recent.length > PER_WINDOW;
  };

  const foreign = (c: Ctx): boolean => {
    const origin = c.req.header("Origin");
    const host = c.req.header("Host");
    const ours = new Set([deps.origin, host ? `http://${host}` : "", host ? `https://${host}` : ""]);
    return !!origin && !ours.has(origin);
  };

  const project = (p: { uid: string; name: string }) => ({ uid: p.uid, name: p.name, keyPrefix: THREAD_REF_PREFIX.replace("-", "") });

  app.post("/auth/register", async (c) => {
    if (!deps.signupOpen()) return fail(c, 403, "registration_closed", CLOSED);
    if (foreign(c)) return fail(c, 403, "forbidden", "That sign-up request came from another site.");
    if (overLimit(c)) return fail(c, 429, "quota_exceeded", "Too many sign-ups from this address. Try again in an hour.");

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string).trim() : "");
    const email = str("email").toLowerCase();
    const password = typeof body?.["password"] === "string" ? (body["password"] as string) : "";
    const name = str("name").slice(0, 120);
    const orgName = (str("orgName") || "My studio").slice(0, 120);
    if (!EMAIL.test(email)) return fail(c, 400, "validation_failed", "That does not look like an email address.", { field: "email" });
    if (password.length < 12) return fail(c, 400, "validation_failed", "The password must be at least 12 characters.", { field: "password" });

    const taken = await sql.begin(async (tx) => {
      await tx`SET LOCAL app.maintenance = 'on'`;
      return tx<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE email = ${email} AND deleted_at IS NULL`;
    });
    if ((taken[0]?.n ?? 0) > 0) return fail(c, 409, "email_taken", "An account with that email already exists. Sign in instead.", { field: "email" });

    const orgId = randomUUID();
    const userId = randomUUID();
    const passwordHash = hashPassword(password);
    let out: { slug: string; first: boolean; project: { uid: string; name: string }; session: { token: string; csrf: string } };
    try {
      out = await sql.begin(async (tx) => {
        await tx`SET LOCAL app.maintenance = 'on'`;
        const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM orgs`;
        const { slug } = await createOrg(tx, { orgId, name: orgName });
        await createOwner(tx, { orgId, userId, email, name, passwordHash });
        const made = await createFirstProject(tx, { orgId, userId, name: "", graceHours: deps.graceHours });
        const session = await openSession(tx, { orgId, userId, userAgent: c.req.header("User-Agent") ?? "" });
        return { slug, first: (count?.n ?? 0) === 0, project: made, session };
      });
    } catch (e) {
      // users_email_uniq — two sign-ups for one address in the same second.
      if ((e as { code?: string })?.code === "23505") return fail(c, 409, "email_taken", "An account with that email already exists. Sign in instead.", { field: "email" });
      throw e;
    }
    if (out.first) deps.onFirstOrg?.();
    setSessionCookies(c, out.session.token, out.session.csrf, deps.secure, SESSION_S);
    return c.json({ org: { name: orgName, slug: out.slug }, user: { email, name }, project: project(out.project), csrfToken: out.session.csrf }, 201);
  });

  app.post("/auth/switch", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    if (!csrfOk(c)) return fail(c, 403, "csrf_failed", "That request could not be verified. Reload the dashboard and try again.");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const slug = typeof body?.["slug"] === "string" ? (body["slug"] as string).trim() : "";
    const target = (await studiosOf(sql, owner.userId)).find((s) => s.slug === slug);
    if (!target) return fail(c, 404, "not_a_member", "You are not a member of a studio with that address.");
    const session = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${owner.orgId}, true)`;
      await tx`UPDATE user_sessions SET revoked_at = now() WHERE id = ${owner.sessionId}`;
      return openSession(tx, { orgId: target.id, userId: owner.userId, userAgent: c.req.header("User-Agent") ?? "" });
    });
    setSessionCookies(c, session.token, session.csrf, deps.secure, SESSION_S);
    return c.json({ org: { name: target.name, slug: target.slug }, role: target.role, csrfToken: session.csrf });
  });

  app.post("/api/v1/orgs", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    if (!deps.signupOpen()) return fail(c, 403, "registration_closed", "This instance does not take new studios. Ask its operator to open sign-up, or run your own — npx snagset.");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = (typeof body?.["name"] === "string" ? (body["name"] as string).trim() : "").slice(0, 120) || "My studio";
    const orgId = randomUUID();
    const out = await sql.begin(async (tx) => {
      await tx`SET LOCAL app.maintenance = 'on'`;
      const { slug } = await createOrg(tx, { orgId, name });
      await addOwner(tx, orgId, owner.userId);
      const made = await createFirstProject(tx, { orgId, userId: owner.userId, name: "", graceHours: deps.graceHours });
      await tx`SELECT set_config('app.org_id', ${owner.orgId}, true)`;
      await tx`UPDATE user_sessions SET revoked_at = now() WHERE id = ${owner.sessionId}`;
      const session = await openSession(tx, { orgId, userId: owner.userId, userAgent: c.req.header("User-Agent") ?? "" });
      return { slug, project: made, session };
    });
    setSessionCookies(c, out.session.token, out.session.csrf, deps.secure, SESSION_S);
    return c.json({ org: { name, slug: out.slug }, project: project(out.project), csrfToken: out.session.csrf }, 201);
  });

  return app;
}
