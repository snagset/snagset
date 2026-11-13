import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sanitise } from "@snagset/adapters";
import { briefMarkdown, type BriefFenceKind, type BriefThread } from "@snagset/types/brief";
import { ID_PREFIX, param } from "@snagset/types/names";
import type { Keyring } from "../keys.ts";
import type { Job, JobContext, JobOutcome } from "../jobs/index.ts";
import { noteQueued } from "../jobs/soon.ts";
import { githubClient, GitHubError, issueTitle } from "./github.ts";
import { linearClient, LinearError, linearStateFor } from "./linear.ts";
import { escapeForJiraWiki, jiraCategoryFor, jiraClient, JiraError } from "./jira.ts";
import { slackClient, SlackError, slackMessage, slackPermalink } from "./slack.ts";
import type { AddressSource } from "../instance/address.ts";
import {
  getIntegration,
  markIntegration,
  trackerSecrets,
  type GitHubIntegrationConfig,
  type IntegrationRow,
  type JiraIntegrationConfig,
  type LinearIntegrationConfig,
  type SlackIntegrationConfig,
  type Tracker,
  REF_KIND,
} from "./store.ts";

/**
 * The tracker side of the outbox.
 *
 * Rows are queued IN THE SAME TRANSACTION as the change they mirror (the
 * status PATCH, the thread create with auto-create on, the dashboard's
 * "Create issue"), keyed `topic:thread:version` per provider so a retried
 * request or a restarted worker can never make a second issue. One worker
 * drains them a row at a time with the mail worker's backoff, dispatching
 * by provider, and writes what it saw onto the integration row — health is
 * a column on the card.
 *
 * Two topics. `issue.create`: the thread becomes an issue whose body is the
 * brief with every reviewer-typed string put through the outbound
 * sanitiser for THAT target. `issue.state`: our
 * status, mapped by STATE TYPE — GitHub closed/open, Linear's workflow
 * state types — never by a name somebody can rename.
 */

export type IntegrationTopic = "issue.create" | "issue.state";

export interface QueueInput {
  orgId: string;
  projectId: string;
  integrationId: string;
  threadId: string;
  provider?: Tracker;
  topic: IntegrationTopic;
  /** `threads.version` — part of the dedupe key, so each change is one row. */
  version: number;
  event?: Record<string, unknown>;
}

/** Queue one row; a duplicate key is a no-op (the request was retried). */
export async function queueIntegrationEvent(tx: postgres.TransactionSql, q: QueueInput): Promise<void> {
  const provider = q.provider ?? "github";
  await tx`
    INSERT INTO outbox (id, org_id, project_id, integration_id, thread_id, provider, topic, dedupe_key, event)
    VALUES (${randomUUID()}, ${q.orgId}::uuid, ${q.projectId}::uuid, ${q.integrationId}::uuid, ${q.threadId}::uuid,
            ${provider}::snag_provider, ${q.topic}, ${`${q.topic}:${ID_PREFIX.thread}${q.threadId}:${q.version}`},
            ${tx.json((q.event ?? {}) as postgres.JSONValue)})
    ON CONFLICT (provider, dedupe_key) DO NOTHING
  `;
  // The request drains this once its response is ready.
  noteQueued();
}

const BACKOFF_MIN = [1, 5, 15, 30, 60];

interface OutboxRow {
  id: string;
  org_id: string;
  project_id: string;
  integration_id: string | null;
  thread_id: string | null;
  provider: Tracker;
  topic: string;
  attempts: number;
  event: Record<string, unknown>;
}

export interface PushDeps {
  keys: Keyring;
  /** Where the instance lives — the brief's "Open in Snagset" link. */
  /** Read live — the environment's, the owner's, or this machine's. */
  baseUrl: AddressSource;
  /** api.github.com unless a test or an Enterprise Server says otherwise. */
  githubApiBase?: string;
  /** api.linear.app/graphql unless a test says otherwise. */
  linearApiBase?: string;
  /** slack.com/api unless a test says otherwise. */
  slackApiBase?: string;
  fetch?: typeof globalThis.fetch;
}

