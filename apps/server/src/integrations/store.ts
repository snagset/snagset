import { randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { Keyring } from "../keys.ts";
import { open, seal } from "../crypto.ts";

/**
 * A site's tracker connections — `integrations`: one row
 * project per provider, the target in `config`, the token sealed under the
 * instance key exactly as storage's and mail's are. Health lives on the row
 * (`install_state`, `last_error`) and is a column on the card, never a queue
 * somebody has to go and read.
 */

export type Provider = "github" | "linear" | "slack" | "webhook" | "jira";

export interface GitHubIntegrationConfig {
  owner: string;
  repo: string;
  labels: string[];
  createOn: "manual" | "thread.created";
}

/** A site's Linear connection — the team, resolved once, and the three state ids by type. */
export interface LinearIntegrationConfig {
  teamId: string;
  teamKey: string;
  teamName: string;
  states: { completed: string; started: string; unstarted: string };
  createOn: "manual" | "thread.created";
}

/** A site's Jira Cloud connection — the site, the project, the issue type to create with. */
export interface JiraIntegrationConfig {
  siteUrl: string;
  email: string;
  projectKey: string;
  projectId: string;
  projectName: string;
  issueTypeId: string;
  issueTypeName: string;
  createOn: "manual" | "thread.created";
}

/** A site's Slack connection — the workspace, the channel, and whether every new comment is posted. */
export interface SlackIntegrationConfig {
  teamName: string;
  teamUrl: string;
  channelId: string;
  channelName: string;
  createOn: "manual" | "thread.created";
}

/** The providers a site can be connected to today; the enum has more. */
export const TRACKERS = ["github", "linear", "jira", "slack"] as const;
export type Tracker = (typeof TRACKERS)[number];
export const isTracker = (s: string): s is Tracker => (TRACKERS as readonly string[]).includes(s);
/** What a thread's mirror is called in each tracker — `external_refs.kind`. */
export const REF_KIND: Record<Tracker, "issue" | "message"> = { github: "issue", linear: "issue", jira: "issue", slack: "message" };

export interface IntegrationRow<C = Record<string, unknown>> {
  id: string;
  orgId: string;
  projectId: string;
  provider: Provider;
  config: C;
  /** The opened secret, or null when there is none or it will not decrypt. */
  secret: string | null;
  unreadable: boolean;
  enabled: boolean;
  installState: string;
  lastError: string | null;
  updatedAt: Date;
}

interface Row {
  id: string;
  org_id: string;
  project_id: string;
  provider: Provider;
  config: unknown;
  credentials: Buffer | null;
  credentials_iv: Buffer | null;
  enabled: boolean;
  install_state: string;
  last_error: string | null;
  updated_at: Date;
}

const SELECT = (tx: postgres.TransactionSql) => tx`
  id, org_id, project_id, provider, config, credentials, credentials_iv, enabled, install_state, last_error, updated_at`;

function shapeRow<C>(keys: Keyring, r: Row): IntegrationRow<C> {
  const sealed = r.credentials && r.credentials_iv ? { ciphertext: r.credentials, iv: r.credentials_iv } : null;
  const secret = sealed ? open(keys, sealed) : null;
  return {
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id,
    provider: r.provider,
    config: r.config as C,
    secret,
    unreadable: !!sealed && secret === null,
    enabled: r.enabled,
    installState: r.install_state,
    lastError: r.last_error,
    updatedAt: r.updated_at,
  };
}

export async function getIntegration<C = Record<string, unknown>>(
  sql: postgres.Sql,
  keys: Keyring,
  orgId: string,
  projectId: string,
  provider: Provider,
): Promise<IntegrationRow<C> | null> {
  const [row] = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return tx<Row[]>`
      SELECT ${SELECT(tx as postgres.TransactionSql)} FROM integrations
      WHERE project_id = ${projectId}::uuid AND provider = ${provider}::snag_provider AND deleted_at IS NULL
    `;
  });
  return row ? shapeRow<C>(keys, row) : null;
}

