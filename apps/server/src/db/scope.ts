import type postgres from "postgres";

/**
 * The two claims a query can run under, — as functions, so a
 * route that needs one takes it in a line instead of remembering the three.
 *
 *   inOrg        the tenant's claim: every policy reduces to `org_id = this`.
 *                What every dashboard and widget query runs under once the
 *                org is known.
 *   maintenance  the exemption: legitimately cross-tenant work BEFORE the
 *                tenant is known — a sign-in by email, a session by its
 *                hash, a project by its public uid, an MCP token by its
 *                hash — and the jobs. `SET LOCAL`, so it cannot outlive the
 *                transaction, and greppable, so it can be counted.
 *
 * Both open a transaction, because the claim is transaction-scoped and a
 * pooled connection must not carry it to the next request. On a role that
 * bypasses RLS — every dev machine, the dogfood's Neon owner — these change
 * nothing observable; on the role a correctly-secured deployment uses they
 * are the difference between the rows and nothing. `rls.test.ts` runs the
 * app on such a role, which is how a query that forgot its claim is found.
 */
type Handle = postgres.Sql | postgres.TransactionSql;

/** A transaction handle has no `begin`: inside one, the claim is set on it and the work runs there. */
const inTransaction = (sql: Handle): sql is postgres.TransactionSql => typeof (sql as postgres.Sql).begin !== "function";

export async function inOrg<T>(sql: Handle, orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  if (inTransaction(sql)) {
    await sql`SELECT set_config('app.org_id', ${orgId}, true)`;
    return fn(sql);
  }
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

export async function maintenance<T>(sql: Handle, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  if (inTransaction(sql)) {
    await sql`SET LOCAL app.maintenance = 'on'`;
    return fn(sql);
  }
  return sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    return fn(tx);
  }) as Promise<T>;
}
