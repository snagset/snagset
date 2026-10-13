import type postgres from "postgres";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createProject, type CreatedProject } from "./projects.ts";

/**
 * Making a studio — the claim's transaction, factored so the three
 * doors into an org share one body: the first-run claim, `POST /auth/register`
 * (behind `SNAGSET_SIGNUP_OPEN`) and `POST /api/v1/orgs`,
 * the second studio for a person who already has one.
 *
 * Every function here runs inside the caller's transaction and takes the
 * claims it needs itself. `users` is visible through `memberships`
 * (0001's `users_org`), so a user row has to go in under the MAINTENANCE claim
 * — the membership that would make it visible does not exist yet — and the
 * org's own row under its own id. Both are `SET LOCAL`/transaction-scoped,
 * which is what makes them exemptions rather than holes.
 */

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39);
  return s.length >= 3 ? s : `org-${randomBytes(4).toString("hex")}`;
}

/** `kilnwork`, then `kilnwork-2`, `kilnwork-3`: the slug is UNIQUE across every studio on the instance. */
export async function uniqueSlug(tx: postgres.TransactionSql, name: string): Promise<string> {
  const base = slugify(name).slice(0, 34);
  const taken = new Set(
    (await tx<{ slug: string }[]>`SELECT slug FROM orgs WHERE slug = ${base} OR slug LIKE ${base + "-%"}`).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${randomBytes(3).toString("hex")}`;
}

export interface NewStudio {
  orgId: string;
  name: string;
  /** The org's plan column — `selfhost` unless the caller says otherwise. */
  plan?: string;
}

/** The org row, under its own claim. The caller has taken the maintenance claim for the slug search. */
export async function createOrg(tx: postgres.TransactionSql, input: NewStudio): Promise<{ slug: string }> {
  const slug = await uniqueSlug(tx, input.name);
  await tx`SELECT set_config('app.org_id', ${input.orgId}, true)`;
  await tx`INSERT INTO orgs (id, name, slug, plan) VALUES (${input.orgId}, ${input.name}, ${slug}, ${input.plan ?? "selfhost"})`;
  return { slug };
}

export interface NewOwner {
  orgId: string;
  userId: string;
  email: string;
  name: string;
  passwordHash: string;
}

/** A person and their first membership. The org is their HOME org. */
export async function createOwner(tx: postgres.TransactionSql, input: NewOwner): Promise<void> {
  await tx`SET LOCAL app.maintenance = 'on'`;
  await tx`SELECT set_config('app.org_id', ${input.orgId}, true)`;
  await tx`
    INSERT INTO users (id, org_id, email, name, password_hash, email_verified)
    VALUES (${input.userId}, ${input.orgId}, ${input.email}, ${input.name}, ${input.passwordHash}, true)
  `;
  await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${input.orgId}, ${input.userId}, 'owner')`;
}

/** An existing person, owner of another studio. */
export async function addOwner(tx: postgres.TransactionSql, orgId: string, userId: string): Promise<void> {
  await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
  await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
}

/** The studio's first site — a project is a row plus two environments plus a round (`projects.ts`). */
export async function createFirstProject(
  tx: postgres.TransactionSql,
  input: { orgId: string; userId: string; name: string; graceHours: number },
): Promise<CreatedProject> {
  await tx`SELECT set_config('app.org_id', ${input.orgId}, true)`;
  return createProject(tx, { orgId: input.orgId, name: input.name || "First project", createdBy: input.userId, graceHours: input.graceHours });
}

export const SESSION_S = 30 * 24 * 60 * 60;

/** A dashboard session for the org — the row is the authority; the raw token goes into the cookie once. */
export async function openSession(
  tx: postgres.TransactionSql,
  input: { orgId: string; userId: string; userAgent?: string },
): Promise<{ token: string; csrf: string }> {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  await tx`SELECT set_config('app.org_id', ${input.orgId}, true)`;
  await tx`
    INSERT INTO user_sessions (id, org_id, user_id, token_hash, user_agent, expires_at)
    VALUES (${randomUUID()}, ${input.orgId}, ${input.userId}, ${sha256(token)}, ${(input.userAgent ?? "").slice(0, 400)}, now() + ${SESSION_S}::int * interval '1 second')
  `;
  return { token, csrf };
}

/** Every studio a person belongs to, with their role in each — the switcher's list. Cross-org by nature, so the maintenance claim. */
export async function studiosOf(sql: postgres.Sql, userId: string): Promise<{ slug: string; name: string; role: string; id: string }[]> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    return tx<{ slug: string; name: string; role: string; id: string }[]>`
      SELECT o.id, o.slug, o.name, m.role::text AS role
      FROM memberships m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ${userId}::uuid AND o.deleted_at IS NULL
      ORDER BY o.created_at
    `;
  });
}