/** The thread as the brief wants it, under the org's claim. */
async function loadThread(sql: postgres.Sql, orgId: string, threadId: string) {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    const [t] = await tx<Record<string, any>[]>`
      SELECT t.id, t.key, t.status, t.version, t.anchor, t.anchor_state, t.context, t.route, t.created_at,
             p.uid AS project_uid, p.name AS project_name, e.key AS environment_key,
             r.name AS created_by_name,
             ar.name AS assignee_name,
             COALESCE(
               (SELECT json_agg(json_build_object('body', c.body, 'createdAt', c.created_at,
                                                  'author', json_build_object('name', cr.name, 'kind', cr.kind))
                        ORDER BY c.seq)
                  FROM comments c JOIN reviewers cr ON cr.id = c.author_id
                 WHERE c.thread_id = t.id AND c.deleted_at IS NULL AND c.private = false),
               '[]'::json) AS comments
        FROM threads t
        JOIN projects p ON p.id = t.project_id
        JOIN reviewers r ON r.id = t.created_by
        JOIN environments e ON e.id = t.environment_id
        LEFT JOIN reviewers ar ON ar.id = t.assignee_id
       WHERE t.id = ${threadId}::uuid AND t.deleted_at IS NULL
    `;
    return t ?? null;
  });
}

type BodyTarget = "github" | "linear" | "jira";

/** Every reviewer-typed string goes through the outbound sanitiser for the target before the brief sees it. */
const fenceFor =
  (target: BodyTarget) =>
  (kind: BriefFenceKind, value: string): string => {
    const opts = kind === "body" ? { max: 10_000 } : { singleLine: true, max: kind === "name" ? 80 : 400 };
    // Jira's v2 description is wiki markup: the plain target, then the few
    // wiki specials escaped so a reviewer's text cannot steer the page.
    if (target === "jira") return escapeForJiraWiki(String(sanitise(value, "plain", opts)));
    return String(sanitise(value, target, opts));
  };

export function issueBody(t: Record<string, any>, baseUrl: string, target: BodyTarget = "github"): string {
  const brief: BriefThread = {
    key: t.key,
    status: t.status,
    anchor: t.anchor,
    anchorState: t.anchor_state,
    // The capture context stays out of a tracker: it is the personal-data-bearing half.
    context: null,
    comments: t.comments ?? [],
    attachments: [],
    createdBy: { name: t.created_by_name },
    assignee: t.assignee_name ? { name: t.assignee_name } : null,
    createdAt: new Date(t.created_at).toISOString(),
    ...(t.route ? { route: t.route } : {}),
  };
  const md = briefMarkdown(brief, { name: t.project_name }, { fence: fenceFor(target) });
  const open = `${baseUrl.replace(/\/+$/, "")}/s/${t.project_uid}/comments?thread=${encodeURIComponent(t.key)}`;
  // Plain strings, not a template: the SQL-comment linter reads the marker's
  // "-->" as a comment start on a line that also closes a template literal.
  const marker = "<!-- snagset:thread=" + ID_PREFIX.thread + t.id + " key=" + t.key + " project=" + t.project_uid + " -->";
  const end = "<!-- snag:end -->";
  return [marker, md, "**Open in Snagset:** " + open, end].join("\n") + "\n";
}

interface PushCtx {
  integration: IntegrationRow;
  token: string;
  thread: Record<string, any>;
  deps: PushDeps;
  /** The instance's address as it is now, resolved once per run. */
  base: string;
}

interface TrackerOps {
  create(ctx: PushCtx): Promise<{ externalId: string; url: string }>;
  setState(ctx: PushCtx, externalId: string): Promise<void>;
  /** A refusal the operator fixes with a new token, as opposed to a bad day at the provider. */
  authError(e: unknown): boolean;
  retryable(e: unknown): boolean;
}

const titleOf = (thread: Record<string, any>, target: BodyTarget) => {
  const first = (thread.comments as { body: string | null }[])[0];
  return issueTitle({
    key: thread.key,
    route: thread.route ?? "/",
    firstBody: first?.body ?? null,
    author: String(sanitise(String(thread.created_by_name ?? ""), target === "jira" ? "plain" : target, { singleLine: true, max: 80 })),
  });
};

