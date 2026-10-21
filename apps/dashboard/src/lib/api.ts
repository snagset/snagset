/**
 * The one place the dashboard talks to the server.
 *
 * Every call carries `credentials: 'same-origin'` and, on a mutation, the
 * CSRF header the design requires. Both live here rather than at each call site
 * for the reason every other registry in this codebase exists: a call that
 * forgets one is a call that works in development and fails in production, or
 * worse, works everywhere and is the hole.
 */

import { HTTP_HEADER, DASHBOARD_CSRF_COOKIE } from "@snagset/types/names";

export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
}

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, error: ApiError) {
    super(error.message);
    this.status = status;
    this.code = error.code;
  }
}

/** The double-submit half, read from the cookie the server set. */
function csrfToken(): string {
  for (const part of document.cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === DASHBOARD_CSRF_COOKIE) return part.slice(i + 1).trim();
  }
  return "";
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    // same-origin, not 'include': the dashboard is served by the same server
    // it calls, so there is no cross-origin case to allow — and 'include'
    // would send our cookies to anything a future bug pointed this at.
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" ? {} : { [HTTP_HEADER.csrf]: csrfToken() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as { error?: ApiError } | T | null;
  if (!res.ok) {
    const err = (json as { error?: ApiError } | null)?.error;
    throw new ApiFailure(res.status, err ?? { code: "unknown", message: `Request failed (${res.status}).` });
  }
  return json as T;
}

/** What a site may be told about itself — every field optional, absent means unchanged. */
export interface SitePatch {
  name?: string;
  origins?: string[];
  writeMode?: string;
  /** Null clears it. */
  domain?: string | null;
  status?: "active" | "paused";
  /** Whether guests (no account, no link) may change a comment's status. */
  guestsCanChangeStatus?: boolean;
}

/** Where a site's widget may run: its domain, and the exact addresses besides. */
export interface Addresses {
  domain: string | null;
  origins: string[];
}

/** `POST /api/v1/projects/{uid}/sessions/member` — the widget exchange's shape, plus the checked origin. */
export interface MemberSession {
  sessionToken: string;
  expiresAt: string;
  refreshableUntil: string;
  reviewer: { id: string; name: string; kind: "verified" };
  environment: { id: string; key: string; label: string };
  permissions: string[];
  origin: string;
  serverTime: string;
}

export interface Me {
  user: { email: string; name: string; role: "owner" | "admin" | "member" | "viewer" };
  org: { name: string; slug: string };
  /** Every studio this person belongs to; `current` marks the session's. */
  orgs: { slug: string; name: string; role: string; current: boolean }[];
  /** Whether this instance lets a signed-in person make another studio. */
  signupOpen: boolean;
  /** Migrations this build ships that the database has not run — empty when current. Optional: an older server omits it. */
  pendingMigrations?: string[];
  /** The server's functions and its database are in different regions. */
  regionMismatch?: { functions: string; database: string; suggest: string | null };
  /** The studio's limits: from its plan, a hand-set row, or unlimited (null). Reviewers are never counted. */
  limits: {
    projects: { limit: number | null; used: number };
    members: { limit: number | null; used: number };
    /** Bytes of pictures across the studio's sites, against the plan's number. */
    storage: { limit: number | null; used: number };
    screenshots: boolean;
    integrations: boolean;
    source: "resolver" | "stored" | "default";
  };
  projects: {
    uid: string;
    name: string;
    keyPrefix: string;
    writeMode: string;
    /** `paused` is the widget switched off. */
    status: "active" | "paused" | string;
    /** The site's domain, or null when it lives on exact addresses only. */
    domain: string | null;
    /** Whether guests may change a comment's status. Optional: an older server omits it. */
    guestsCanChangeStatus?: boolean;
    threads: number;
    unresolved: number;
    /** The newest screenshot on this site, as a blob URL — the site's face.
     *  Null until a snag has been filed, which the card shows as its own
     *  state rather than a broken image. */
    previewUrl: string | null;
    /** When a snag on this site last moved. Null when none ever has. */
    lastActivityAt: string | null;
    /** A domain or an exact address is set — false is the first run's cue. Optional: an older server omits it. */
    addressed?: boolean;
    /** The round Comments opens on (newest open, unarchived), null with none. Optional: an older server omits it. */
    landingRound?: number | null;
  }[];
}

