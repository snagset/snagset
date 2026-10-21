import { Hono, type Context } from "hono";
import type postgres from "postgres";
import { ID_PREFIX } from "@snagset/types/names";
import type { Keyring } from "../keys.ts";
import type { ProjectCache } from "../projectCache.ts";
import type { ProjectRow } from "../projectCache.ts";
import type { OwnerClaims } from "./owner.ts";
import { open } from "../crypto.ts";
import { githubClient } from "../integrations/github.ts";
import { linearClient, statusForLinearState, verifyLinearSignature } from "../integrations/linear.ts";
import { jiraClient, statusForJiraCategory, verifyJiraSignature } from "../integrations/jira.ts";
import { slackClient, slackManifest } from "../integrations/slack.ts";
import type { AddressSource } from "../instance/address.ts";
import { LimitReached, planLimitReached, type LimitsSource } from "../plan.ts";
import {
  getIntegration,
  isTracker,
  listIntegrations,
  markIntegration,
  mintWebhookSecret,
  putIntegration,
  removeIntegration,
  trackerSecrets,
  type GitHubIntegrationConfig,
  type IntegrationRow,
  type JiraIntegrationConfig,
  type LinearIntegrationConfig,
  type SlackIntegrationConfig,
  type Tracker,
  REF_KIND,
} from "../integrations/store.ts";
import { applyGitHubIssueEvent, applyIssueState, verifyGitHubSignature, type Applied } from "../integrations/inbound.ts";
import { queueResolvedNotice } from "../mail/notify.ts";
import { drainNow, queueIntegrationEvent, type PushDeps } from "../integrations/outbox.ts";
import { inOrg } from "../db/scope.ts";
import { can } from "@snagset/types/roles";

/**
 * Integrations from the dashboard — 05 endpoint 25 shaped for a self-host
 * a token, not an OAuth app. GitHub and Linear.
 *
 *   GET    /api/v1/integrations                            every connection in the studio, for the cards
 *   GET    /api/v1/projects/:uid/integrations              this site's connections, for the brief
 *   GET    /api/v1/projects/:uid/integrations/:provider    one of them
 *   PUT    …                                               connect or replace — probed before it is stored
 *   DELETE …                                               disconnect; existing issues keep their links
 *   POST   …/test                                          probe again, for the card's health line
 *   POST   …/webhook-secret                                GitHub: a new minted secret, shown once
 *   POST   /api/v1/integrations/:provider/inbound          the tracker → us
 *   POST   /api/v1/projects/:uid/threads/:id/integrations/:provider   make the issue now
 *
 * Owners write, admins see. Tokens never come back: the GET carries the
 * target, when issues are made, and the health the worker last saw.
 */

type Env = { Variables: { requestId: string; owner?: OwnerClaims } };
type Ctx = Context<Env>;

export interface IntegrationDeps {
  sql: postgres.Sql;
  keys: Keyring;
  projects: ProjectCache;
  push: PushDeps;
  /** Where this instance lives — the webhook URL the card shows. Read live. */
  baseUrl: AddressSource;
  /** Whether a transport exists, asked live: an inbound resolve mails like a dashboard one. */
  notifications: () => Promise<boolean>;
  /** The org's limits: whether the cards may connect at all. */
  limits: LimitsSource;
}

