import type postgres from "postgres";
import type { Keyring } from "../keys.ts";
import { open, seal } from "../crypto.ts";

/**
 * The instance settings store. What an operator would
 * otherwise put in the environment, connected from the dashboard instead:
 * one row per key, the non-secret half as JSON, the secret sealed with the
 * instance key the same way `orgs.storage_credentials` is.
 *
 * THE ENVIRONMENT WINS AND LOCKS, but not here: this module only stores and
 * reads. Each consumer (`mail/resolve.ts`, the instance routes) asks the
 * environment first and comes here second, because "I set the variable and
 * the dashboard still shows the old value" must be unanswerable in exactly
 * one direction.
 *
 * Every read and write runs under `app.org_id`, because the table is FORCE
 * ROW LEVEL SECURITY like every other and a self-host connects as the table
 * owner — a query without the claim sees nothing and, worse, says
 * nothing about why.
 */

export interface StoredSetting<T> {
  value: T;
  /** The secret, opened — or null when there is none. */
  secret: string | null;
  /** A secret IS stored but will not decrypt: almost always a changed SNAGSET_SECRET_KEY. */
  unreadable: boolean;
  updatedAt: Date;
  updatedBy: string | null;
}

interface Row {
  value: unknown;
  secret: Buffer | null;
  secret_iv: Buffer | null;
  updated_at: Date;
  updated_by: string | null;
}

export async function readSetting<T = Record<string, unknown>>(
  sql: postgres.Sql,
  keys: Keyring,
  orgId: string,
  key: string,
): Promise<StoredSetting<T> | null> {
  const [row] = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return tx<Row[]>`
      SELECT value, secret, secret_iv, updated_at, updated_by
      FROM instance_settings WHERE org_id = ${orgId}::uuid AND key = ${key}
    `;
  });
  if (!row) return null;
  const sealed = row.secret && row.secret_iv ? { ciphertext: row.secret, iv: row.secret_iv } : null;
  const secret = sealed ? open(keys, sealed) : null;
  return {
    value: row.value as T,
    secret,
    unreadable: !!sealed && secret === null,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export async function writeSetting(
  sql: postgres.Sql,
  keys: Keyring,
  input: { orgId: string; key: string; value: Record<string, unknown>; secret: string | null; updatedBy: string | null },
): Promise<void> {
  const sealed = input.secret === null ? null : seal(keys, input.secret);
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${input.orgId}, true)`;
    await tx`
      INSERT INTO instance_settings (org_id, key, value, secret, secret_iv, updated_by, updated_at)
      VALUES (${input.orgId}::uuid, ${input.key}, ${tx.json(input.value as postgres.JSONValue)}, ${sealed?.ciphertext ?? null},
              ${sealed?.iv ?? null}, ${input.updatedBy}, now())
      ON CONFLICT (org_id, key) DO UPDATE
        SET value = EXCLUDED.value, secret = EXCLUDED.secret, secret_iv = EXCLUDED.secret_iv,
            updated_by = EXCLUDED.updated_by, updated_at = now()
    `;
  });
}

export async function clearSetting(sql: postgres.Sql, orgId: string, key: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`DELETE FROM instance_settings WHERE org_id = ${orgId}::uuid AND key = ${key}`;
  });
}

/**
 * The one org a v1 self-host has — the storage module's own convention,
 * under the maintenance claim (0002) because the callers that need it
 * (the outbox job, boot) hold no org yet.
 */
export async function firstOrgId(sql: postgres.Sql): Promise<string | null> {
  const [row] = await sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    return tx<{ id: string }[]>`SELECT id FROM orgs WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`;
  });
  return row?.id ?? null;
}