/**
 * A comment, or the tombstone of one. A deleted comment comes back to the
 * studio (never to a reviewer) as `body: null` with `deletedAt` and the
 * author's NAME only — no id and no kind, which went with the words. So both
 * are optional here, and nothing may match "is this mine?" against a
 * tombstone's author.
 */
export interface Comment {
  id: string;
  body: string | null;
  createdAt: string;
  deletedAt?: string;
  author: { id?: string; name: string; kind?: string };
}

export interface Attachment {
  id: string;
  kind: string;
  contentType: string;
  width?: number;
  height?: number;
  url: string;
}

export interface Thread {
  id: string;
  key: string;
  status: "open" | "progress" | "review" | "resolved";
  anchor: Record<string, any>;
  anchorState: string;
  context: Record<string, any>;
  /** The thread's POSITION WITHIN its round — not the round's number (threads.round_number). */
  roundNumber: number;
  comments: Comment[];
  attachments?: Attachment[];
  route?: string;
  environment?: string;
  createdBy: { id?: string; name: string; kind: string };
  /** Who holds it — null when nobody; absent only on payloads older than. */
  assignee?: Assignee | null;
  /** Where it lives elsewhere: the GitHub issue, later Linear and Jira. */
  refs?: ExternalRef[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  commentCount: number;
}

/** A mirror of the thread in a tracker (external_refs). */
export interface ExternalRef {
  provider: "github" | "linear" | "slack" | "webhook" | string;
  kind: "issue" | "pr" | "message" | "attachment" | "delivery" | string;
  externalId: string;
  url: string;
  status: "synced" | "pending" | "failed" | "detached" | string;
}

/** The repository webhook to register by hand: the URL, and the secret shown once. */
export interface GitHubWebhook {
  url: string;
  secret: string;
}

/** A site's tracker connection (GitHub, Linear, Jira, Slack) — never a token. */
export type Tracker = "github" | "linear" | "jira" | "slack";
export const TRACKER_NAME: Record<Tracker, string> = { github: "GitHub", linear: "Linear", jira: "Jira", slack: "Slack" };
/** What a thread's mirror is called in each: an issue, or Slack's message. */
export const REF_KIND: Record<Tracker, "issue" | "message"> = { github: "issue", linear: "issue", jira: "issue", slack: "message" };
interface TrackerBase {
  site: string;
  siteName?: string;
  createOn: "manual" | "thread.created";
  health: "ok" | "needs_reauth" | "error" | string;
  lastError: string | null;
  updatedAt: string;
  hasWebhookSecret: boolean;
}
export interface GitHubIntegration extends TrackerBase {
  provider: "github";
  owner: string;
  repo: string;
  labels: string[];
}
export interface LinearIntegration extends TrackerBase {
  provider: "linear";
  teamKey: string;
  teamName: string;
}
export interface JiraIntegration extends TrackerBase {
  provider: "jira";
  siteUrl: string;
  projectKey: string;
  projectName: string;
  issueType: string;
  email: string;
}
export interface SlackIntegration extends TrackerBase {
  provider: "slack";
  teamName: string;
  teamUrl: string;
  channelId: string;
  channelName: string;
}
export type TrackerIntegration = GitHubIntegration | LinearIntegration | JiraIntegration | SlackIntegration;

/** One line of the studio's cross-site feed. */
export interface ActivityRow {
  id: string;
  key: string;
  status: string;
  route: string;
  site: { uid: string; name: string };
  environment: string;
  createdBy: { name: string; kind: string };
  assignee: string | null;
  commentCount: number;
  latest: { body: string | null; at: string | null; author: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

/** An agent's credential — never the token itself after the minute it is minted. */
export type McpScope = "threads:read" | "context:read" | "comments:write" | "threads:write" | "source:map";
export const MCP_SCOPES: { scope: McpScope; label: string; hint: string }[] = [
  { scope: "threads:read", label: "Read comments", hint: "What is broken, where, in which state — the brief." },
  { scope: "source:map", label: "Map to source", hint: "Search the checkout the agent runs in for the element. Local only." },
  { scope: "context:read", label: "Read capture context", hint: "Browser, viewport, console breadcrumbs — the personal-data-bearing half. Off by default." },
  { scope: "comments:write", label: "Reply as the agent", hint: "Post a comment under the token's name." },
  { scope: "threads:write", label: "Mark a fix ready", hint: "Move a comment to In review. An agent can propose, never resolve." },
];
export interface McpToken {
  id: string;
  name: string;
  prefix: string;
  scopes: McpScope[] | string[];
  /** May this token write over POST /mcp? Reads never needed it. */
  allowRemoteWrites: boolean;
  site: { uid: string; name: string } | null;
  createdBy: string | null;
  /** Owners may revoke any token, admins their own — decided by the server. */
  canRevoke: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

/** The assignee as the thread carries it. */
export interface Assignee {
  id: string;
  name: string;
  kind: string;
  /** A studio member, as opposed to somebody who commented. Grouping, not permission. */
  isTeam: boolean;
  /** An MCP agent's writer, listed apart from the people. */
  isAgent?: boolean;
}

/** A person in the pool — a `Reviewer` plus the two flags the menu groups by. */
export interface Reviewer extends Assignee {
  email?: string;
  avatarUrl?: string;
  isMe: boolean;
}

export interface Round {
  id: string;
  number: number;
  name: string;
  closed: boolean;
  closedAt?: string;
  /** Put away — out of the widget and the round menu, listed in Settings. */
  archived: boolean;
  archivedAt?: string;
  createdAt: string;
  threads: number;
  /** The safeguard, computed server-side per round. */
  unresolved: number;
}

export interface ThreadFilters {
  /** The previous response's `serverTime`. Never `Date.now()`. */
  since?: string;
  status?: string;
  route?: string;
  round?: number;
  q?: string;
}

/** The screen reads this shape from `reviewLinks.ts`'s `shape()`
 *  never a token. See `MintedLink` below for the one response that has one. */
export interface ReviewLink {
  id: string;
  roundId?: string;
  name: string;
  email?: string;
  environments: string[];
  permissions: string[];
  allowNameOverride: boolean;
  maxUses: number | null;
  useCount: number;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** The mint response only — the ONE response with a raw token on it. */
export interface MintedLink extends ReviewLink {
  token: string;
  fragment: string;
}

export const api = {
  me: () => call<Me>("GET", "/api/v1/me"),

  /**
   * Has anyone claimed this instance, and may a stranger make a studio here
   * ? Public by necessity — the shell cannot know whether to draw
   * setup or sign-in without asking, and an unclaimed instance showing a
   * sign-in form for an account that does not exist is the dead end this
   * replaces.
   */
  setupState: () => call<{ claimed: boolean; signup: boolean }>("GET", "/api/v1/setup"),
  /** A stranger's studio. The response sets the session cookies, like the claim. */
  register: (input: { email: string; password: string; name?: string; orgName?: string }) =>
    call<{ org: { name: string; slug: string }; user: { email: string; name: string }; csrfToken: string }>("POST", "/auth/register", input),
  /** Move this session to another studio the person belongs to. */
  switchOrg: (slug: string) => call<{ org: { name: string; slug: string }; role: string; csrfToken: string }>("POST", "/auth/switch", { slug }),
  /** Another studio for a signed-in person, who is moved to it. */
  createOrg: (name: string) => call<{ org: { name: string; slug: string }; csrfToken: string }>("POST", "/api/v1/orgs", { name }),

  /**
   * The claim. The response SETS the session cookies, so a successful
   * call leaves the browser signed in — there is no second login step, and
   * asking for the password again immediately after choosing it would read as
   * "that did not work".
   *
   * `token` is optional — empty means "no token", which an unclaimed
   * instance accepts. A token that IS sent must still be valid, so a stale one
   * pasted from an old boot is refused rather than silently ignored.
   */
  setup: (input: { token: string; orgName: string; projectName: string; email: string; password: string; address?: string }) =>
    call<{
      user: { email: string };
      project: { uid: string; name: string; keyPrefix: string };
      csrfToken: string;
    }>("POST", "/api/v1/setup", input),
  login: (email: string, password: string) =>
    call<{ user: { email: string; name: string }; csrfToken: string }>("POST", "/auth/login", { email, password }),
  logout: () => call<{ ok: true }>("POST", "/auth/logout"),
  /**
   * A widget session for a studio member, minted from this cookie for
   * the page the widget runs on. The server checks `origin` is the site's
   * and echoes it back; that echo is where the session may be posted.
   */
  memberSession: (uid: string, origin: string, environment?: string) =>
    call<MemberSession>("POST", `/api/v1/projects/${encodeURIComponent(uid)}/sessions/member`, {
      origin,
      ...(environment ? { environment } : {}),
    }),
  threads: (uid: string, f: ThreadFilters = {}) => {
    const q = new URLSearchParams();
    if (f.status) q.set("status", f.status);
    if (f.route) q.set("route", f.route);
    if (f.round) q.set("round", String(f.round));
    if (f.q) q.set("q", f.q);
    // The delta poll. `since` is ALWAYS the `serverTime` of the previous
    // response and never a clock this browser owns, and the server
    // takes it from Postgres for the same reason one layer down.
    if (f.since) q.set("since", f.since);
    const qs = q.toString();
    return call<{ data: Thread[]; deleted: string[]; serverTime: string }>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(uid)}/threads${qs ? `?${qs}` : ""}`,
    );
  },
  /**
   * Add a site. The dashboard had a project switcher and no way to add
   * anything to switch to.
   *
   * `origins` goes over as the comma-separated string the input holds, because
   * the server accepts either that or an array and there is no reason for two
   * clients to each own a splitting rule.
   */
  createProject: (name: string, origins: string, domain?: string) =>
    call<{ uid: string; name: string; origins: string[]; domain: string | null; warning?: string }>("POST", "/api/v1/projects", {
      name,
      origins,
      ...(domain ? { domain } : {}),
    }),
  /**
   * Who sees the toolbar. One knob, the existing one: `write_mode`.
   * `open` also clears the 24-hour grace timer server-side, because an owner
   * choosing "everyone" is the opposite of the forgetting that timer guards.
   */
  /**
   * Edit a site. Each field is optional and absent means unchanged, so this
   * one call covers the rename, the origin correction and the audience switch
   * without three endpoints. `origins` REPLACES the set — the only way to
   * correct a wrong address is to be able to remove it.
   */
  editSite: (uid: string, patch: SitePatch) =>
    call<{ uid: string; name: string; writeMode: string; origins: string[]; domain: string | null; status: string }>(
      "PATCH",
      `/api/v1/projects/${encodeURIComponent(uid)}`,
      patch,
    ),

  /** Soft. The site goes; the client's words stay, so a misclick is a row to
   *  restore rather than an apology to write. */
  deleteSite: (uid: string) =>
    call<void>("DELETE", `/api/v1/projects/${encodeURIComponent(uid)}`),

  setAudience: (uid: string, writeMode: "open" | "link-required") =>
    call<{ uid: string; writeMode: string }>("PATCH", `/api/v1/projects/${encodeURIComponent(uid)}`, {
      writeMode,
    }),

  origins: (uid: string) => call<Addresses>("GET", `/api/v1/projects/${encodeURIComponent(uid)}/origins`),
  addOrigin: (uid: string, origin: string) =>
    call<{ origins: string[] }>("POST", `/api/v1/projects/${encodeURIComponent(uid)}/origins`, { origin }),

  rounds: (uid: string) => call<{ data: Round[] }>("GET", `/api/v1/projects/${encodeURIComponent(uid)}/rounds`),
  createRound: (uid: string, name: string) =>
    call<Round>("POST", `/api/v1/projects/${encodeURIComponent(uid)}/rounds`, { name }),
  editRound: (id: string, patch: { name?: string; closed?: boolean; archived?: boolean }) =>
    call<Round>("PATCH", `/api/v1/rounds/${encodeURIComponent(id)}`, patch),
  /** File threads into another round (owner or admin). Keys are kept; numbers are the target's next. */
  moveThreads: (uid: string, ids: string[], round: number) =>
    call<{ moved: number; round: number }>("POST", `/api/v1/projects/${encodeURIComponent(uid)}/threads/move`, { ids, round }),
  /** The round and every thread in it, softly. `confirm` is its exact name; the server checks it again. */
  deleteRound: (id: string, confirm: string) =>
    call<{ id: string; deleted: true; threads: number }>("DELETE", `/api/v1/rounds/${encodeURIComponent(id)}`, { confirm }),
  setStatus: (uid: string, threadId: string, status: string) =>
    call<Thread>("PATCH", `/api/v1/projects/${encodeURIComponent(uid)}/threads/${encodeURIComponent(threadId)}`, {
      status,
    }),
  // The same PATCH, the other field; null un-assigns.
  setAssignee: (uid: string, threadId: string, assignee: string | null) =>
    call<Thread>("PATCH", `/api/v1/projects/${encodeURIComponent(uid)}/threads/${encodeURIComponent(threadId)}`, {
      assignee,
    }),
  assignees: (uid: string) =>
    call<{ data: Reviewer[]; total: number }>("GET", `/api/v1/projects/${encodeURIComponent(uid)}/assignees`),
  addAssignee: (uid: string, input: { name: string; email?: string }) =>
    call<Reviewer>("POST", `/api/v1/projects/${encodeURIComponent(uid)}/assignees`, input),
  // Endpoint 11's canonical (project-agnostic) form — a thread id
  // already implies its project, so this does not need `uid` at all, unlike
  // every other call above it.
  addComment: (threadId: string, body: string) =>
    call<Comment>("POST", `/api/v1/threads/${encodeURIComponent(threadId)}/comments`, {
      id: crypto.randomUUID(),
      body,
    }),
  /**
   * 05 endpoints 12 and 13. The dashboard is an OWNER, and the server's rule
   * for an owner is: delete any comment, edit only your own — rewriting
   * somebody else's words under their name is a forgery, not moderation.
   * Canonical unscoped paths, like `addComment`: a comment id already implies
   * its thread and project.
   */
  editComment: (commentId: string, body: string) =>
    call<Comment>("PATCH", `/api/v1/comments/${encodeURIComponent(commentId)}`, { body }),
  /** Answers the tombstone, not a 204, so the hole can be drawn without a refetch. */
  deleteComment: (commentId: string) =>
    call<{ id: string; deletedAt: string; body: null; author: { name: string } }>(
      "DELETE",
      `/api/v1/comments/${encodeURIComponent(commentId)}`,
    ),
  /** 05 endpoint 10, the studio's only for now. Soft on the server; 204 here. */
  deleteThread: (uid: string, threadId: string) =>
    call<void>("DELETE", `/api/v1/projects/${encodeURIComponent(uid)}/threads/${encodeURIComponent(threadId)}`),
  // The three review-link routes `reviewLinks.ts` already exposes.
  listLinks: (uid: string) =>
    call<{ data: ReviewLink[] }>("GET", `/api/v1/projects/${encodeURIComponent(uid)}/review-links`),
  mintLink: (uid: string, input: { name: string; expiresAt?: string; roundId?: string }) =>
    call<MintedLink>("POST", `/api/v1/projects/${encodeURIComponent(uid)}/review-links`, input),
  revokeLink: (id: string) => call<void>("DELETE", `/api/v1/review-links/${encodeURIComponent(id)}`),

  // Members — addressed by email, the one handle a user already has.
  members: () => call<{ data: Member[] }>("GET", "/api/v1/members"),

  // The trackers.
  integrations: () => call<{ data: TrackerIntegration[] }>("GET", "/api/v1/integrations"),
  siteIntegrations: (uid: string) => call<{ data: TrackerIntegration[] }>("GET", `/api/v1/projects/${encodeURIComponent(uid)}/integrations`),
  connectTracker: (
    uid: string,
    provider: Tracker,
    input:
      | { repository: string; token?: string; labels?: string; createOn: "manual" | "thread.created" }
      | { team: string; apiKey?: string; webhookSecret?: string; createOn: "manual" | "thread.created" }
      | { siteUrl: string; project: string; email: string; apiToken?: string; webhookSecret?: string; createOn: "manual" | "thread.created" }
      | { channel: string; token?: string; createOn: "manual" | "thread.created" },
  ) =>
    call<{ integration: TrackerIntegration; webhook?: GitHubWebhook | { url: string } }>(
      "PUT",
      `/api/v1/projects/${encodeURIComponent(uid)}/integrations/${provider}`,
      input,
    ),
  /** The manifest the operator creates the Slack app from, and the one-click link to do it. */
  slackManifest: () => call<{ manifest: Record<string, unknown>; url: string }>("GET", "/api/v1/integrations/slack/manifest"),
  /** A new GitHub webhook secret, shown once; the old one stops working. */
  regenerateGitHubWebhook: (uid: string) =>
    call<{ webhook: GitHubWebhook }>("POST", `/api/v1/projects/${encodeURIComponent(uid)}/integrations/github/webhook-secret`),
  disconnectTracker: (uid: string, provider: Tracker) =>
    call<{ integration: null }>("DELETE", `/api/v1/projects/${encodeURIComponent(uid)}/integrations/${provider}`),
  testTracker: (uid: string, provider: Tracker) =>
    call<{ ok: boolean; target?: string; detail?: string }>("POST", `/api/v1/projects/${encodeURIComponent(uid)}/integrations/${provider}/test`),
  createIssue: (uid: string, threadId: string, provider: Tracker) =>
    call<{ ref: ExternalRef }>("POST", `/api/v1/projects/${encodeURIComponent(uid)}/threads/${encodeURIComponent(threadId)}/integrations/${provider}`),

  // Everything that has happened, across every site.
  activity: (input: { status?: string; site?: string; q?: string; cursor?: string; limit?: number }) => {
    const p = new URLSearchParams();
    if (input.status) p.set("status", input.status);
    if (input.site) p.set("site", input.site);
    if (input.q) p.set("q", input.q);
    if (input.cursor) p.set("cursor", input.cursor);
    if (input.limit) p.set("limit", String(input.limit));
    const qs = p.toString();
    return call<{ data: ActivityRow[]; nextCursor: string | null; serverTime: string }>("GET", `/api/v1/activity${qs ? `?${qs}` : ""}`);
  },

  // The agent tokens, Studio › Integrations › MCP.
  mcpTokens: () =>
    call<{ data: McpToken[]; scopes: McpScope[]; defaults: McpScope[]; http: McpHttp }>("GET", "/api/v1/mcp-tokens"),
  mintMcpToken: (input: { name: string; site?: string; scopes: McpScope[]; expiresInDays?: number; allowRemoteWrites?: boolean }) =>
    call<{ token: McpToken; secret: string }>("POST", "/api/v1/mcp-tokens", input),
  revokeMcpToken: (id: string) => call<{ token: McpToken | null }>("DELETE", `/api/v1/mcp-tokens/${encodeURIComponent(id)}`),

  // The instance's address, set at claim, editable by an owner unless the environment holds it.
  setAddress: (url: string) => call<Instance>("PUT", "/api/v1/instance/address", { url }),
  clearAddress: () => call<Instance>("DELETE", "/api/v1/instance/address"),
  // The remote MCP transport's switch, an owner's unless the environment holds it.
  setMcpHttp: (enabled: boolean) => call<Instance>("PUT", "/api/v1/instance/mcp-http", { enabled }),
  clearMcpHttp: () => call<Instance>("DELETE", "/api/v1/instance/mcp-http"),

  // Studio › General's Storage and Mail rows.
  instance: () => call<Instance>("GET", "/api/v1/instance"),
  connectStorage: (input: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string; publicBaseUrl?: string }) =>
    call<Instance>("PUT", "/api/v1/instance/storage", input),
  disconnectStorage: () => call<Instance>("DELETE", "/api/v1/instance/storage"),
  connectMail: (input: { url: string; from: string }) => call<Instance>("PUT", "/api/v1/instance/mail", input),
  disconnectMail: () => call<Instance>("DELETE", "/api/v1/instance/mail"),
  testMail: () => call<{ to: string; id: string | null }>("POST", "/api/v1/instance/mail/test"),
  // People join through an invite link; the link is in the create response and nowhere else.
  invites: () => call<{ data: Invite[]; mail: boolean }>("GET", "/api/v1/members/invites"),
  createInvite: (input: { role: "owner" | "admin"; email?: string }) => call<MintedInvite>("POST", "/api/v1/members/invites", input),
  revokeInvite: (id: string) => call<{ data: Invite[] }>("DELETE", `/api/v1/members/invites/${encodeURIComponent(id)}`),
  /** The token goes back with it: the server keeps only a hash, so it can mail a link only when shown the one it minted. */
  sendInvite: (id: string, token: string) => call<{ to: string }>("POST", `/api/v1/members/invites/${encodeURIComponent(id)}/send`, { token }),
  /** Public. A POST, so the token travels in a body and never in a URL a log keeps. */
  lookupInvite: (token: string) => call<InviteLookup>("POST", "/auth/invites/lookup", { token }),
  acceptInvite: (input: { token: string; name?: string; email?: string; password: string }) =>
    call<{ org: { name: string; slug: string }; user: { email: string; name: string }; role: string; csrfToken: string }>("POST", "/auth/invites/accept", input),
  setMemberRole: (email: string, role: "owner" | "admin") =>
    call<{ data: Member[] }>("PATCH", `/api/v1/members/${encodeURIComponent(email)}`, { role }),
  removeMember: (email: string) => call<{ data: Member[] }>("DELETE", `/api/v1/members/${encodeURIComponent(email)}`),

  // The studio's name, your name, your password — account.ts.
  renameOrg: (name: string) => call<{ org: { name: string } }>("PATCH", "/api/v1/org", { name }),
  renameMe: (name: string) => call<{ user: { email: string; name: string; role: string } }>("PATCH", "/api/v1/me", { name }),
  changePassword: (current: string, next: string) => call<{ ok: true }>("POST", "/api/v1/me/password", { current, next }),

  // What is running — the version, the commit, the AGPL source offer. Public,
  // cached for the session: it changes when the operator upgrades, not before.
  meta: () => call<Meta>("GET", "/api/v1/meta"),
};

export interface Member {
  email: string;
  name: string;
  role: "owner" | "admin" | "member" | "viewer";
  createdAt: string;
  you: boolean;
}

/** A pending invite — never its token. */
export interface Invite {
  id: string;
  role: "owner" | "admin";
  /** Null when the invitee types their own. */
  email: string | null;
  createdAt: string;
  expiresAt: string;
  createdBy: { name: string; email: string } | null;
}

/** What minting one returns: the link, this once. `mail` says whether the instance can send it. */
export interface MintedInvite {
  invite: Invite;
  token: string;
  url: string;
  mail: boolean;
}

/** What the invite page is told about its link. */
export interface InviteLookup {
  org: { name: string };
  role: "owner" | "admin";
  email: string | null;
  invitedBy: string | null;
  expiresAt: string;
}

/** Whether POST /mcp is served, who decided, and where it is. */
export interface McpHttp {
  enabled: boolean;
  source: "env" | "stored" | "default";
  url: string;
}

/** What this instance is connected to — non-secret parts only, never a key. */
export interface Instance {
  /** What every link is built from: the environment's, the owner's, or this machine's. */
  address: {
    url: string;
    source: "env" | "stored" | "default";
    updatedAt: string | null;
  };
  /** The remote MCP transport: on or off, and whose call it was. */
  mcpHttp: {
    enabled: boolean;
    source: "env" | "stored" | "default";
    updatedAt: string | null;
  };
  storage: {
    source: "env" | "stored" | "none";
    connected: boolean;
    endpoint?: string;
    bucket?: string;
    region?: string;
    publicBaseUrl?: string;
    connectedAt: string | null;
    unreadable?: boolean;
  };
  mail: {
    source: "env" | "stored" | "none";
    configured: boolean;
    scheme?: string;
    host?: string;
    from?: string;
    updatedAt: string | null;
    unreadable?: boolean;
    reason?: string;
  };
}

export interface Meta {
  version?: string;
  commit?: string;
  sourceUrl?: string;
  modified?: boolean;
}
