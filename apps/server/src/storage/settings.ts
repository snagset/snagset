import type postgres from "postgres";
import type { Keyring } from "../keys.ts";
import { open, seal } from "../crypto.ts";
import { createBucket, type Bucket, type BucketConfig, type BucketCredentials } from "./bucket.ts";
import { maintenance } from "../db/scope.ts";

/**
 * Reading and writing the instance's bucket connection — A9b.
 *
 * INSTANCE-level (on `orgs`), not per project: one bucket serves everything,
 * and a v1 self-host has exactly one org. `features: { screenshots, uploads }`
 * is derived from `storage_connected_at` here, server-side, because A9b is
 * explicit that *"the widget never probes storage"* — it reads the flag and
 * renders accordingly, so annotation mode is a complete product rather than a
 * feature that fails when used.
 */

export interface StorageStatus {
  connected: boolean;
  config: Partial<BucketConfig>;
  connectedAt: Date | null;
  /** Where the credentials came from. Reported at boot and by the CLI,
   *  because an operator who sets an environment variable and still sees the
   *  old bucket has no way to work out why. */
  source?: "env" | "stored";
  /** Set when a connection exists but its credentials will not decrypt —
   *  almost always a changed `SNAGSET_SECRET_KEY`. */
  unreadable?: boolean;
}

/**
 * The bucket, from the environment, and the PRIMARY path.
 *
 * Draft 4 retired these six variables on the grounds that an S3 secret in a
 * `.env` reaches every backup and CI log. True, and equally true of
 * `DATABASE_URL`, which is required there — so the rule was a preference
 * applied to one of two identical secrets. What actually argued for the UI was
 * the connection PROBE, and that survives: `boot.ts` runs it against these
 * credentials too.
 *
 * A PARTIAL set is a boot failure rather than a silent fallback. An operator
 * who sets three of the four and gets annotation mode has been told nothing;
 * one who is told which variable is missing is thirty seconds from working.
 */
export function envBucketConfig(
  env: Record<string, string | undefined>,
): { config: BucketConfig; creds: BucketCredentials } | null {
  const endpoint = env["SNAGSET_STORAGE_S3_ENDPOINT"];
  const bucket = env["SNAGSET_STORAGE_S3_BUCKET"];
  const accessKeyId = env["SNAGSET_STORAGE_S3_ACCESS_KEY_ID"];
  const secretAccessKey = env["SNAGSET_STORAGE_S3_SECRET_ACCESS_KEY"];

  const present = [endpoint, bucket, accessKeyId, secretAccessKey];
  if (present.every((v) => !v)) return null;

  const missing = [
    ["SNAGSET_STORAGE_S3_ENDPOINT", endpoint],
    ["SNAGSET_STORAGE_S3_BUCKET", bucket],
    ["SNAGSET_STORAGE_S3_ACCESS_KEY_ID", accessKeyId],
    ["SNAGSET_STORAGE_S3_SECRET_ACCESS_KEY", secretAccessKey],
  ]
    .filter(([, v]) => !v)
    .map(([n]) => n);
  if (missing.length) {
    throw new Error(
      `storage is partly configured in the environment: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} missing. Set all four, or none of them ` +
        `and connect a bucket with \`snagset storage connect\`.`,
    );
  }

  const publicBaseUrl = env["SNAGSET_STORAGE_S3_PUBLIC_BASE_URL"];
  return {
    config: {
      endpoint: endpoint!,
      bucket: bucket!,
      region: env["SNAGSET_STORAGE_S3_REGION"] || "auto",
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
    },
    creds: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
  };
}

interface Row {
  id: string;
  storage_config: BucketConfig | Record<string, never>;
  storage_credentials: Buffer | null;
  storage_credentials_iv: Buffer | null;
  storage_connected_at: Date | null;
}

const orgRow = async (sql: postgres.Sql): Promise<Row | null> => {
  const rows = await maintenance(sql, (tx) => tx<Row[]>`
    SELECT id, storage_config, storage_credentials, storage_credentials_iv, storage_connected_at
    FROM orgs WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1
  `);
  return rows[0] ?? null;
};

export async function storageStatus(
  sql: postgres.Sql,
  keys: Keyring,
  env: Record<string, string | undefined> = process.env,
): Promise<StorageStatus> {
  // The environment wins: it is the more explicit statement of intent, and an
  // operator who sets a variable and still sees the old bucket cannot tell why.
  const fromEnv = envBucketConfig(env);
  if (fromEnv) {
    return { connected: true, config: fromEnv.config, connectedAt: null, source: "env" };
  }

  const org = await orgRow(sql);
  if (!org?.storage_connected_at) {
    return { connected: false, config: {}, connectedAt: null };
  }
  const readable =
    org.storage_credentials && org.storage_credentials_iv
      ? open(keys, { ciphertext: org.storage_credentials, iv: org.storage_credentials_iv }) !== null
      : false;
  return {
    // Connected AND openable. A row that says connected while its credentials
    // are unreadable would advertise `screenshots: true` and then fail every
    // upload — worse than annotation mode, which at least tells the truth.
    connected: readable,
    config: org.storage_config as BucketConfig,
    connectedAt: org.storage_connected_at,
    source: "stored",
    ...(readable ? {} : { unreadable: true }),
  };
}

/** The live client, or null in annotation mode. Environment first. */
export async function getBucket(
  sql: postgres.Sql,
  keys: Keyring,
  env: Record<string, string | undefined> = process.env,
): Promise<Bucket | null> {
  const fromEnv = envBucketConfig(env);
  if (fromEnv) return createBucket(fromEnv.config, fromEnv.creds);

  const org = await orgRow(sql);
  if (!org?.storage_connected_at || !org.storage_credentials || !org.storage_credentials_iv) return null;
  const raw = open(keys, { ciphertext: org.storage_credentials, iv: org.storage_credentials_iv });
  if (!raw) return null;
  return createBucket(org.storage_config as BucketConfig, JSON.parse(raw) as BucketCredentials);
}

export async function connectBucket(
  sql: postgres.Sql,
  keys: Keyring,
  config: BucketConfig,
  creds: BucketCredentials,
): Promise<{ ok: true } | { ok: false; step: string; detail: string }> {
  // The write-read-delete probe, BEFORE anything is stored. Credentials
  // that are merely well-formed are the ones that fail on the first
  // screenshot, in front of a reviewer, an hour later.
  const probe = await createBucket(config, creds).probe();
  if (!probe.ok) return probe;

  const org = await orgRow(sql);
  if (!org) return { ok: false, step: "instance", detail: "this instance is not claimed yet" };

  const sealed = seal(keys, JSON.stringify(creds));
  await maintenance(sql, (tx) => tx`
    UPDATE orgs
    SET storage_config = ${tx.json({ ...config })},
        storage_credentials = ${sealed.ciphertext},
        storage_credentials_iv = ${sealed.iv},
        storage_connected_at = now(),
        updated_at = now()
    WHERE id = ${org.id}
  `);
  return { ok: true };
}

/**
 * Disconnect: *"projects return to annotation mode; attachment rows
 * keep their `storage_key`s"*.
 *
 * The keys are kept deliberately. Reconnecting the same bucket restores every
 * picture; nulling them would orphan objects that are still sitting there,
 * costing money and recoverable by nobody.
 */
export async function disconnectBucket(sql: postgres.Sql): Promise<void> {
  await maintenance(sql, (tx) => tx`
    UPDATE orgs
    SET storage_connected_at = NULL, storage_credentials = NULL,
        storage_credentials_iv = NULL, updated_at = now()
    WHERE deleted_at IS NULL
  `);
}
