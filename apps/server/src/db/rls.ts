import type postgres from "postgres";

/**
 * Is row-level security actually IN FORCE for the role we connect as?
 *
 * Buys defence in depth with `org_id NOT NULL` on every table plus RLS
 * policies and `SET LOCAL app.org_id` per request. Migration 0001 writes all
 * three. On a real deployment target, all three can be present and correct and
 * the database can still hand you every tenant's rows.
 *
 * Three separate switches have to be right, and Postgres reports them
 * separately because they fail separately:
 *
 *   1. `relrowsecurity`  — the policies are enabled on the table.
 *   2. `relforcerowsecurity` — they apply to the table's OWNER too. Without
 *      this, every self-host is exempt: you connect as the role that ran the
 *      migration, and an owner is not subject to its own policies.
 *   3. `rolbypassrls` — a role attribute that overrides BOTH of the above.
 *
 * (3) is the one that bites, and it was found by running the smoke test
 * against a live Neon database rather than by reading: `neondb_owner` — the
 * role Neon puts in the connection string it gives you — carries `BYPASSRLS`.
 * Supabase's `postgres` role, the one in every string its dashboard shows,
 * carries it too; the recipe for a role without it is in docs/self-hosting.md.
 * The policies were enabled, forced, and correct; a query with `app.org_id`
 * set to org A returned org B's rows. The role also cannot drop the attribute
 * from itself ("permission denied to alter role"), so there is no fix the
 * migration can apply on the operator's behalf.
 *
 * That does not make the deployment unsafe — the design is explicit that RLS sits
 * BEHIND the application's own scoping, and the application scopes every query
 * by `org_id` itself. It makes it *less* safe than the spec claims, which is a
 * thing an operator has to be told rather than something to discover during an
 * incident. So this is reported at boot and by `/readyz`, and the wording says
 * what to do about it.
 */

export interface RlsStatus {
  /** Every switch is on: policies enabled, forced, and the role cannot bypass. */
  readonly effective: boolean;
  readonly role: string;
  readonly roleBypassesRls: boolean;
  /** Tables with policies that are not FORCEd — an owner-connection exemption. */
  readonly notForced: readonly string[];
  /** Tables carrying `org_id` with no policy at all. */
  readonly unprotected: readonly string[];
  /** One sentence for the operator, or null when everything is in force. */
  readonly warning: string | null;
}

export async function rlsStatus(sql: postgres.Sql): Promise<RlsStatus> {
  const [role] = await sql<{ name: string; bypass: boolean }[]>`
    SELECT rolname AS name, rolbypassrls AS bypass
    FROM pg_roles WHERE rolname = current_user
  `;

  // `_migrations` is ours and holds no tenant data; the pre-tenant
  // `setup_tokens` has no org_id to scope by. Everything else with an
  // org_id column is expected to be protected, which is the check the design
  // asks for stated as a query rather than as a convention.
  const tables = await sql<{ name: string; forced: boolean; policies: number }[]>`
    SELECT c.relname                                        AS name,
           c.relforcerowsecurity                            AS forced,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
      )
    ORDER BY c.relname
  `;

  const unprotected = tables.filter((t) => t.policies === 0).map((t) => t.name);
  const notForced = tables.filter((t) => t.policies > 0 && !t.forced).map((t) => t.name);
  const bypass = role?.bypass ?? false;
  const effective = !bypass && !unprotected.length && !notForced.length && tables.length > 0;

  let warning: string | null = null;
  if (bypass) {
    warning =
      `row-level security is NOT in force: the role "${role?.name}" has BYPASSRLS, ` +
      `which overrides every policy migration 0001 created. Managed Postgres often ` +
      `grants it to the role in the connection string it hands you (Supabase's ` +
      `postgres and Neon's neondb_owner both do). Requests are still scoped by org_id ` +
      `in the application, so this is a lost safety net rather than an open door — to ` +
      `get it back, create a role without BYPASSRLS, grant it the tables, and point ` +
      `DATABASE_URL at it.`;
  } else if (unprotected.length) {
    warning =
      `row-level security is incomplete: ${unprotected.length} table(s) carry org_id ` +
      `with no policy (${unprotected.slice(0, 5).join(", ")}). Re-run migrations.`;
  } else if (notForced.length) {
    warning =
      `row-level security does not apply to the table owner on ${notForced.length} ` +
      `table(s) (${notForced.slice(0, 5).join(", ")}), and a self-host connects as ` +
      `the owner. Re-run migrations.`;
  }

  return {
    effective,
    role: role?.name ?? "unknown",
    roleBypassesRls: bypass,
    notForced,
    unprotected,
    warning,
  };
}