function fail(c: Ctx, status: number, code: string, message: string, details?: unknown) {
  return c.json({ error: { code, message, ...(details ? { details } : {}), requestId: c.get("requestId") } }, status as 400);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME: Record<Tracker, string> = { github: "GitHub", linear: "Linear", jira: "Jira", slack: "Slack" };

export function integrationRoutes(deps: IntegrationDeps): Hono<Env> {
  const { sql, keys, projects } = deps;
  const app = new Hono<Env>();
  const webhookUrl = async (provider: Tracker) => `${(await deps.baseUrl()).replace(/\/+$/, "")}/api/v1/integrations/${provider}/inbound`;
  const ghOpts = () => ({ ...(deps.push.githubApiBase ? { apiBase: deps.push.githubApiBase } : {}), ...(deps.push.fetch ? { fetch: deps.push.fetch } : {}) });
  const lnOpts = () => ({ ...(deps.push.linearApiBase ? { apiBase: deps.push.linearApiBase } : {}), ...(deps.push.fetch ? { fetch: deps.push.fetch } : {}) });

  const mustBeOwner = (c: Ctx): OwnerClaims | Response => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    // Owners and admins: connecting a site to the team's tracker is everyday
    // studio work, and an admin is a trusted teammate. Not a member:
    // a connection holds the studio's token for somebody's repository, and
    // making an issue with it — "Create … issue" on the brief, which also
    // comes here — speaks in the studio's name outside Snagset.
    if (!can(owner.role, "settings")) {
      return fail(c, 403, "forbidden", "Only an owner or an admin can use or change what a site is connected to.");
    }
    return owner;
  };
  const site = async (c: Ctx, owner: OwnerClaims): Promise<ProjectRow | null> => {
    const p = await projects.get(c.req.param("uid") ?? "");
    if (!p || p.org_id !== owner.orgId) return null;
    return p;
  };
  const provider = (c: Ctx): Tracker | Response => {
    const v = c.req.param("provider") ?? "";
    return isTracker(v) ? v : fail(c, 404, "integration_not_configured", `No tracker called ${JSON.stringify(v)}. This build speaks: github, linear, jira, slack.`);
  };

  /** The card's view of a connection — never a token. */
  const shape = (i: IntegrationRow, projectUid: string) => {
    const base = {
      site: projectUid,
      createOn: ((i.config as { createOn?: string }).createOn === "thread.created" ? "thread.created" : "manual") as "manual" | "thread.created",
      health: i.unreadable ? "needs_reauth" : i.installState,
      lastError: i.lastError,
      updatedAt: i.updatedAt.toISOString(),
      hasWebhookSecret: !!trackerSecrets(i.secret).webhookSecret,
    };
    if (i.provider === "linear") {
      const cfg = i.config as unknown as LinearIntegrationConfig;
      return { provider: "linear" as const, ...base, teamKey: cfg.teamKey, teamName: cfg.teamName };
    }
    if (i.provider === "jira") {
      const cfg = i.config as unknown as JiraIntegrationConfig;
      return { provider: "jira" as const, ...base, siteUrl: cfg.siteUrl, projectKey: cfg.projectKey, projectName: cfg.projectName, issueType: cfg.issueTypeName, email: cfg.email };
    }
    if (i.provider === "slack") {
      const cfg = i.config as unknown as SlackIntegrationConfig;
      return { provider: "slack" as const, ...base, teamName: cfg.teamName, teamUrl: cfg.teamUrl, channelId: cfg.channelId, channelName: cfg.channelName };
    }
    const cfg = i.config as unknown as GitHubIntegrationConfig;
    return { provider: "github" as const, ...base, owner: cfg.owner, repo: cfg.repo, labels: cfg.labels ?? [] };
  };
  const sites = async (orgId: string) => {
    const rows = await inOrg(sql, orgId, (tx) => tx<{ id: string; uid: string; name: string }[]>`
      SELECT id, uid, name FROM projects WHERE org_id = ${orgId}::uuid AND deleted_at IS NULL
    `);
    return new Map(rows.map((p) => [p.id, p]));
  };

  // Studio › Integrations' own reads: an admin's page, so an admin's
  // reads. The per-site list below stays open to the whole studio — the
  // brief names the trackers a comment's issue lives in from it.
  app.get("/api/v1/integrations", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    const byId = await sites(owner.orgId);
    const rows = await listIntegrations(sql, keys, owner.orgId);
    return c.json({
      data: rows
        .filter((r) => isTracker(r.provider) && byId.has(r.projectId))
        .map((r) => ({ ...shape(r, byId.get(r.projectId)!.uid), siteName: byId.get(r.projectId)!.name })),
    });
  });

  app.get("/api/v1/projects/:uid/integrations", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    const p = await site(c, owner);
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    const rows = (await listIntegrations(sql, keys, owner.orgId)).filter((r) => r.projectId === p.id && isTracker(r.provider));
    return c.json({ data: rows.map((r) => shape(r, p.uid)) });
  });

  /** The manifest the operator creates the Slack app from — one link, scopes pre-filled. */
  app.get("/api/v1/integrations/slack/manifest", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    const [org] = await inOrg(sql, owner.orgId, (tx) => tx<{ name: string }[]>`SELECT name FROM orgs WHERE id = ${owner.orgId}::uuid`);
    const manifest = slackManifest(org?.name ?? "Snagset");
    return c.json({ manifest, url: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}` });
  });

  app.get("/api/v1/projects/:uid/integrations/:provider", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    const pv = provider(c);
    if (pv instanceof Response) return pv;
    const p = await site(c, owner);
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    const i = await getIntegration(sql, keys, p.org_id, p.id, pv);
    return c.json({ integration: i ? shape(i, p.uid) : null });
  });

  app.put("/api/v1/projects/:uid/integrations/:provider", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    const pv = provider(c);
    if (pv instanceof Response) return pv;
    const p = await site(c, owner);
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    // The plan's word: a tier without the integrations refuses the connect, never hides the card.
    if (!(await deps.limits(p.org_id)).integrations) return planLimitReached(c, new LimitReached("integrations", 0, 0));
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const str = (k: string) => (typeof body?.[k] === "string" ? (body![k] as string).trim() : "");
    // Slack announces: every new comment by default. The trackers ask first.
    const createOn = body?.["createOn"] === "thread.created" ? "thread.created" : body?.["createOn"] === "manual" ? "manual" : pv === "slack" ? "thread.created" : "manual";
    const existing = await getIntegration(sql, keys, p.org_id, p.id, pv);
    const had = trackerSecrets(existing?.secret ?? null);

    if (pv === "slack") {
      // Slack: a bot token from the app the operator created from our
      // manifest, and a channel by #name or id. Probed — the token, then the
      // channel — before it is stored.
      const token = str("token") || had.token || "";
      if (!/^xox[bp]-/.test(token)) return fail(c, 422, "validation_failed", "Paste the app's Bot User OAuth Token — it starts with xoxb-.", { field: "token" });
      const channel = str("channel") || (existing?.config as SlackIntegrationConfig | undefined)?.channelId || "";
      if (!channel) return fail(c, 422, "validation_failed", "Give the channel, like #reviews.", { field: "channel" });
      const sc = slackClient({ token, ...(deps.push.slackApiBase ? { apiBase: deps.push.slackApiBase } : {}), ...(deps.push.fetch ? { fetch: deps.push.fetch } : {}) });
      let who: { team: string; url: string; bot: string };
      let ch: { id: string; name: string; isMember: boolean };
      try {
        who = await sc.whoami();
        ch = await sc.resolveChannel(channel);
      } catch (e) {
        return fail(c, 422, "validation_failed", e instanceof Error ? e.message : String(e), { field: "token" });
      }
      await putIntegration(sql, keys, {
        orgId: p.org_id,
        projectId: p.id,
        provider: "slack",
        config: { teamName: who.team, teamUrl: who.url, channelId: ch.id, channelName: ch.name, createOn } satisfies SlackIntegrationConfig,
        secret: JSON.stringify({ token, webhookSecret: null }),
      });
      const i = await getIntegration(sql, keys, p.org_id, p.id, "slack");
      return c.json({ integration: i ? shape(i, p.uid) : null });
    }

    if (pv === "github") {
      // `owner/repo` in one box is what people paste; two boxes are accepted too.
      let ownerName = str("owner");
      let repo = str("repo");
      const full = str("repository");
      if (full && !ownerName && !repo) {
        const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(full);
        if (!m) return fail(c, 422, "validation_failed", "Give the repository as owner/name, like kilnwork/site.", { field: "repository" });
        ownerName = m[1]!;
        repo = m[2]!;
      }
      if (!ownerName || !repo) return fail(c, 422, "validation_failed", "Give the repository as owner/name, like kilnwork/site.", { field: "repository" });
      const token = str("token") || had.token || "";
      if (!token) return fail(c, 422, "validation_failed", "Paste a fine-grained token with Issues: read and write on that repository.", { field: "token" });
      // The webhook secret is minted on the first connect and kept across
      // replacements — the operator registered it on the repository once.
      const minted = had.webhookSecret ? null : mintWebhookSecret();
      const webhookSecret = had.webhookSecret ?? minted!;
      const prior = (existing?.config as GitHubIntegrationConfig | undefined)?.labels ?? [];
      const labels = Array.isArray(body?.["labels"])
        ? (body!["labels"] as unknown[]).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20)
        : typeof body?.["labels"] === "string"
          ? (body!["labels"] as string).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20)
          : prior;
      // Probed before it is stored: a token that is merely well-formed is the
      // one that fails on the first issue, in front of the client.
      const probe = await githubClient({ token, ...ghOpts() }).probe({ owner: ownerName, repo });
      if (!probe.ok) return fail(c, 422, "validation_failed", probe.detail, { field: "token" });
      if (!probe.canWrite) {
        return fail(c, 422, "validation_failed", `The token can see ${probe.fullName} but cannot write to it. It needs Issues: read and write.`, { field: "token" });
      }
      await putIntegration(sql, keys, {
        orgId: p.org_id,
        projectId: p.id,
        provider: "github",
        config: { owner: ownerName, repo, labels, createOn } satisfies GitHubIntegrationConfig,
        secret: JSON.stringify({ token, webhookSecret }),
      });
      const i = await getIntegration(sql, keys, p.org_id, p.id, "github");
      return c.json({
        integration: i ? shape(i, p.uid) : null,
        // Shown ONCE, like a review link: the URL to paste and the secret GitHub signs with.
        ...(minted ? { webhook: { url: await webhookUrl("github"), secret: minted } } : {}),
      });
    }

    if (pv === "jira") {
      // Jira Cloud: the site, the project key, the account's email and
      // an API token — basic auth, what Atlassian gives a self-hoster — and,
      // for the way back, the secret the operator typed into Jira's webhook.
      const siteUrl = str("siteUrl").replace(/\/+$/, "");
      if (!/^https?:\/\/[^\s/]+$/.test(siteUrl)) return fail(c, 422, "validation_failed", "Give the site's address, like https://kilnwork.atlassian.net.", { field: "siteUrl" });
      const projectKey = str("project").toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{0,9}$/.test(projectKey)) return fail(c, 422, "validation_failed", "Give the project's key, like KAN.", { field: "project" });
      const prior = existing?.config as JiraIntegrationConfig | undefined;
      const email = str("email").toLowerCase() || prior?.email || "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(c, 422, "validation_failed", "Give the Atlassian account's email — the token belongs to it.", { field: "email" });
      const apiToken = str("apiToken") || had.token || "";
      if (!apiToken) return fail(c, 422, "validation_failed", "Paste an API token from id.atlassian.com › Security › API tokens.", { field: "apiToken" });
      const webhookSecret = str("webhookSecret") || had.webhookSecret || null;
      const probe = await jiraClient({ siteUrl, email, apiToken, ...(deps.push.fetch ? { fetch: deps.push.fetch } : {}) }).probe(projectKey);
      if (!probe.ok) return fail(c, 422, "validation_failed", probe.detail, { field: "apiToken" });
      await putIntegration(sql, keys, {
        orgId: p.org_id,
        projectId: p.id,
        provider: "jira",
        config: {
          siteUrl,
          email,
          projectKey: probe.project.key,
          projectId: probe.project.id,
          projectName: probe.project.name,
          issueTypeId: probe.issueType.id,
          issueTypeName: probe.issueType.name,
          createOn,
        } satisfies JiraIntegrationConfig,
        secret: JSON.stringify({ token: apiToken, webhookSecret }),
      });
      const i = await getIntegration(sql, keys, p.org_id, p.id, "jira");
      return c.json({ integration: i ? shape(i, p.uid) : null, webhook: { url: await webhookUrl("jira") } });
    }

    // Linear: an API key belonging to a member of the team, the team's
    // key, and — for the way back — the signing secret Linear shows when the
    // operator creates the webhook, pasted here.
    const teamKey = str("team").toUpperCase();
    if (!/^[A-Z][A-Z0-9]{0,7}$/.test(teamKey)) return fail(c, 422, "validation_failed", "Give the team's key, like ENG.", { field: "team" });
    const apiKey = str("apiKey") || had.token || "";
    if (!apiKey) return fail(c, 422, "validation_failed", "Paste a personal API key from Linear › Settings › API.", { field: "apiKey" });
    const webhookSecret = str("webhookSecret") || had.webhookSecret || null;
    const probe = await linearClient({ apiKey, ...lnOpts() }).probe(teamKey);
    if (!probe.ok) return fail(c, 422, "validation_failed", probe.detail, { field: "apiKey" });
    await putIntegration(sql, keys, {
      orgId: p.org_id,
      projectId: p.id,
      provider: "linear",
      config: { teamId: probe.team.id, teamKey: probe.team.key, teamName: probe.team.name, states: probe.states, createOn } satisfies LinearIntegrationConfig,
      secret: JSON.stringify({ token: apiKey, webhookSecret }),
    });
    const i = await getIntegration(sql, keys, p.org_id, p.id, "linear");
    return c.json({ integration: i ? shape(i, p.uid) : null, webhook: { url: await webhookUrl("linear") } });
  });

  app.delete("/api/v1/projects/:uid/integrations/:provider", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    const pv = provider(c);
    if (pv instanceof Response) return pv;
    const p = await site(c, owner);
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    await removeIntegration(sql, p.org_id, p.id, pv);
    return c.json({ integration: null });
  });

  app.post("/api/v1/projects/:uid/integrations/:provider/test", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    const pv = provider(c);
    if (pv instanceof Response) return pv;
    const p = await site(c, owner);
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    const i = await getIntegration(sql, keys, p.org_id, p.id, pv);
    const token = trackerSecrets(i?.secret ?? null).token;
    if (!i || !token) return fail(c, 409, "integration_not_configured", `${NAME[pv]} is not connected on this site.`);
    let ok: { ok: true; target: string } | { ok: false; detail: string };
    if (pv === "github") {
      const cfg = i.config as unknown as GitHubIntegrationConfig;
      const r = await githubClient({ token, ...ghOpts() }).probe({ owner: cfg.owner, repo: cfg.repo });
      ok = r.ok ? { ok: true, target: r.fullName } : r;
    } else if (pv === "jira") {
      const cfg = i.config as unknown as JiraIntegrationConfig;
      const r = await jiraClient({ siteUrl: cfg.siteUrl, email: cfg.email, apiToken: token, ...(deps.push.fetch ? { fetch: deps.push.fetch } : {}) }).probe(cfg.projectKey);
      ok = r.ok ? { ok: true, target: `${r.project.key} · ${r.project.name}` } : r;
    } else if (pv === "slack") {
      const cfg = i.config as unknown as SlackIntegrationConfig;
      try {
        const sc = slackClient({ token, ...(deps.push.slackApiBase ? { apiBase: deps.push.slackApiBase } : {}), ...(deps.push.fetch ? { fetch: deps.push.fetch } : {}) });
        const who = await sc.whoami();
        const ch = await sc.resolveChannel(cfg.channelId);
        ok = { ok: true, target: `#${ch.name} in ${who.team}` };
      } catch (e) {
        ok = { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    } else {
      const cfg = i.config as unknown as LinearIntegrationConfig;
      const r = await linearClient({ apiKey: token, ...lnOpts() }).probe(cfg.teamKey);
      ok = r.ok ? { ok: true, target: `${r.team.key} · ${r.team.name}` } : r;
    }
    await markIntegration(sql, p.org_id, i.id, ok.ok ? "ok" : "needs_reauth", ok.ok ? null : ok.detail);
    return c.json(ok.ok ? { ok: true, repository: ok.target, target: ok.target } : { ok: false, detail: ok.detail });
  });

  /** GitHub only: a new minted webhook secret, shown once; the old one stops working the moment this answers. */
  app.post("/api/v1/projects/:uid/integrations/:provider/webhook-secret", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    const pv = provider(c);
    if (pv instanceof Response) return pv;
    const p = await site(c, owner);
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    if (pv === "slack") return fail(c, 409, "integration_not_configured", "Slack sends nothing back in this version; there is no webhook to secure.");
    if (pv !== "github") {
      return fail(c, 409, "integration_not_configured", `${NAME[pv]}'s webhook secret is typed into ${NAME[pv]}'s own webhook form: paste the same secret when connecting.`);
    }
    const i = await getIntegration(sql, keys, p.org_id, p.id, "github");
    const had = trackerSecrets(i?.secret ?? null);
    if (!i || !had.token) return fail(c, 409, "integration_not_configured", "GitHub is not connected on this site.");
    const secret = mintWebhookSecret();
    await putIntegration(sql, keys, {
      orgId: p.org_id,
      projectId: p.id,
      provider: "github",
      config: i.config as unknown as Record<string, unknown>,
      secret: JSON.stringify({ token: had.token, webhookSecret: secret }),
    });
    return c.json({ webhook: { url: await webhookUrl("github"), secret } });
  });

  /** After an inbound resolve, the same mail a dashboard resolve sends, signed by the tracker. */
  const noticeIfResolved = async (applied: Applied, orgId: string, projectId: string, actorName: string) => {
    if (applied.kind !== "resolved" || !(await deps.notifications())) return;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      await queueResolvedNotice(tx as postgres.TransactionSql, {
        orgId,
        projectId,
        threadId: applied.threadId,
        threadKey: applied.threadKey,
        version: applied.version,
        actorId: applied.threadId,
        actorName,
        pageUrl: applied.pageUrl,
      });
    });
  };
  const candidatesFor = (pv: Tracker, where: (tx: postgres.TransactionSql) => postgres.PendingQuery<postgres.Row[]>) =>
    sql.begin(async (tx) => {
      // Read under the maintenance claim: the tracker holds no org, and the
      // org is what the row tells us.
      await tx`SET LOCAL app.maintenance = 'on'`;
      return where(tx as postgres.TransactionSql) as unknown as Promise<
        { id: string; org_id: string; project_id: string; credentials: Buffer | null; credentials_iv: Buffer | null }[]
      >;
    });
  const secretOf = (r: { credentials: Buffer | null; credentials_iv: Buffer | null }) =>
    trackerSecrets(r.credentials && r.credentials_iv ? open(keys, { ciphertext: r.credentials, iv: r.credentials_iv }) : null).webhookSecret;

  /**
   * The tracker → us (05 endpoint 25c). Unauthenticated in the session
   * sense; authenticated by the provider's signature over the RAW body with
   * the secret this connection holds — minted by us for GitHub,
   * pasted from Linear's form for Linear. The target named in the
   * payload picks the candidate connections; the signature picks the one.
   */
  app.post("/api/v1/integrations/:provider/inbound", async (c) => {
    const pv = provider(c);
    if (pv instanceof Response) return pv;
    if (pv === "slack") return fail(c, 409, "integration_not_configured", "Slack sends nothing back in this version.");
    const raw = await c.req.text();
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(raw) as Record<string, any>;
    } catch {
      return fail(c, 400, "validation_failed", "The body is not JSON.");
    }

    if (pv === "github") {
      const signature = c.req.header("x-hub-signature-256");
      const event = c.req.header("x-github-event") ?? "";
      const delivery = c.req.header("x-github-delivery") ?? "";
      if (event === "ping") return c.json({ ok: true, pong: true });
      const fullName = String(payload?.repository?.full_name ?? "").toLowerCase();
      if (!fullName.includes("/")) return fail(c, 400, "validation_failed", "The payload names no repository.");
      const [ownerName, repo] = fullName.split("/") as [string, string];
      const candidates = await candidatesFor("github", (tx) => tx`
        SELECT id, org_id, project_id, credentials, credentials_iv FROM integrations
         WHERE provider = 'github' AND deleted_at IS NULL AND enabled
           AND lower(config->>'owner') = ${ownerName} AND lower(config->>'repo') = ${repo}
      `);
      const match = candidates.find((r) => {
        const s = secretOf(r);
        return !!s && verifyGitHubSignature(raw, signature, s);
      });
      if (!match) {
        return candidates.length
          ? fail(c, 401, "provider_signature_invalid", "The signature does not match this repository's webhook secret.")
          : fail(c, 409, "integration_not_configured", `No site here is connected to ${fullName}.`);
      }
      if (event !== "issues") return c.json({ ok: true, ignored: event });
      const number = Number(payload?.issue?.number);
      if (!Number.isInteger(number)) return fail(c, 400, "validation_failed", "The payload names no issue.");
      const applied = await applyGitHubIssueEvent(sql, {
        orgId: match.org_id,
        projectId: match.project_id,
        deliveryId: delivery || `${fullName}#${number}:${String(payload?.action)}:${Date.now()}`,
        action: String(payload?.action ?? ""),
        issueNumber: number,
      });
      await noticeIfResolved(applied, match.org_id, match.project_id, "GitHub");
      return c.json({ ok: true, applied: applied.kind, ...("why" in applied ? { why: applied.why } : {}) });
    }

    if (pv === "jira") {
      // Jira Cloud: X-Hub-Signature over the body with the secret typed into
      // the webhook; X-Atlassian-Webhook-Identifier is the replay key. The
      // project and the site in the payload pick the candidates.
      const signature = c.req.header("x-hub-signature");
      const delivery = c.req.header("x-atlassian-webhook-identifier") ?? "";
      const event = String(payload?.webhookEvent ?? "");
      const issue = payload?.issue as Record<string, any> | undefined;
      const projectId = String(issue?.fields?.project?.id ?? "");
      const issueKey = String(issue?.key ?? "");
      if (!projectId || !issueKey) return fail(c, 400, "validation_failed", "The payload names no issue in a project.");
      let host = "";
      try {
        host = new URL(String(issue?.self ?? "")).host.toLowerCase();
      } catch {
        /* no self link — the project id alone will have to do */
      }
      const candidates = await candidatesFor("jira", (tx) => tx`
        SELECT id, org_id, project_id, credentials, credentials_iv FROM integrations
         WHERE provider = 'jira' AND deleted_at IS NULL AND enabled AND config->>'projectId' = ${projectId}
           AND (${host} = '' OR lower(config->>'siteUrl') LIKE ${"%//" + host + "%"})
      `);
      const match = candidates.find((r) => {
        const s = secretOf(r);
        return !!s && verifyJiraSignature(raw, signature, s);
      });
      if (!match) {
        return candidates.length
          ? fail(c, 401, "provider_signature_invalid", "The signature does not match this project's webhook secret — type the same secret into Jira's webhook and when connecting.")
          : fail(c, 409, "integration_not_configured", "No site here is connected to that Jira project.");
      }
      let status: "resolved" | "progress" | "open" | "detach" | null = null;
      if (event === "jira:issue_deleted") status = "detach";
      else if (event === "jira:issue_updated" || event === "jira:issue_created") {
        const category = String(issue?.fields?.status?.statusCategory?.key ?? "");
        if (category) status = statusForJiraCategory(category);
      }
      if (!status) return c.json({ ok: true, applied: "ignored", why: "action" });
      const applied = await applyIssueState(sql, {
        provider: "jira",
        orgId: match.org_id,
        projectId: match.project_id,
        deliveryId: delivery || `${issueKey}:${event}:${String(issue?.fields?.updated ?? Date.now())}`,
        externalId: issueKey,
        status,
      });
      await noticeIfResolved(applied, match.org_id, match.project_id, "Jira");
      return c.json({ ok: true, applied: applied.kind, ...("why" in applied ? { why: applied.why } : {}) });
    }

    // Linear: Linear-Signature is the hex HMAC over the raw body
    // with the webhook's signing secret; Linear-Delivery is the replay key;
    // webhookTimestamp guards a captured body replayed much later.
    const signature = c.req.header("linear-signature");
    const delivery = c.req.header("linear-delivery") ?? "";
    const stamp = Number(payload?.webhookTimestamp);
    if (Number.isFinite(stamp) && Math.abs(Date.now() - stamp) > 5 * 60_000) {
      return fail(c, 401, "provider_signature_invalid", "The delivery's timestamp is more than five minutes off.");
    }
    const teamId = String(payload?.data?.teamId ?? payload?.data?.team?.id ?? "");
    if (!teamId) return fail(c, 400, "validation_failed", "The payload names no team.");
    const candidates = await candidatesFor("linear", (tx) => tx`
      SELECT id, org_id, project_id, credentials, credentials_iv FROM integrations
       WHERE provider = 'linear' AND deleted_at IS NULL AND enabled AND config->>'teamId' = ${teamId}
    `);
    const match = candidates.find((r) => {
      const s = secretOf(r);
      return !!s && verifyLinearSignature(raw, signature, s);
    });
    if (!match) {
      return candidates.length
        ? fail(c, 401, "provider_signature_invalid", "The signature does not match this team's webhook secret — paste the signing secret from Linear's webhook when connecting.")
        : fail(c, 409, "integration_not_configured", "No site here is connected to that Linear team.");
    }
    if (payload?.type !== "Issue") return c.json({ ok: true, ignored: String(payload?.type ?? "") });
    const issueId = String(payload?.data?.id ?? "");
    if (!issueId) return fail(c, 400, "validation_failed", "The payload names no issue.");
    const action = String(payload?.action ?? "");
    const stateType = typeof payload?.data?.state?.type === "string" ? (payload.data.state.type as string) : null;
    let status: "resolved" | "progress" | "open" | "detach" | null = null;
    if (action === "remove") status = "detach";
    else if ((action === "update" || action === "create") && stateType) status = statusForLinearState(stateType);
    if (!status) return c.json({ ok: true, applied: "ignored", why: "action" });
    const applied = await applyIssueState(sql, {
      provider: "linear",
      orgId: match.org_id,
      projectId: match.project_id,
      deliveryId: delivery || `${issueId}:${action}:${Date.now()}`,
      externalId: issueId,
      status,
    });
    await noticeIfResolved(applied, match.org_id, match.project_id, "Linear");
    return c.json({ ok: true, applied: applied.kind, ...("why" in applied ? { why: applied.why } : {}) });
  });

  /** "Create … issue" on the Brief — queued in a transaction, drained now, the link comes back. */
  app.post("/api/v1/projects/:uid/threads/:id/integrations/:provider", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    const pv = provider(c);
    if (pv instanceof Response) return pv;
    const p = await site(c, owner);
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    const raw = c.req.param("id") ?? "";
    const threadRow = raw.startsWith(ID_PREFIX.thread) ? raw.slice(ID_PREFIX.thread.length) : raw;
    if (!UUID.test(threadRow)) return fail(c, 404, "thread_not_found", "No such thread in this project.");
    const i = await getIntegration(sql, keys, p.org_id, p.id, pv);
    if (!i || !i.enabled) return fail(c, 409, "integration_not_configured", `${NAME[pv]} is not connected on this site.`);
    const queued = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${p.org_id}, true)`;
      const [t] = await tx<{ version: number }[]>`
        SELECT version FROM threads WHERE id = ${threadRow}::uuid AND project_id = ${p.id}::uuid AND deleted_at IS NULL
      `;
      if (!t) return false;
      // The dedupe key counts the issues this thread has LOST: the first
      // create is row 0, a second click while that issue lives hits the same
      // key and queues nothing (the live ref answers), and a new issue after
      // the tracker deleted the old one is row 1. The worker still refuses
      // to create beside a live ref, so the key can never make a duplicate.
      const [had] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM external_refs
         WHERE thread_id = ${threadRow}::uuid AND provider = ${pv}::snag_provider AND kind = ${REF_KIND[pv]}::snag_ref_kind AND status = 'detached'
      `;
      await queueIntegrationEvent(tx as postgres.TransactionSql, {
        orgId: p.org_id,
        projectId: p.id,
        integrationId: i.id,
        threadId: threadRow,
        provider: pv,
        topic: "issue.create",
        version: had?.n ?? 0,
      });
      return true;
    });
    if (!queued) return fail(c, 404, "thread_not_found", "No such thread in this project.");
    await drainNow(sql, deps.push);
    const [ref] = await inOrg(sql, p.org_id, (tx) => tx<{ external_id: string; url: string; status: string }[]>`
      SELECT external_id, url, status FROM external_refs
       WHERE thread_id = ${threadRow}::uuid AND provider = ${pv}::snag_provider AND kind = ${REF_KIND[pv]}::snag_ref_kind AND status <> 'detached'
    `);
    if (ref) return c.json({ ref: { provider: pv, kind: REF_KIND[pv], externalId: ref.external_id, url: ref.url, status: ref.status } });
    const fresh = await getIntegration(sql, keys, p.org_id, p.id, pv);
    return fail(c, 502, "integration_push_failed", fresh?.lastError ?? `${NAME[pv]} did not take the ${REF_KIND[pv]}. The card on Studio › Integrations says why.`);
  });

  return app;
}