const OPS: Record<Tracker, TrackerOps> = {
  github: {
    async create({ integration, token, thread, deps, base }) {
      const cfg = integration.config as unknown as GitHubIntegrationConfig;
      const gh = githubClient({ token, ...(deps.githubApiBase ? { apiBase: deps.githubApiBase } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      const repo = { owner: cfg.owner, repo: cfg.repo };
      const made = await gh.createIssue(repo, { title: titleOf(thread, "github"), body: issueBody(thread, base, "github"), labels: cfg.labels });
      // Born resolved, or moved while the row waited: the issue starts in the right state.
      if (thread.status === "resolved") await gh.setIssueState(repo, made.number, "closed", "completed");
      return { externalId: String(made.number), url: made.url };
    },
    async setState({ integration, token, thread, deps, base }, externalId) {
      const cfg = integration.config as unknown as GitHubIntegrationConfig;
      const gh = githubClient({ token, ...(deps.githubApiBase ? { apiBase: deps.githubApiBase } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      const closed = thread.status === "resolved";
      await gh.setIssueState({ owner: cfg.owner, repo: cfg.repo }, Number(externalId), closed ? "closed" : "open", closed ? "completed" : undefined);
    },
    authError: (e) => e instanceof GitHubError && (e.status === 401 || e.status === 404),
    retryable: (e) => (e instanceof GitHubError ? e.retryable : true),
  },
  linear: {
    async create({ integration, token, thread, deps, base }) {
      const cfg = integration.config as unknown as LinearIntegrationConfig;
      const lc = linearClient({ apiKey: token, ...(deps.linearApiBase ? { apiBase: deps.linearApiBase } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      const made = await lc.createIssue({
        teamId: cfg.teamId,
        title: titleOf(thread, "linear"),
        description: issueBody(thread, base, "linear"),
        stateId: linearStateFor(thread.status, cfg.states),
      });
      return { externalId: made.id, url: made.url };
    },
    async setState({ integration, token, thread, deps, base }, externalId) {
      const cfg = integration.config as unknown as LinearIntegrationConfig;
      const lc = linearClient({ apiKey: token, ...(deps.linearApiBase ? { apiBase: deps.linearApiBase } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      await lc.setState(externalId, linearStateFor(thread.status, cfg.states));
    },
    authError: (e) => e instanceof LinearError && (e.status === 401 || e.status === 403),
    retryable: (e) => (e instanceof LinearError ? e.retryable : true),
  },
  jira: {
    async create({ integration, token, thread, deps, base }) {
      const cfg = integration.config as unknown as JiraIntegrationConfig;
      const jc = jiraClient({ siteUrl: cfg.siteUrl, email: cfg.email, apiToken: token, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      const made = await jc.createIssue({
        projectId: cfg.projectId,
        issueTypeId: cfg.issueTypeId,
        summary: titleOf(thread, "jira"),
        description: issueBody(thread, base, "jira"),
      });
      // Born in the project's initial status; moved at once if ours says otherwise.
      if (thread.status !== "open" && thread.status !== "review") await jc.transitionTo(made.key, jiraCategoryFor(thread.status));
      return { externalId: made.key, url: made.url };
    },
    async setState({ integration, token, thread, deps, base }, externalId) {
      const cfg = integration.config as unknown as JiraIntegrationConfig;
      const jc = jiraClient({ siteUrl: cfg.siteUrl, email: cfg.email, apiToken: token, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      await jc.transitionTo(externalId, jiraCategoryFor(thread.status));
    },
    authError: (e) => e instanceof JiraError && (e.status === 401 || e.status === 403 || e.status === 404),
    retryable: (e) => (e instanceof JiraError ? e.retryable : true),
  },
  slack: {
    async create({ integration, token, thread, deps, base }) {
      const cfg = integration.config as unknown as SlackIntegrationConfig;
      const sc = slackClient({ token, ...(deps.slackApiBase ? { apiBase: deps.slackApiBase } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      const posted = await sc.post(cfg.channelId, slackMessage(slackInput(thread, base)));
      return { externalId: `${posted.channel}:${posted.ts}`, url: slackPermalink(cfg.teamUrl, posted.channel, posted.ts) };
    },
    async setState({ integration, token, thread, deps, base }, externalId) {
      const cfg = integration.config as unknown as SlackIntegrationConfig;
      const sc = slackClient({ token, ...(deps.slackApiBase ? { apiBase: deps.slackApiBase } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      const at = externalId.indexOf(":");
      const channel = at === -1 ? cfg.channelId : externalId.slice(0, at);
      const ts = at === -1 ? externalId : externalId.slice(at + 1);
      await sc.update(channel, ts, slackMessage(slackInput(thread, base)));
    },
    authError: (e) => e instanceof SlackError && ["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "missing_scope"].includes(e.code),
    retryable: (e) => (e instanceof SlackError ? e.retryable : true),
  },
};

const STATUS_WORD: Record<string, string> = { open: "Open", progress: "In progress", review: "In review", resolved: "Resolved" };

/** The thread as the Slack message wants it — strings only; the message builder does the escaping. */
function slackInput(thread: Record<string, any>, baseUrl: string) {
  const anchor = (thread.anchor ?? {}) as Record<string, any>;
  const page = anchor.page as { origin?: string; pathname?: string; route?: string } | undefined;
  const route = page?.route ?? thread.route ?? "/";
  const first = (thread.comments as { body: string | null }[])[0];
  const ctx = (thread.context ?? {}) as Record<string, any>;
  const d = ctx.derived as { browser?: string; os?: string; device?: string } | undefined;
  return {
    key: String(thread.key),
    status: String(thread.status),
    statusWord: STATUS_WORD[String(thread.status)] ?? String(thread.status),
    siteName: String(thread.project_name ?? ""),
    route,
    label: typeof anchor.label === "string" ? anchor.label : null,
    author: String(thread.created_by_name ?? ""),
    body: first?.body ?? null,
    openUrl: `${baseUrl.replace(/\/+$/, "")}/s/${thread.project_uid}/comments?thread=${encodeURIComponent(String(thread.key))}`,
    pageUrl: page?.origin ? `${page.origin}${page.pathname ?? route}?${param("t")}=${encodeURIComponent(String(thread.key))}` : null,
    environment: typeof thread.environment_key === "string" ? thread.environment_key : null,
    browser: d?.browser || d?.os ? [d.browser, d.os, d.device].filter(Boolean).join(" · ") : null,
  };
}

export function pushToTrackers(sql0: postgres.Sql, deps: PushDeps): Job {
  return {
    name: "push-to-trackers",
    everyMs: 15_000,
    async run({ sql, now, log }: JobContext): Promise<JobOutcome> {
      const base = await deps.baseUrl(); // Live, once per run
      const [row] = await sql<OutboxRow[]>`
        UPDATE outbox SET status = 'inflight', attempts = attempts + 1
         WHERE id = (
           SELECT id FROM outbox
            -- The DATABASE's clock, not the tick's: a row stamped by now() a
            -- moment ago must be claimable by a drain that starts at once,
            -- and a database whose clock runs a second ahead of the process
            -- (a container's does) would otherwise hold it for a whole tick.
            WHERE provider IN ('github', 'linear', 'jira', 'slack') AND status = 'pending' AND next_attempt_at <= GREATEST(${now}, now())
            ORDER BY next_attempt_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
        RETURNING id, org_id, project_id, integration_id, thread_id, provider, topic, attempts, event
      `;
      if (!row) return { did: 0 };
      const done = async (patch: { status: "done" | "dropped" | "failed" | "pending"; error?: string | null; next?: Date }) => {
        await sql`
          UPDATE outbox SET status = ${patch.status}, last_error = ${patch.error ?? null},
                 next_attempt_at = ${patch.next ?? now},
                 completed_at = ${patch.status === "done" || patch.status === "dropped" ? now : null}
           WHERE id = ${row.id}`;
      };
      if (!row.integration_id || !row.thread_id) {
        await done({ status: "dropped", error: "no integration or thread on the row" });
        return { did: 0, more: true };
      }
      const ops = OPS[row.provider];
      // The helpers open their own transactions: the pool, not the tick's connection.
      const integration = await getIntegration(sql0, deps.keys, row.org_id, row.project_id, row.provider);
      if (!ops || !integration || !integration.enabled || integration.id !== row.integration_id) {
        await done({ status: "dropped", error: "the integration is gone" });
        return { did: 0, more: true };
      }
      const token = trackerSecrets(integration.secret).token;
      if (!token) {
        await markIntegration(sql0, row.org_id, integration.id, "needs_reauth", "the token will not decrypt — connect it again");
        await done({ status: "dropped", error: "the token will not decrypt" });
        return { did: 0, more: true };
      }
      const thread = await loadThread(sql0, row.org_id, row.thread_id);
      if (!thread) {
        await done({ status: "dropped", error: "the thread is gone" });
        return { did: 0, more: true };
      }
      const ctx: PushCtx = { base, integration, token, thread, deps };

      try {
        const kind = REF_KIND[row.provider];
        const [ref] = await sql<{ external_id: string }[]>`
          SELECT external_id FROM external_refs
           WHERE thread_id = ${row.thread_id}::uuid AND provider = ${row.provider}::snag_provider AND kind = ${kind}::snag_ref_kind AND status <> 'detached'
        `;
        if (row.topic === "issue.create") {
          if (!ref) {
            const made = await ops.create(ctx);
            // ONE canonical ref per thread per tracker (the index): a
            // detached ref from an issue the tracker deleted is reused for
            // the new issue rather than kept beside it.
            const reused = await sql`
              UPDATE external_refs
                 SET external_id = ${made.externalId}, url = ${made.url}, status = 'synced', synced_at = now(), last_error = NULL
               WHERE thread_id = ${row.thread_id}::uuid AND provider = ${row.provider}::snag_provider AND kind = ${kind}::snag_ref_kind
            `;
            if (reused.count === 0) {
              await sql`
                INSERT INTO external_refs (id, org_id, project_id, thread_id, provider, kind, status, external_id, url)
                VALUES (${randomUUID()}, ${row.org_id}::uuid, ${row.project_id}::uuid, ${row.thread_id}::uuid, ${row.provider}::snag_provider, ${kind}::snag_ref_kind, 'synced',
                        ${made.externalId}, ${made.url})
              `;
            }
          }
        } else if (row.topic === "issue.state" && ref) {
          await ops.setState(ctx, ref.external_id);
          await sql`UPDATE external_refs SET synced_at = now(), status = 'synced', last_error = NULL
                     WHERE thread_id = ${row.thread_id}::uuid AND provider = ${row.provider}::snag_provider AND kind = ${kind}::snag_ref_kind AND external_id = ${ref.external_id}`;
        }
        await markIntegration(sql0, row.org_id, integration.id, "ok", null);
        await done({ status: "done" });
        return { did: 1, more: true };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const wait = BACKOFF_MIN[Math.min(row.attempts - 1, BACKOFF_MIN.length - 1)]!;
        const exhausted = row.attempts >= BACKOFF_MIN.length || !ops.retryable(e);
        await markIntegration(sql0, row.org_id, integration.id, ops.authError(e) ? "needs_reauth" : "error", message);
        await done({ status: exhausted ? "failed" : "pending", error: message, next: new Date(now.getTime() + wait * 60_000) });
        log(`jobs: push-to-trackers: ${row.provider} attempt ${row.attempts} failed: ${message}`);
        return { did: 0, more: true };
      }
    },
  };
}

/** Drain the queue now — the dashboard's "Create issue" wants the link back in the same click. */
export async function drainNow(sql: postgres.Sql, deps: PushDeps, limit = 5): Promise<void> {
  const job = pushToTrackers(sql, deps);
  const ctx: JobContext = { sql, now: new Date(), log: () => {} } as JobContext;
  for (let i = 0; i < limit; i++) {
    const out = await job.run(ctx);
    if (!out.more) break;
  }
}