/** Every live connection in the studio, for the Integrations screen. */
export async function listIntegrations(sql: postgres.Sql, keys: Keyring, orgId: string): Promise<IntegrationRow[]> {
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return tx<Row[]>`
      SELECT ${SELECT(tx as postgres.TransactionSql)} FROM integrations
      WHERE org_id = ${orgId}::uuid AND deleted_at IS NULL ORDER BY updated_at DESC
    `;
  });
  return rows.map((r) => shapeRow(keys, r));
}

export async function putIntegration(
  sql: postgres.Sql,
  keys: Keyring,
  input: { orgId: string; projectId: string; provider: Provider; config: Record<string, unknown>; secret: string | null },
): Promise<void> {
  const sealed = input.secret === null ? null : seal(keys, input.secret);
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${input.orgId}, true)`;
    // A soft-deleted row for the same pair is revived rather than duplicated:
    // `UNIQUE (project_id, provider)` counts the tombstone too.
    await tx`
      INSERT INTO integrations (id, org_id, project_id, provider, config, credentials, credentials_iv, enabled, install_state, last_error)
      VALUES (${randomUUID()}, ${input.orgId}::uuid, ${input.projectId}::uuid, ${input.provider}::snag_provider,
              ${tx.json(input.config as postgres.JSONValue)}, ${sealed?.ciphertext ?? null}, ${sealed?.iv ?? null}, true, 'ok', NULL)
      ON CONFLICT (project_id, provider) DO UPDATE
        SET config = EXCLUDED.config,
            credentials = COALESCE(EXCLUDED.credentials, integrations.credentials),
            credentials_iv = COALESCE(EXCLUDED.credentials_iv, integrations.credentials_iv),
            enabled = true, install_state = 'ok', last_error = NULL, deleted_at = NULL, updated_at = now()
    `;
  });
}

export async function removeIntegration(sql: postgres.Sql, orgId: string, projectId: string, provider: Provider): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`
      UPDATE integrations SET deleted_at = now(), enabled = false, credentials = NULL, credentials_iv = NULL, updated_at = now()
      WHERE project_id = ${projectId}::uuid AND provider = ${provider}::snag_provider AND deleted_at IS NULL
    `;
  });
}

/** Health is a column: the worker writes what it saw, the card shows it. */
export async function markIntegration(
  sql: postgres.Sql,
  orgId: string,
  id: string,
  state: "ok" | "needs_reauth" | "error",
  error: string | null,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`UPDATE integrations SET install_state = ${state}, last_error = ${error}, updated_at = now() WHERE id = ${id}::uuid`;
  });
}

/**
 * What a tracker row's sealed secret holds — the site's token (GitHub's
 * fine-grained token, Linear's API key) and the webhook secret: minted by us
 * for GitHub, pasted from Linear's own webhook form. One JSON
 * string under the one sealed column; a row from before holds the bare
 * token and reads back the same way.
 */
export interface TrackerSecrets {
  token: string | null;
  webhookSecret: string | null;
}
export type GitHubSecrets = TrackerSecrets;

export const trackerSecrets = (secret: string | null): TrackerSecrets => githubSecrets(secret);

export function githubSecrets(secret: string | null): GitHubSecrets {
  if (!secret) return { token: null, webhookSecret: null };
  if (secret.startsWith("{")) {
    try {
      const j = JSON.parse(secret) as { token?: unknown; webhookSecret?: unknown };
      return {
        token: typeof j.token === "string" && j.token ? j.token : null,
        webhookSecret: typeof j.webhookSecret === "string" && j.webhookSecret ? j.webhookSecret : null,
      };
    } catch {
      /* a token that happens to start with a brace — fall through */
    }
  }
  return { token: secret, webhookSecret: null };
}

export const mintWebhookSecret = (): string => randomBytes(24).toString("base64url");
