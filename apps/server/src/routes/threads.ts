import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { THREAD_REF_PREFIX } from "@snagset/types/names";
import type { AddressSource } from "../instance/address.ts";
import { ID_PREFIX } from "@snagset/types/names";
import type { ProjectCache, ProjectRow } from "../projectCache.ts";
import type { SessionClaims } from "../session.ts";
import { csrfOk, type OwnerClaims } from "./owner.ts";
import type { McpClaims } from "./mcpToken.ts";
import { queueCommentNotice, queueResolvedNotice } from "../mail/notify.ts";
import { dropAssignedBy, queueAssignedNotice, type Actor } from "../mail/assigned.ts";
import { effectiveWriteMode } from "./sessions.ts";
import {
  mcpAllows,
  scopeDenied,
  checkWriteBudget,
  budgetExhausted,
  recordAgentWrite,
  agentReviewer,
} from "./mcpAuth.ts";
import { inPool } from "./assignees.ts";
import { briefMarkdown, type BriefThread } from "@snagset/types/brief";
import { queueIntegrationEvent } from "../integrations/outbox.ts";
import { inOrg } from "../db/scope.ts";
import { isStudioModerator } from "../studioReviewers.ts";

/**
 * The widget's routes, cut to what the walking skeleton needs:
 * read the project's config, list the threads on a route, create one.
 *
 * Everything here is PROJECT-SCOPED by uid (the route table)
 * and the uid is the only project identity a client ever sees: the
 * internal uuid never leaves the server.
 */

type Env = {
  Variables: {
    requestId: string;
    session?: SessionClaims;
    owner?: OwnerClaims;
    mcp?: McpClaims;
    /** Set by `corsForProjects` when the request carried an Origin header — /. */
    originAllowed?: boolean;
  };
};
type Ctx = Context<Env>;

/**
 * Wire id ⇄ row id, verbatim: *"id uuid PRIMARY KEY — client-minted
 * UUIDv7; wire form 'thr_…'"*.
 *
 * The row is a bare uuid so it indexes and joins as one; the prefixed form is
 * the identity everything OUTSIDE the database uses, because a bare uuid in a
 * webhook payload, a GitHub issue marker or a support ticket tells you nothing
 * about what you are looking at.
 *
 * Both directions live here rather than at each call site. The widget mints
 * the id, so the very first POST arrives prefixed, and a server that stores
 * only what it happens to strip is a server whose ids diverge by route.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rowId(wire: unknown, prefix: string): string | null {
  if (typeof wire !== "string") return null;
  const bare = wire.startsWith(prefix) ? wire.slice(prefix.length) : wire;
  return UUID.test(bare) ? bare.toLowerCase() : null;
}

const wireId_ = (row: string, prefix: string): string => prefix + row;

/**
 * The envelope. `details` was missing from this file's copy while
 * `comments.ts` had it, so every `field_not_permitted` here — including the
 * long-standing refusal to move a thread between rounds — shipped without the
 * `details.field` registers for that code. A client cannot mark the
 * offending input without it.
 */
function fail(c: Ctx, status: number, code: string, message: string, details?: unknown) {
  return c.json(
    { error: { code, message, ...(details ? { details } : {}), requestId: c.get("requestId") } },
    status as 400,
  );
}

/**
 * Every request runs inside a transaction with `app.org_id` set, which is what
 * makes the RLS policies do anything at all. It is set even where the
 * connecting role can bypass them — the day someone points DATABASE_URL
 * at a properly restricted role, every query here has to already be correct,
 * and a `SET LOCAL` added later would be added under incident conditions.
 */
// `inOrg` — the org-scoped transaction this file used to keep for itself — is `db/scope.ts`'s now, shared by every route.

/**
 * A thread's comments as the JSON array every read carries — and the ONE
 * place that decides what each audience gets. It was three copies (the list,
 * the detail and the PATCH response), and the team-only filter had to be
 * added to each by hand after a link session's list was caught carrying a
 * private reply: a rule answered in three places drifts.
 *
 * ── TEAM-ONLY ──
 *
 * A `private` reply is for the studio's eyes and never reaches a reviewer
 * session or an agent. The owner sees all of them.
 *
 * ── TOMBSTONES, FOR THE OWNER ONLY ──
 *
 * A deleted comment is a row with `body` NULL. Everyone else gets it filtered
 * out, as before — the widget drops it and has nothing to render a hole with.
 * The OWNER gets it as a tombstone, because the dashboard is where comments
 * are deleted and a moderated conversation must still read as one: "Ada —
 * comment deleted" between two replies says something happened; a reply
 * answering nothing says the tool lost it. Before this a deleted comment was
 * on the studio's screen as a tombstone exactly until the next poll replaced
 * the row, and then gone.
 *
 * The tombstone is the shape — id, NULL body, deletedAt, the author's
 * NAME only — plus `createdAt`, which leaves out and the studio needs:
 * a hole is placed in time by when it was written. `seq` stays server-side
 * for the reason, and the author's id and kind go with the words.
 */
function commentsJson(tx: postgres.TransactionSql, asOwner: boolean) {
  return tx`COALESCE(
    (SELECT json_agg(
              CASE WHEN cm.deleted_at IS NULL
                THEN json_build_object(
                  'id', cm.id, 'body', cm.body, 'createdAt', cm.created_at,
                  'author', json_build_object('id', cr.id, 'name', cr.name, 'kind', cr.kind))
                ELSE json_build_object(
                  'id', cm.id, 'body', NULL::text, 'createdAt', cm.created_at, 'deletedAt', cm.deleted_at,
                  'author', json_build_object('name', cr.name))
              END
              ORDER BY cm.seq)
       FROM comments cm JOIN reviewers cr ON cr.id = cm.author_id
      WHERE cm.thread_id = t.id
        ${asOwner ? tx`` : tx`AND cm.deleted_at IS NULL AND cm.private = false`}),
    '[]'::json)`;
}

export function threadRoutes(
  sql: postgres.Sql,
  /** The 10-second cache, not a fresh SELECT per handler. Every
   *  route here starts by resolving `{uid}`, and on a database one round trip
   *  away that lookup was costing more than the work it introduced. */
  projects: ProjectCache,
  /** A9b: `features` is derived SERVER-side from bucket presence and the
   *  widget renders from it. Injected rather than imported so this file does
   *  not need to know how storage is configured. */
  features: (orgId: string) => Promise<{ screenshots: boolean; uploads: boolean }>,
  /**
   * Is a mail transport configured ? Same gate `commentRoutes` takes,
   * and for the same reason: with no transport, the design wants notifications
   * "off and say so, rather than silently queueing" — rows that would otherwise
   * accumulate for the life of the install and arrive in one burst the day
   * somebody configures Resend.
   */
  notifications: () => Promise<boolean> = async () => false,
  /** Where this instance lives (SNAGSET_BASE_URL) — the brief's screenshot links are absolute. */
  baseUrl: AddressSource = async () => "http://localhost:8080",
  /**
   * The site's tracker connections — id, provider, and whether
   * issues are made on every new thread. Injected so this file never opens
   * a token; the worker does that.
   */
  trackers: (orgId: string, projectId: string) => Promise<{ id: string; provider: "github" | "linear" | "jira" | "slack"; createOn: "manual" | "thread.created" }[]> = async () => [],
  /** How long an assignment waits before its email (SNAGSET_ASSIGN_MAIL_DELAY_S). */
  assignDelayMs?: number,
): Hono<Env> {
  const app = new Hono<Env>();

  /** Resolve `{uid}`, and 404 rather than leak whether a uid exists. */
  const project = (uid: string): Promise<ProjectRow | null> => projects.get(uid);

  // NO CORS MIDDLEWARE HERE. It used to live in this group and it was a second
  // copy: `corsForProjects` is mounted at the app level (app.ts), which is the
  // only mounting that covers `sessionRoutes` too. The copy cost two queries a
  // request and, worse, ran AFTER the real one and overwrote
  // `Access-Control-Allow-Headers` with a hand-typed `content-type` — harmless
  // only because a preflight never reaches this far.

  /** What the widget reads at mount to know what this deployment can do. */
  app.get("/api/v1/projects/:uid/config", async (c) => {
    const p = await project(c.req.param("uid"));
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    c.header("x-snagset-config-version", String(p.config_version));
    c.header("ETag", `"${p.config_etag}"`);
    /**
     * CACHEABLE, briefly — the decision makes this the stub's visibility check, fetched
     * once per visitor per page-load-cluster rather than per page. 60 seconds:
     * long enough that a browsing session costs one request, short enough that
     * flipping the audience in the dashboard lands within a minute.
     */
    c.header("Cache-Control", "public, max-age=60");
    // Unconditionally, not only when the CORS middleware set it: a shared
    // cache that stored a no-Origin response WITHOUT Vary would replay the
    // full body to a stranger origin, and the split below would be theatre.
    c.header("Vary", "Origin");

    /**
     * The ORIGIN-AWARE BODY, finally conformed to — the maintainer's
     * question, verbatim: "the api gets the url that should be there and then
     * just validates in the frontend?" Which is this design: the server never
     * learns the page's URL (the browser sends only its origin, which CORS
     * needs anyway), it evaluates that origin against the allow-list it holds,
     * and ships the VERDICT — never the list, because the list is the
     * customer's own map of their staging hostnames and the uid needed to ask
     * for it is printed in their page source.
     *
     * A stranger origin still gets a 200 with the public subset (writeMode
     * included) rather than a 403: the fetch is also how the origin
     * suggestion is born, and the stub on an archive.org mirror needs a
     * readable "writable: false" to stay dormant — a CORS-omitted header would
     * do that too, but this route is public-read so the suggestion flow works.
     * `originAllowed` is absent (never false) when there is no Origin header:
     * same-origin pages and curl are not strangers.
     */
    // The switch, layer 6: a paused site is writable from
    // nowhere, and the stub reads `writable` and stays dormant. Said before
    // the origin verdict, because "switched off" is the more useful sentence.
    const paused = p.status !== "active";
    const writable = c.get("originAllowed") !== false && !paused;
    const base = {
      uid: p.uid,
      status: p.status,
      // A9b, and it is a fact about THIS instance rather than a constant:
      // derived from whether a bucket is connected. False hides the screenshot
      // control rather than offering one whose upload would fail — annotation
      // mode is a complete product, not a degraded one.
      features: await features(p.org_id),
      /**
       * EFFECTIVE, not the raw column — turns this field into the thing
       * that decides whether every visitor sees the toolbar, and the raw value
       * lies during the grace: a site 25 hours old still says `open` while
       * every write is already refused. The session route learned this first
       * (see effectiveWriteMode's own comment); the config route repeating the
       * raw column would show a toolbar nobody can type into.
       */
      writeMode: effectiveWriteMode(p, new Date()),
      writable,
    };
    if (!writable) return c.json({ ...base, reason: paused ? "project_paused" : "origin_not_allowed" });

    // T10/: the round HISTORY rides the config the widget already fetches
    // at mount, so the dock's selector costs no extra request. Behind the
    // origin split with `keyPrefix`: the least sensitive PRIVATE things
    // on the project, which is not the same as public. An ARCHIVED round is
    // left out: the studio put it away, and the selector is where it
    // would otherwise come back for every reviewer.
    const rounds = await inOrg(sql, p.org_id, (tx) => tx<{ number: number; name: string; closed: boolean }[]>`
      SELECT number, name, closed_at IS NOT NULL AS closed
      FROM rounds WHERE project_id = ${p.id} AND deleted_at IS NULL AND archived_at IS NULL
      ORDER BY number DESC
    `);
    return c.json({
      ...base,
      keyPrefix: p.key_prefix,
      rounds: rounds.map((r) => ({ number: r.number, name: r.name, closed: r.closed })),
    });
  });

  /**
   * The list, endpoint 7, which the route table marks **W/D**.
   *
   * ONE endpoint, TWO audiences, and the credential decides the scope. That is
   * the spec's design and not a shortcut: a dashboard is not a different kind
   * of reader, it is a reader with more of the project in view.
   *
   * | Caller           | Environment | Routes | Private | Order    |
   * |------------------|-------------|--------|---------|----------|
   * | reviewer session | the one asked for, else default | the one asked for | never | oldest first, so pins paint in creation order |
   * | owner cookie     | every one, unless asked | every one, unless asked | included | NEWEST first — an inbox is read from the top |
   *
   * A widget caller cannot reach the dashboard scope by asking: the branch is
   * on the credential, and an owner cookie cannot arrive from a reviewed site
   * in a readable way — `Access-Control-Allow-Credentials` is never set, so a
   * cross-origin credentialed read is refused by the browser whatever this
   * returns.
   *
   * `route` is the generated projection off the anchor, so filtering by
   * it is an index scan rather than a JSONB walk on every row.
   */
  app.get("/api/v1/projects/:uid/threads", async (c) => {
    const p = await project(c.req.param("uid"));
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    const route = c.req.query("route");
    const env = c.req.query("env");

    // The owner must own THIS project. A valid session for another org is not
    // a credential for this one, and `/api/v1/me` is scoped the same way.
    const owner = c.get("owner");
    const asOwner = !!owner && owner.orgId === p.org_id;

    /**
     * An MCP token with `threads:read` reads with the studio's
     * FILTERS but not the studio's PRIVACY, and the split is deliberate.
     *
     * Filters: an agent asked to "list the open snags on checkout" needs
     * `status`, `q` and every round, exactly as the dashboard has them.
     * Denying those would make `list_threads` return the latest open round of
     * the default environment and call it the project.
     *
     * Privacy: `private` threads and team-only replies stay OUT. The
     * scope table grants "list and read threads, comments, anchor state" and
     * says nothing about private, while the design is *scope
     * minimalism* and separates `context:read` precisely because the
     * personal-data-bearing half should not ride along by default. A team-only
     * note is the studio talking about the client; an agent that reads one and
     * quotes it into a pull request has published it.
     */
    const mcp = c.get("mcp");
    const asAgent = mcpAllows(mcp, p.org_id, "threads:read");
    const asStudio = asOwner || asAgent;

    // A token that presented itself and lacks the scope is REFUSED, not
    // quietly served the anonymous view. This route answers without any
    // credential at all (an `open` project's widget reads it that way), so the
    // silent path exists and is the wrong one here: an agent handed the
    // default environment's latest open round would report it as the project.
    // Better a sentence naming the missing scope than a confident short list.
    if (mcp && !asAgent) return scopeDenied(c, "threads:read");

    // The filters. `status` and `q` stay dashboard-only. `round` used to be
    // gated the same way (`asOwner ? …: null`), which is the bug: a
    // review-link session's `?round` was silently discarded and every reader
    // without an owner cookie saw every round's pins forever, including ones
    // long since closed. A reviewer session may now ask for a round exactly
    // like an owner can — a link pins the LANDING round, it does not imprison
    // the reviewer on it (plan T8 step 2).
    const status = asStudio ? c.req.query("status") : undefined;
    const requestedRound = Number(c.req.query("round")) || null;
    const q = asStudio ? (c.req.query("q") ?? "").trim() : "";
    /**
     * `?assignee=rev_…|unassigned` — the triage filter ("what has
     * nobody picked up"). `unassigned` is a word rather than an empty value
     * because `assignee=` with nothing after it is indistinguishable from an
     * absent parameter on the wire. Studio-only, like status and q: a filter
     * the widget does not draw.
     */
    const assigneeRaw = asStudio ? c.req.query("assignee")?.trim() : undefined;
    let assigneeFilter: string | null = null;
    if (assigneeRaw) {
      assigneeFilter = assigneeRaw === "unassigned" ? "unassigned" : rowId(assigneeRaw, ID_PREFIX.reviewer);
      if (!assigneeFilter) {
        return fail(c, 400, "validation_failed", "assignee must be a reviewer id (rev_…) or the word unassigned.");
      }
    }

    /**
     * `?since=` — the delta poll, and the whole realtime story.
     *
     * *"`GET …/threads?since=<iso>` returns everything with `updated_at >
     * since`, plus the `deleted[]` tombstone array. The client keeps
     * `serverTime` from the previous response as the next `since`, never its
     * own clock."*
     *
     * Without it the widget refetched every thread on every poll — correct,
     * and O(project) per reviewer per interval on the one route that runs
     * forever in a background tab.
     */
    /**
     * `?key=SN-14` — the server-side permalink, and the thing that makes
     * a shared link survive a round.
     *
     * `?snag_t=SN-14` resolves LOCALLY in the widget, against the list it
     * already holds. That list is round-scoped: a non-owner reader defaults to
     * the latest OPEN round. So a permalink to a thread from a closed round —
     * which is most permalinks anyone bothers to share, since they share the
     * ones that mattered — found nothing and showed F-the "we could not find
     * that comment". The thread was there the whole time, one round back.
     *
     * An exact match on `UNIQUE (project_id, key)`, so at most one row, and it
     * deliberately IGNORES the round and environment defaults: the caller
     * named a specific thread, which is a stronger statement of intent than
     * any default. Privacy is not ignored — a private thread is absent for a
     * non-owner, which reads as "no such key" rather than confirming it exists
     * (the rule for `GET /threads/{id}`).
     */
    const key = c.req.query("key")?.trim().toUpperCase();

    const sinceRaw = c.req.query("since");
    let since: Date | null = null;
    if (sinceRaw !== undefined) {
      const parsed = new Date(sinceRaw);
      if (Number.isNaN(parsed.getTime())) {
        return fail(
          c,
          400,
          "validation_failed",
          "`since` must be an ISO timestamp — pass back the `serverTime` from your last response.",
        );
      }
      since = parsed;
    }

    /**
     * ── WHY `visible` IS A COLUMN AND NOT A FILTER ──
     *
     * Acceptance A36: a thread the studio marks `private` must land
     * in the caller's `deleted[]` so a cached copy is DROPPED. With the
     * predicate in the WHERE clause the row simply stops being returned, which
     * is indistinguishable from "nothing changed" — the client keeps showing a
     * thread it should no longer have, forever, because a poll that returns
     * nothing is the normal case.
     *
     * Only the two genuine VISIBILITY conditions are computed. Status, search,
     * environment and round are FILTERS: status does not hide a thread, and a
     * thread can never change environment or round (`environment_id` is
     * set at creation and a thread never moves), so none of them can take a
     * client from seeing a thread to not seeing it.
     *
     * This block comment lives out here rather than inside the SQL because a
     * backtick inside a comment inside a template literal ENDS the template.
     * That has now cost this repository five separate debugging sessions, and
     * the two words `deleted[]` and `private` are unavoidable in the
     * explanation.
     */
    const rows = await inOrg(sql, p.org_id, async (tx) => {
      // Absent round query param: an OWNER still sees every round
      // (unchanged), but a non-owner reader defaults to the latest OPEN
      // round, so a fresh page load is -clean rather than showing a round
      // that closed weeks ago. Not an archived or deleted one either:
      // the same round a new thread would land in. The correlated subquery is
      // cheap — one project's round table is a handful of rows.
      //
      // ON A POLL the predicate moves into `visible`, like privacy does: a
      // thread the studio MOVED to another round has to come back as a
      // tombstone for the list it left, and a WHERE clause would only make it
      // vanish from the delta, so the old round's list kept showing it.
      const inRound = key
        ? null
        : requestedRound
          ? tx`rd.number = ${requestedRound}`
          : asStudio
            ? null
            : tx`rd.number = (
                SELECT number FROM rounds
                WHERE project_id = ${p.id} AND closed_at IS NULL
                  AND deleted_at IS NULL AND archived_at IS NULL
                ORDER BY number DESC LIMIT 1
              )`;
      return tx<Record<string, unknown>[]>`
        SELECT t.id, t.key, t.status, t.version, t.anchor, t.anchor_state, t.context, t.round_number,
               t.created_at, t.updated_at, t.resolved_at, t.comment_count_public,
               t.route, e.key AS environment_key, rd.number AS round, rd.name AS round_name,
               r.name AS created_by_name, r.kind AS created_by_kind, r.id AS created_by_id,
               ar.id AS assignee_id, ar.name AS assignee_name, ar.kind AS assignee_kind,
               (ar.user_id IS NOT NULL) AS assignee_is_team,
               COALESCE(
                 (SELECT json_agg(json_build_object(
                     'provider', x.provider, 'kind', x.kind, 'externalId', x.external_id, 'url', x.url, 'status', x.status)
                   ORDER BY x.synced_at)
                  FROM external_refs x
                  WHERE x.thread_id = t.id AND x.status <> 'detached'),
                 '[]'::json) AS refs,
               ${commentsJson(tx, asOwner)} AS comments,
               COALESCE(
                 (SELECT json_agg(json_build_object(
                     'id', a.id, 'kind', a.kind, 'contentType', a.content_type,
                     'width', a.width, 'height', a.height)
                   ORDER BY a.created_at)
                  FROM attachments a
                  WHERE a.thread_id = t.id AND a.deleted_at IS NULL AND a.state = 'bound'),
                 '[]'::json) AS attachments
               ,
               -- VISIBLE, computed rather than filtered. See the note above
               -- the query: a thread that becomes private must be TOMBSTONED,
               -- and a WHERE clause can only make it vanish.
               (t.deleted_at IS NULL AND ${asOwner ? tx`true` : tx`t.private = false`}
                AND ${since && inRound ? inRound : tx`true`}) AS visible
        FROM threads t
        JOIN reviewers r ON r.id = t.created_by
        -- The assignee, when there is one (05 section 6.4b). LEFT: most
        -- threads have nobody yet, and an inner join would hide them.
        LEFT JOIN reviewers ar ON ar.id = t.assignee_id
        JOIN environments e ON e.id = t.environment_id
        -- Joined for the round filter, and the join is the fix for a real
        -- trap: threads.round_number is the thread's position WITHIN its round
        -- (-- the number on the pin), while rounds.number is which
        -- round it is. Two different integers whose names differ by one word,
        -- and filtering on the first is how round=1 returned the single thread
        -- that happened to be first in its round.
        JOIN rounds rd ON rd.id = t.round_id
        WHERE t.project_id = ${p.id}
          -- On a POLL these two move into the visible column above, so a
          -- thread that just became invisible still comes back and can be
          -- tombstoned. On a full list they stay here, where they cost nothing.
          ${since ? tx`AND t.updated_at > ${since}` : tx`AND t.deleted_at IS NULL`}
          ${since || asOwner ? tx`` : tx`AND t.private = false`}
          -- KEY OVERRIDES EVERY OTHER FILTER, and that is the contract: the
          -- caller named one thread, which is a stronger statement of intent
          -- than any default or any filter left over in a URL. It returns that
          -- thread or nothing. Privacy is NOT overridden -- see the visible
          -- column above.
          AND ${
            key
              ? tx`t.key = ${key}`
              : env
                ? tx`e.key = ${env}`
                : asStudio
                  ? tx`true`
                  : tx`e.is_default`
          }
          ${key || !route ? tx`` : tx`AND t.route = ${route}`}
          ${key || !status ? tx`` : tx`AND t.status = ${status}::snag_thread_status`}
          ${
            key || !assigneeFilter
              ? tx``
              : assigneeFilter === "unassigned"
                ? tx`AND t.assignee_id IS NULL`
                : tx`AND t.assignee_id = ${assigneeFilter}::uuid`
          }
          -- The round, from inRound above: here on a full list, in the
          -- visible column on a poll.
          ${inRound && !since ? tx`AND ${inRound}` : tx``}
          ${
            q && !key
              ? tx`AND (t.key ILIKE ${"%" + q + "%"}
                     OR t.anchor_label ILIKE ${"%" + q + "%"}
                     OR EXISTS (SELECT 1 FROM comments cq
                                WHERE cq.thread_id = t.id AND cq.deleted_at IS NULL
                                  AND cq.body ILIKE ${"%" + q + "%"}))`
              : tx``
          }
        ORDER BY ${asStudio ? tx`t.created_at DESC` : tx`t.created_at`}
        LIMIT 200
      `;
    });

    // A NAMED environment that does not exist is an error, not an empty list.
    // The POST already refuses it; a GET that answers `[]` instead tells a host
    // with a typo in `data-snag-env` that their project is empty — which is the
    // same sentence a correctly-configured empty project gets, and the two are
    // very different problems.
    //
    // Checked only when the list came back EMPTY, because a row that came back
    // proves the environment exists. The check used to run first, on every
    // request, to answer a question the result already answers in the common
    // case — a round trip per page load for a typo nobody made.
    // Not on a poll: an empty delta is the normal case and says nothing about
    // whether the environment exists.
    if (!rows.length && env && !since) {
      const known = await inOrg(sql, p.org_id, (tx) => tx<{ id: string }[]>`
        SELECT id FROM environments
        WHERE project_id = ${p.id} AND key = ${env} AND deleted_at IS NULL
      `);
      if (!known.length) {
        return fail(
          c,
          400,
          "environment_not_found",
          `This project has no environment called "${env}". Check data-snag-env, or create it.`,
        );
      }
    }

    /**
     * `serverTime` comes from POSTGRES, not from this process.
     *
     * The client hands it straight back as the next `since`, and `since` is
     * compared against `updated_at`, which Postgres wrote with `now()`. Two
     * clocks, one comparison: if the app server ran even a second ahead of the
     * database, every thread updated inside that second would be skipped on the
     * next poll and never returned again — a permanently missing comment, on a
     * skew nobody would think to look for. The design says the client must never
     * use its own clock; the same argument applies one layer down.
     */
    const [clock] = await sql<{ now: Date }[]>`SELECT now() AS now`;

    // The tombstones. Ids only — the client already has these threads, and
    // a body would be handing back the private content that made it invisible.
    const visible = rows.filter((r) => r["visible"] !== false);
    const deleted = rows
      .filter((r) => r["visible"] === false)
      .map((r) => ID_PREFIX.thread + String(r["id"]));

    return c.json({
      data: visible.map(shape),
      nextCursor: null,
      deleted,
      serverTime: (clock?.now ?? new Date()).toISOString(),
    });
  });

  /**
   * Move threads to another round, the studio's filing act, and the
   * one exception to the "a thread never moves": automatic placement never
   * moves a thread; only this explicit move does. Owner or admin, from the
   * dashboard (cookie and CSRF pair, checked inline because the bearer
   * middleware owns this path for the widget).
   *
   * `{ ids: ["thr_…"], round: <number> }`. The target may be open or closed
   * — filing a stray comment into a finished round is a filing decision — but
   * not archived or deleted. One transaction: the target round's row is
   * locked, its `thread_seq` advanced by the number moving, and each thread
   * takes the next per-round number in creation order. The old round keeps
   * its gap (a number quoted in an email is never handed to another thread)
   * and the project-wide key is untouched, so every permalink still works.
   * `version` moves, so every open dashboard's poll drops the thread from
   * the round it left (the list's visible column) and shows it in the new one.
   * Threads already in the target, deleted, or not in this site are skipped.
   * No `events` row: status and assignee changes write none either.
   */
  app.post("/api/v1/projects/:uid/threads/move", async (c) => {
    const p = await project(c.req.param("uid"));
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    if (owner.orgId !== p.org_id || (owner.role !== "owner" && owner.role !== "admin")) {
      return fail(c, 403, "forbidden", "Only an owner or an admin can move comments between rounds.");
    }
    if (!csrfOk(c)) {
      return fail(c, 403, "csrf_failed", "That request could not be verified. Reload the dashboard and try again.");
    }
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown; round?: unknown } | null;
    const round = body?.round;
    const ids = Array.isArray(body?.ids) ? body.ids.map((w) => rowId(w, ID_PREFIX.thread)) : [];
    if (!ids.length || ids.length > 200 || ids.some((x) => !x)) {
      return fail(c, 400, "validation_failed", "ids must be 1 to 200 thread ids (thr_…).");
    }
    if (!(typeof round === "number" && Number.isInteger(round) && round > 0)) {
      return fail(c, 400, "validation_failed", "round must be a round number (1, 2, …).");
    }

    const out = await inOrg(sql, p.org_id, async (tx) => {
      const [target] = await tx<{ id: string; archived: boolean }[]>`
        SELECT id, archived_at IS NOT NULL AS archived FROM rounds
        WHERE project_id = ${p.id}::uuid AND number = ${round}::int AND deleted_at IS NULL
        FOR UPDATE
      `;
      if (!target) return "missing" as const;
      if (target.archived) return "archived" as const;
      const moving = await tx<{ id: string }[]>`
        SELECT id FROM threads
        WHERE id = ANY(${ids as string[]}::uuid[]) AND project_id = ${p.id}::uuid
          AND deleted_at IS NULL AND round_id <> ${target.id}::uuid
        ORDER BY created_at, id
        FOR UPDATE
      `;
      if (!moving.length) return 0;
      const [seq] = await tx<{ last: number }[]>`
        UPDATE rounds SET thread_seq = thread_seq + ${moving.length}::int, updated_at = now()
        WHERE id = ${target.id}::uuid
        RETURNING thread_seq AS last
      `;
      const first = seq!.last - moving.length;
      await tx`
        UPDATE threads t
           SET round_id = ${target.id}::uuid, round_number = ${first}::int + o.n::int,
               version = t.version + 1, updated_at = now()
          FROM unnest(${moving.map((m) => m.id)}::uuid[]) WITH ORDINALITY AS o(id, n)
         WHERE t.id = o.id
      `;
      return moving.length;
    });
    if (out === "missing") return fail(c, 404, "round_not_found", `This site has no round ${round}.`);
    if (out === "archived") {
      return fail(c, 409, "round_archived", "That round is archived. Restore it in Settings to move comments into it.");
    }
    return c.json({ moved: out, round });
  });

  /**
   * Create. The whole thing is one transaction because a thread
   * without its first comment is not a snag, it is a pin nobody can read.
   */
  app.post("/api/v1/projects/:uid/threads", async (c) => {
    const p = await project(c.req.param("uid"));
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");

    const session = c.get("session");
    if (!session) {
      return fail(c, 401, "unauthorized", "Open your review link, or reload the page, and try again.");
    }
    if (p.status !== "active") {
      // The switch is off — writes refused, reads work (layer 6).
      return fail(c, 403, "project_paused", "This site's widget is switched off. Its owner can switch it back on.");
    }
    if (!session.perm.includes("thread:create")) {
      // The matrix. A read-only session gets a sentence about permission,
      // not about authentication — they ARE signed in.
      return fail(c, 403, "forbidden", "This review link does not allow new comments.");
    }

    const body = (await c.req.json().catch(() => null)) as Record<string, any> | null;
    if (!body?.anchor || !body?.context) {
      return fail(c, 400, "validation_failed", "anchor and context are required.");
    }

    // Absent, not "production": the widget only knows an environment name if
    // the host put one on the script tag, and inventing one here would put a
    // comment in an environment the dashboard is not looking at.
    const envKey = typeof body.scope?.environment === "string" ? body.scope.environment : null;

    // The round the reviewer is LOOKING AT, by number (the only round
    // identity the widget holds). Rounds run side by side, so "the newest
    // open one" stopped being the right answer the day a studio kept its own
    // QA round going while the client's ran: a comment left while viewing
    // Internal QA belongs to Internal QA.
    const askedRound = body.scope?.round;
    if (askedRound !== undefined && askedRound !== null && !(Number.isInteger(askedRound) && askedRound > 0)) {
      return fail(c, 400, "validation_failed", "scope.round must be a round number (1, 2, …).");
    }
    const roundNo: number | null = typeof askedRound === "number" ? askedRound : null;

    // A client-minted id that is not a UUID is a bug in the client, not
    // something to paper over with a server-minted one: the widget's optimistic
    // copy would then be a different snag from the stored one. Parsed out here,
    // before a transaction is opened, so a malformed body costs no round trip.
    const threadId = body.id === undefined ? randomUUID() : rowId(body.id, ID_PREFIX.thread);
    if (!threadId) {
      return fail(c, 400, "validation_failed", `id must be a UUIDv7, optionally prefixed "${ID_PREFIX.thread}".`);
    }
    const commentBody = typeof body.comment?.body === "string" && body.comment.body ? body.comment.body : null;
    const commentId = rowId(body.comment?.id, ID_PREFIX.comment) ?? randomUUID();
    // The attachments uploaded moments ago, to be BOUND by the write below
    // Until that runs they are `pending` rows with no owner: The
    // CHECK forbids a bound attachment without exactly one of
    // thread_id/comment_id, which is what makes an orphan detectable rather
    // than merely unlikely. The bind is scoped to this project AND to rows
    // still pending, so a thread cannot adopt another project's picture or
    // steal one already bound elsewhere.
    const attachmentIds = (Array.isArray(body.attachments) ? body.attachments : [])
      .map((a: unknown) => rowId(typeof a === "string" ? a : (a as { id?: string })?.id, ID_PREFIX.attachment))
      .filter((x: string | null): x is string => Boolean(x));

    // THE AUTHOR IS THE BEARER'S `sub`, not anything in the body.
    //
    // This used to read `createdBy.holderSecret` off the request and mint a
    // reviewer from it — a second, weaker answer to "who is this?" sitting
    // beside the session that already answers it. The design is explicit that a
    // session's identity is decided at exchange and never taken from a request,
    // and leaving the body path in place would have meant a caller could author
    // as anyone by presenting a secret they had seen once.
    const reviewerId = session.sub;

    try {
      const created = await inOrg(sql, p.org_id, async (tx) => {
        /*
         * TWO statements, where there were eleven.
         *
         * Every one of them was a network round trip held open inside a
         * transaction, and the measurement that forced this was a database
         * moved from ap-southeast-1 to eu-west-2: 80 ms a trip became 270 ms,
         * and leaving one comment took 3.1 seconds of almost pure waiting. The
         * work never was the cost. The *count* was.
         *
         * What survives is the ORDER, because the order is load-bearing —
         * the allocation still row-locks the project before the insert
         * reads it, still serialises creation per project, and still yields a
         * gapless human id. A CTE does not relax that: data-modifying CTEs run
         * exactly once, to completion, and the insert that reads pseq/rseq
         * cannot begin before they have produced their rows.
         */
        /*
         * WHICH ROUND, in this order:
         *   1. the one asked for, when it is open and not archived -- and a
         *      409 when it is not, rather than a silent move elsewhere: the
         *      reviewer chose it, and a comment that lands somewhere else
         *      without a word is the bug parallel rounds exist to remove;
         *   2. else the review link's pinned round, when it is open;
         *   3. Else the newest open, unarchived round -- the original rule.
         * Still the same one statement: the environment and both candidates
         * come back together, and the choice is made below.
         */
        const [ctx] = await tx<{
          environment_id: string | null;
          asked_id: string | null;
          asked_open: boolean | null;
          round_id: string | null;
        }[]>`
          SELECT
            (SELECT id FROM environments
              WHERE project_id = ${p.id} AND deleted_at IS NULL
                AND ${envKey ? tx`key = ${envKey}` : tx`is_default`}
              LIMIT 1) AS environment_id,
            a.id AS asked_id,
            (a.closed_at IS NULL AND a.archived_at IS NULL) AS asked_open,
            COALESCE(
              ${
                session.lnk
                  ? tx`(SELECT rd.id FROM review_links rl JOIN rounds rd ON rd.id = rl.round_id
                         WHERE rl.id = ${session.lnk}::uuid AND rd.project_id = ${p.id}
                           AND rd.deleted_at IS NULL AND rd.archived_at IS NULL AND rd.closed_at IS NULL)`
                  : tx`NULL::uuid`
              },
              r.id
            ) AS round_id
          FROM (SELECT 1) one
          LEFT JOIN LATERAL (
            SELECT id FROM rounds
            WHERE project_id = ${p.id} AND deleted_at IS NULL AND closed_at IS NULL AND archived_at IS NULL
            ORDER BY number DESC LIMIT 1
          ) r ON true
          LEFT JOIN LATERAL (
            SELECT id, closed_at, archived_at FROM rounds
            WHERE project_id = ${p.id} AND deleted_at IS NULL AND number = ${roundNo ?? 0}::int
          ) a ON true
        `;
        // Kept as its own statement rather than folded into the write below,
        // because these two are the only failures a caller can act on and
        // the design gives them distinct codes. A single statement that inserted
        // nothing would have to report "something was missing".
        if (!ctx?.environment_id) {
          throw new HttpError(
            400,
            "environment_not_found",
            envKey
              ? `This project has no environment called "${envKey}".`
              : "This project has no default environment.",
          );
        }
        // Still holds whichever round is chosen: a thread belongs to the
        // round it was created in, and never moves.
        if (roundNo !== null && !ctx.asked_id) {
          throw new HttpError(409, "round_not_found", `This site has no round ${roundNo}. Reload to see its rounds.`);
        }
        if (roundNo !== null && !ctx.asked_open) {
          throw new HttpError(
            409,
            "round_closed",
            `Round ${roundNo} is closed, so it takes no new comments. Pick an open round, or leave the round out.`,
          );
        }
        const roundId = roundNo !== null ? ctx.asked_id : ctx.round_id;
        if (!roundId) throw new HttpError(409, "no_active_round", "This project has no open round.");

        const counted = commentBody === null ? 0 : 1;
        const [row] = await tx<Record<string, unknown>[]>`
          WITH pseq AS (
            UPDATE projects SET thread_seq = thread_seq + 1
            WHERE id = ${p.id}::uuid
            RETURNING thread_seq
          ),
          rseq AS (
            UPDATE rounds SET thread_seq = thread_seq + 1
            WHERE id = ${roundId}::uuid
            RETURNING thread_seq
          ),
          ins AS (
            INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                                 anchor, context, created_by, anchor_state,
                                 comment_count, comment_count_public)
            SELECT ${threadId}::uuid, ${p.org_id}::uuid, ${p.id}::uuid,
                   ${p.key_prefix}::text || '-' || pseq.thread_seq::text,
                   ${ctx.environment_id}::uuid, ${roundId}::uuid, rseq.thread_seq,
                   ${tx.json(body.anchor)}::jsonb, ${tx.json(body.context)}::jsonb,
                   ${reviewerId}::uuid, ${body.anchorState ?? "anchored"}::snag_anchor_state,
                   ${counted}::int, ${counted}::int
            FROM pseq, rseq
            RETURNING id, key, status, version, anchor, anchor_state, context, round_number,
                      created_at, updated_at, resolved_at, comment_count_public
          ),
          bound AS (
            UPDATE attachments
            SET thread_id = ${threadId}::uuid, state = 'bound', bound_at = now()
            WHERE id = ANY(${attachmentIds}::uuid[])
              AND project_id = ${p.id}::uuid AND state = 'pending' AND deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM ins)
            RETURNING id
          ),
          com AS (
            INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body)
            SELECT ${commentId}::uuid, ${p.org_id}::uuid, ${p.id}::uuid, ${threadId}::uuid, 1,
                   ${reviewerId}::uuid, ${commentBody}::text
            FROM ins WHERE ${commentBody}::text IS NOT NULL
            RETURNING id, body, created_at
          ),
          -- The author's row: seen now, and the counters the assignee pool
          -- reads (05 section 3.4, section 6.4b -- "everyone who has
          -- commented" is thread_count > 0 OR comment_count > 0). Until
          -- nothing moved thread_count at all, so a client whose only act
          -- was leaving a pin was invisible to the pool. ONE update: two
          -- data-modifying CTEs touching the same row in one statement is
          -- unsupported in Postgres and only one of them lands -- the first
          -- attempt at this was a second CTE, and it lost to this one.
          touched AS (
            UPDATE reviewers
            SET last_seen_at = now(),
                thread_count = thread_count + 1,
                comment_count = comment_count + ${counted}::int
            WHERE id = ${reviewerId}::uuid RETURNING id
          )
          SELECT ins.*, rv.id AS created_by_id, rv.name AS created_by_name, rv.kind AS created_by_kind,
                 COALESCE(
                   (SELECT json_agg(json_build_object(
                       'id', com.id, 'body', com.body, 'createdAt', com.created_at,
                       'author', json_build_object('id', rv.id, 'name', rv.name, 'kind', rv.kind)))
                    FROM com),
                   '[]'::json) AS comments
          FROM ins, reviewers rv
          WHERE rv.id = ${reviewerId}::uuid
        `;

        /**
         * THE STUDIO IS TOLD A SNAG EXISTS.
         *
         * `queueCommentNotice` was wired into the REPLY route and not into
         * this one, so the only comment that never generated mail was the
         * first one — the one that says a client found something. Paste the
         * tag, hand over the link, and the first you hear of a round is when
         * somebody replies to a comment you were never told about.
         *
         * Same topic and same dedupe key as a reply (`comment.created:<id>`),
         * because it IS a `comment.created` — the thread is the container, and
         * splitting it into a second topic would mean a second template, a
         * second subscription rule and two ways to be silent.
         *
         * In THIS transaction, like the reply's: a comment that commits
         * without its outbox row is a notification that never happens.
         *
         * A body-less thread queues nothing. There is no sentence to send, and
         * "somebody pinned something" is not worth an email.
         */
        if (commentBody && (await notifications())) {
          await queueCommentNotice(
            tx,
            {
              orgId: p.org_id,
              projectId: p.id,
              threadId,
              commentId,
              threadKey: String(row!["key"]),
              authorId: reviewerId,
              authorName: String(row!["created_by_name"] ?? "Someone"),
              body: commentBody,
              pageUrl: (body.context as { url?: string } | null)?.url ?? "",
            },
            randomUUID(),
          );
        }

        // A site whose tracker makes an issue on every new thread. Same
        // transaction as the thread, keyed on the thread, so a retried POST
        // cannot make a second issue.
        for (const link of await trackers(p.org_id, p.id)) {
          if (link.createOn !== "thread.created") continue;
          await queueIntegrationEvent(tx as postgres.TransactionSql, {
            orgId: p.org_id,
            projectId: p.id,
            integrationId: link.id,
            threadId,
            provider: link.provider,
            topic: "issue.create",
            version: 0,
          });
        }

        return row!;
      });

      c.header("x-snagset-config-version", String(p.config_version));
      return c.json(shape(created), 201);
    } catch (e) {
      if (e instanceof HttpError) return fail(c, e.status, e.code, e.message);

      /**
       * A RETRY IS NOT AN ERROR — the idempotency, by natural key.
       *
       * A double-tapped Send, or a reviewer on a train whose request landed
       * while their connection dropped before the response did, sends the same
       * body twice with the same CLIENT-MINTED id. Measured before this
       * existed: the first was `201`, the second was **`500 internal_error`**,
       * and the thread was in the database exactly once. So the snag was saved
       * and the person who wrote it was told it had failed — which on a flaky
       * connection is the moment they try again, or give up and stop using it.
       *
       * The id makes this decidable with no header and no client change: the
       * widget already mints it, so a second POST carrying an id we
       * already hold IS the same request. Returning what the first one created
       * is the whole of the fix.
       *
       * Caught rather than pre-checked, so the happy path costs nothing. A
       * SELECT before every insert would put a round trip on the hot write to
       * rule out something that almost never happens.
       */
      const code = (e as { code?: string })?.code;
      if (code === "23505") {
        const [existing] = await inOrg(sql, p.org_id, async (tx) =>
          tx<Record<string, unknown>[]>`
            SELECT t.id, t.key, t.status, t.version, t.anchor, t.anchor_state, t.context, t.round_number,
                   t.created_at, t.updated_at, t.resolved_at, t.comment_count_public,
                   t.route, e.key AS environment_key, rd.number AS round, rd.name AS round_name,
                   r.id AS created_by_id, r.name AS created_by_name, r.kind AS created_by_kind,
                   ar.id AS assignee_id, ar.name AS assignee_name, ar.kind AS assignee_kind,
                   (ar.user_id IS NOT NULL) AS assignee_is_team,
                   COALESCE(
                     (SELECT json_agg(json_build_object(
                         'provider', x.provider, 'kind', x.kind, 'externalId', x.external_id, 'url', x.url, 'status', x.status)
                       ORDER BY x.synced_at)
                      FROM external_refs x
                      WHERE x.thread_id = t.id AND x.status <> 'detached'),
                     '[]'::json) AS refs,
                   COALESCE(
                     (SELECT json_agg(json_build_object(
                         'id', c2.id, 'body', c2.body, 'createdAt', c2.created_at,
                         'author', json_build_object('id', cr.id, 'name', cr.name, 'kind', cr.kind))
                       ORDER BY c2.seq)
                      FROM comments c2 JOIN reviewers cr ON cr.id = c2.author_id
                      WHERE c2.thread_id = t.id AND c2.deleted_at IS NULL AND c2.private = false),
                     '[]'::json) AS comments
              FROM threads t
              JOIN reviewers r ON r.id = t.created_by
              LEFT JOIN reviewers ar ON ar.id = t.assignee_id
              JOIN environments e ON e.id = t.environment_id
              JOIN rounds rd ON rd.id = t.round_id
             WHERE t.id = ${threadId}::uuid
               -- AND ours. An id that belongs to another project is a genuine
               -- conflict, not a retry, and answering with somebody else's
               -- thread would be far worse than the 500 this replaces.
               AND t.project_id = ${p.id}::uuid
               AND t.deleted_at IS NULL
          `,
        );
        if (existing) {
          c.header("x-snagset-config-version", String(p.config_version));
          // 200, not 201: the second request created nothing. A client that
          // branches on the status learns the truth, and one that does not
          // gets the same body either way.
          return c.json(shape(existing), 200);
        }
      }
      throw e;
    }
  });

  /**
   * Status changes, endpoint 9, marked **W/D** like the list.
   *
   * IT SHIPPED WITH NO AUTHENTICATION CHECK AT ALL. Not a weak one — none: the
   * handler read the uid, read the body and wrote. `bearerAuth` was mounted on
   * this path, so a session was ATTACHED when one was presented, and nothing
   * ever asked whether one had been. Anybody who could reach the port could
   * resolve every comment in the project, which is the one write that makes a
   * reviewer's report disappear from the list the studio works from.
   *
   * Two credentials are legitimate here and they are checked separately: an
   * OWNER of this project's org, and a reviewer session carrying
   * `thread:resolve` (the matrix — it is in the default link grant, because
   * a client marking their own snag done is the loop the decision is built around).
   */
  /**
   * Endpoint 8 — one thread — and the brief: the same row as
   * `text/markdown` when the id ends in `.md`, for curl, an agent's shell or
   * a ticket body. The privacy rule is the list's: a private thread is absent
   * for a non-owner, which reads as "no such thread" rather than confirming
   * one exists, and team-only replies stay out of a client's copy.
   */
  app.get("/api/v1/projects/:uid/threads/:id", async (c) => {
    const p = await project(c.req.param("uid"));
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    const owner = c.get("owner");
    const session = c.get("session");
    const mcp = c.get("mcp");
    const asOwner = !!owner && owner.orgId === p.org_id;
    const asAgent = mcpAllows(mcp, p.org_id, "threads:read");
    if (mcp && !asAgent) return scopeDenied(c, "threads:read");
    if (!asOwner && !asAgent && !session) {
      return fail(c, 401, "unauthorized", "Open your review link, or reload the page, and try again.");
    }
    const raw = c.req.param("id");
    const wantMarkdown = raw.endsWith(".md");
    const threadRow = rowId(wantMarkdown ? raw.slice(0, -3) : raw, ID_PREFIX.thread);
    if (!threadRow) return fail(c, 404, "thread_not_found", "No such thread in this project.");

    const [row] = await inOrg(sql, p.org_id, async (tx) =>
      tx<Record<string, unknown>[]>`
        SELECT t.id, t.key, t.status, t.version, t.anchor, t.anchor_state, t.context, t.round_number,
               t.created_at, t.updated_at, t.resolved_at, t.comment_count_public,
               t.route, e.key AS environment_key, rd.number AS round, rd.name AS round_name,
               r.id AS created_by_id, r.name AS created_by_name, r.kind AS created_by_kind,
               ar.id AS assignee_id, ar.name AS assignee_name, ar.kind AS assignee_kind,
               (ar.user_id IS NOT NULL) AS assignee_is_team,
               COALESCE(
                 (SELECT json_agg(json_build_object(
                     'provider', x.provider, 'kind', x.kind, 'externalId', x.external_id, 'url', x.url, 'status', x.status)
                   ORDER BY x.synced_at)
                  FROM external_refs x
                  WHERE x.thread_id = t.id AND x.status <> 'detached'),
                 '[]'::json) AS refs,
               ${commentsJson(tx, asOwner)} AS comments,
               COALESCE(
                 (SELECT json_agg(json_build_object(
                     'id', a.id, 'kind', a.kind, 'contentType', a.content_type,
                     'width', a.width, 'height', a.height)
                   ORDER BY a.created_at)
                  FROM attachments a
                  WHERE a.thread_id = t.id AND a.deleted_at IS NULL AND a.state = 'bound'),
                 '[]'::json) AS attachments
          FROM threads t
          JOIN reviewers r ON r.id = t.created_by
          LEFT JOIN reviewers ar ON ar.id = t.assignee_id
          JOIN environments e ON e.id = t.environment_id
          JOIN rounds rd ON rd.id = t.round_id
         WHERE t.id = ${threadRow}::uuid
           AND t.project_id = ${p.id}::uuid
           AND t.deleted_at IS NULL
           AND ${asOwner ? tx`true` : tx`t.private = false`}
      `,
    );
    if (!row) return fail(c, 404, "thread_not_found", "No such thread in this project.");
    const shaped = shape(row);
    if (!wantMarkdown) return c.json(shaped);
    const md = briefMarkdown(shaped as unknown as BriefThread, { name: p.name, dashboardOrigin: await baseUrl() });
    return c.text(md, 200, { "content-type": "text/markdown; charset=utf-8" });
  });

  app.patch("/api/v1/projects/:uid/threads/:id", async (c) => {
    const p = await project(c.req.param("uid"));
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");

    const owner = c.get("owner");
    const session = c.get("session");
    const mcp = c.get("mcp");
    const asOwner = !!owner && owner.orgId === p.org_id;
    /**
     * `mark_ready` lands here — and this is the whole of an agent's
     * write surface on a thread, `threads:write`.
     *
     * *"an agent can propose, never dispose"*. There is
     * deliberately no tool that resolves a thread, and the refusal below is
     * where that is actually true rather than merely absent from a tool list:
     * an agent PATCHing `status: 'resolved'` on this route is refused even
     * holding `threads:write`. D1a — resolution is a human act, and a machine
     * that can set `resolved` can be talked into setting it on everything.
     */
    const asAgent = mcpAllows(mcp, p.org_id, "threads:write");
    if (mcp && !asAgent) return scopeDenied(c, "threads:write");
    if (!asOwner && !asAgent && !session) {
      return fail(c, 401, "unauthorized", "Open your review link, or reload the page, and try again.");
    }
    if (!asOwner && !asAgent && !session!.perm.includes("thread:resolve")) {
      return fail(c, 403, "forbidden", "This review link does not allow changing status.");
    }

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

    // A thread never moves BY ACCIDENT. Refused explicitly rather than
    // ignored, because a caller that sends `round` and gets a 200 will believe
    // it moved. Moving is a studio act with its own route (the
    // move below), which renumbers inside the target round; a PATCH field
    // would be a second, quieter way to do it. The `field_not_permitted`
    // is the registered code.
    for (const field of ["round", "roundId", "roundNumber"]) {
      if (body && field in body) {
        return fail(
          c,
          422,
          "field_not_permitted",
          "A comment's round is not changed here. The studio moves comments between rounds from the dashboard.",
          { field },
        );
      }
    }

    /**
     * `private`, and the write that makes `deleted[]` mean something.
     *
     * Studio-only, like the thread-level field it is: an owner always may, a
     * reviewer session needs the link permission that names it. The design is
     * explicit that this is `403 field_not_permitted` with `details.field`
     * rather than a silently ignored field, because a caller who sends
     * `private: true` and gets a 200 will believe the thread is private.
     */
    const wantsPrivate = typeof body?.private === "boolean" ? (body.private as boolean) : undefined;
    if (wantsPrivate !== undefined && !asOwner && !session?.perm.includes("thread:private")) {
      return fail(c, 403, "field_not_permitted", "This review link does not allow team-only threads.", {
        field: "private",
      });
    }
    if (wantsPrivate !== undefined && asAgent && !asOwner) {
      // An agent write is never laundered into a trust tier it did not
      // earn, and team-only is the studio's register.
      return fail(c, 403, "field_not_permitted", "An agent cannot make a thread team-only.", {
        field: "private",
      });
    }

    /**
     * `assignee`. A reviewer id from the pool, or null to
     * un-assign. Same register as `private`: the studio's own routing of
     * work, so an owner always may, a reviewer session needs the permission
     * that names it, and a refusal is `403 field_not_permitted` with
     * `details.field` rather than a silently dropped field — a client that
     * sends it and gets a 200 will believe the thread moved.
     */
    const hasAssignee = !!body && "assignee" in body;
    let assigneeRow: string | null | undefined;
    if (hasAssignee) {
      if (body!.assignee === null) {
        assigneeRow = null;
      } else {
        assigneeRow = rowId(body!.assignee, ID_PREFIX.reviewer);
        if (!assigneeRow) {
          return fail(c, 400, "validation_failed", "assignee must be a reviewer id (rev_…) or null.", {
            field: "assignee",
          });
        }
      }
      if (asAgent && !asOwner) {
        // Again: an agent proposes, never disposes
        // and handing a thread to a person is disposing of it.
        return fail(c, 403, "field_not_permitted", "An agent cannot assign a comment to someone.", {
          field: "assignee",
        });
      }
      if (!asOwner && !session?.perm.includes("thread:assign")) {
        return fail(c, 403, "field_not_permitted", "This review link does not allow assigning comments.", {
          field: "assignee",
        });
      }
    }

    const status = typeof body?.status === "string" ? body.status : undefined;
    // `private` alone is a valid patch — the status is only required when it is
    // the thing being changed.
    if (status === undefined && wantsPrivate === undefined && !hasAssignee) {
      return fail(c, 400, "validation_failed", "Send status, private, assignee, or any of them.");
    }
    if (status !== undefined && !["open", "progress", "review", "resolved"].includes(status)) {
      return fail(c, 400, "validation_failed", "status must be one of open, progress, review, resolved.");
    }
    /**
     * F-26's expected version, the "no silent overwrite".
     *
     * `threads.version` has been incremented on every write since 0001 and
     * READ by nothing: the column existed, the guarantee did not. Two studio
     * members with the same thread open both pressed Resolve and the second
     * write landed on top of the first without either of them learning that
     * the other had touched it.
     *
     * OPTIONAL, deliberately. A caller that sends no `version` is saying "I am
     * not editing a copy I read earlier" — the CLI, an agent acting on a fresh
     * read, a curl. Making it mandatory would break every existing caller to
     * protect a case they are not in, and the additive rule forbids
     * that. The dashboard and the widget send it because they ARE editing a
     * copy they read earlier, which is exactly the population F-26 is about.
     */
    const expected = typeof body?.version === "number" ? (body.version as number) : undefined;
    if (body && "version" in body && expected === undefined) {
      return fail(c, 400, "validation_failed", "version must be a number when sent.");
    }

    const threadRow = rowId(c.req.param("id"), ID_PREFIX.thread);
    if (!threadRow) return fail(c, 404, "thread_not_found", "No such thread in this project.");

    // The agent half of the two rules above, now that the status is known.
    if (asAgent && !asOwner) {
      if (status === "resolved") {
        return fail(
          c,
          403,
          "forbidden",
          "An agent may mark a snag ready for review, but not resolve it. " +
            "Whoever reported it decides when it is fixed — tell your user it is ready.",
        );
      }
      // The stop signal, spent before the write rather than after it.
      const spent = await checkWriteBudget(sql, mcp!.tokenId);
      if (spent !== null) return budgetExhausted(c);
    }
    /*
     * Returns the WHOLE thread, exactly as the list does.
     *
     * It used to return the updated columns and then fill the rest with
     * `{ comments: [], created_by_name: "" }` — placeholders for fields the
     * UPDATE had not selected. A caller merging that response into its list, as
     * any optimistic client will, replaced a real comment with an empty array
     * and a real author with nobody: resolving a snag in the dashboard made its
     * text disappear from the row until the next reload. A response that
     * carries a shape it does not mean is worse than one that carries less.
     *
     * One statement, because the alternative is an UPDATE and a SELECT and
     * this project has already paid for that lesson once today.
     */
    // Set by the transaction when F-26 fires. A flag rather than a sentinel
    // row, because "no row" already means 404 here and a conflict reported as
    // "no such thread" would send a client into a refetch loop for a thread
    // that is very much there.
    let conflict: number | undefined;
    // Set by the transaction when the candidate assignee is not in the pool.
    let badAssignee = false;
    // Read by the transaction when an assignee is being set.
    let previousAssignee: string | null = null;
    /**
     * The person pressing the button, as the assignment mail needs them:
     * never mailed about handing a snag to themselves, and — when they ARE
     * the assignee and move its status — the mail about it is dropped,
     * because they have plainly seen it. An agent is nobody here: it cannot
     * assign, and its `mark_ready` is not the assignee looking.
     */
    const actor: Actor | null = asOwner
      ? { userId: owner!.userId, email: owner!.email }
      : session && !asAgent
        ? { reviewerId: session.sub }
        : null;

    const [row] = await inOrg(sql, p.org_id, async (tx) => {
      /**
       * F-26's check, INSIDE the transaction and holding the row.
       *
       * `FOR UPDATE` is what makes this a guarantee rather than a narrower
       * race: read-then-write without the lock is the classic
       * check-then-act — two writers can both read version 3, both find it
       * matches, and both proceed. Locking the row serialises them, so the
       * second one reads 4 and is refused. The lock is released by the
       * transaction a few statements later either way.
       */
      if (expected !== undefined) {
        const [current] = await tx<{ version: number }[]>`
          SELECT version FROM threads
           WHERE id = ${threadRow}::uuid AND project_id = ${p.id}::uuid AND deleted_at IS NULL
           FOR UPDATE
        `;
        // A missing row is not a conflict — it is the 404 the outer code
        // already knows how to say, and reporting it as a conflict would send
        // a client into a refetch loop for a thread that is gone.
        if (current && current.version !== expected) {
          conflict = current.version;
          return [];
        }
      }

      /**
       * The candidate must be IN THE POOL — the predicate, shared with
       * the pool route — and in THIS project. Blocked and erased reviewers
       * keep the assignments they have but take no new ones; a guest who
       * never wrote is not assignable; a reviewer id from another project is
       * nobody at all.
       */
      if (assigneeRow) {
        const [ok] = await tx<{ id: string }[]>`
          SELECT r.id FROM reviewers r
           WHERE r.id = ${assigneeRow}::uuid AND r.project_id = ${p.id}::uuid AND ${inPool(tx)}
        `;
        if (!ok) {
          badAssignee = true;
          return [];
        }
        // Who held it BEFORE, under the row lock the UPDATE below would take
        // anyway: re-sending the assignee a thread already has is not a new
        // assignment, and must not be a second mail.
        const [was] = await tx<{ assignee_id: string | null }[]>`
          SELECT assignee_id FROM threads
           WHERE id = ${threadRow}::uuid AND project_id = ${p.id}::uuid
           FOR UPDATE
        `;
        previousAssignee = was?.assignee_id ?? null;
      }

      /**
       * Consequence TWO of three, and it runs before the CTE rather than
       * inside it.
       *
       * *"every comment on a thread becoming private is set `private = true` in
       * the same statement, since a public reply under a team-only thread is
       * unreachable content."* Unreachable, and therefore invisible to the
       * studio too — the reply route already forces `wantPrivate` when the
       * thread is private, so new replies are fine; these are the ones written
       * before the flip.
       *
       * A data-modifying CTE cannot see another sub-statement's writes, so
       * folding this into the CTE would have counted `comment_count_public`
       * against comments this statement was in the middle of hiding. Same
       * transaction, two statements, in the order the arithmetic needs.
       *
       * Making a thread public again deliberately does NOT un-private the
       * replies. "Share the thread" and "share what we said about it
       * internally" are different decisions, and conflating them is the
       * expensive direction to be wrong in.
       */
      if (wantsPrivate === true) {
        await tx`
          UPDATE comments SET private = true
           WHERE thread_id = ${threadRow}::uuid AND private = false AND deleted_at IS NULL
        `;
      }

      const updated = await tx<Record<string, unknown>[]>`
        WITH upd AS (
          UPDATE threads
          SET status = ${status === undefined ? tx`status` : tx`${status}::snag_thread_status`},
              resolved_at = ${
                status === undefined
                  ? tx`resolved_at`
                  : status === "resolved"
                    ? tx`now()`
                    : tx`NULL`
              },
              private = ${wantsPrivate === undefined ? tx`private` : tx`${wantsPrivate}`},
              assignee_id = ${
                assigneeRow === undefined ? tx`assignee_id` : assigneeRow === null ? tx`NULL` : tx`${assigneeRow}::uuid`
              },
              -- 05 section 6.4, consequence one of three: a private thread has
              -- no public replies to count, and a thread made public again
              -- counts only the replies that are themselves public.
              comment_count_public = ${
                wantsPrivate === undefined
                  ? tx`comment_count_public`
                  : wantsPrivate
                    ? tx`0`
                    : tx`(SELECT count(*)::int FROM comments c
                            WHERE c.thread_id = threads.id AND c.deleted_at IS NULL AND c.private = false)`
              },
              version = version + 1, updated_at = now()
          WHERE id = ${threadRow}::uuid AND project_id = ${p.id}::uuid AND deleted_at IS NULL
          -- EVERY changing column comes out of RETURNING, and that is the whole
          -- point. The first version returned only the id and re-read the row
          -- in the outer SELECT -- which reports the row as it was BEFORE this
          -- statement, because the sub-statements of a data-modifying CTE all
          -- see the snapshot the statement began with. It looked right on a
          -- first click and returned the PREVIOUS status on every one after:
          -- pressing Reopen answered "resolved". The joins below are safe
          -- precisely because this UPDATE does not touch what they read.
          RETURNING id, key, status, version, anchor, anchor_state, context, round_number,
                    created_at, updated_at, resolved_at, comment_count_public,
                    route, created_by, environment_id, assignee_id
        )
        SELECT t.id, t.key, t.status, t.version, t.anchor, t.anchor_state, t.context, t.round_number,
               t.created_at, t.updated_at, t.resolved_at, t.comment_count_public,
               t.route, e.key AS environment_key,
               r.name AS created_by_name, r.kind AS created_by_kind, r.id AS created_by_id,
               ar.id AS assignee_id, ar.name AS assignee_name, ar.kind AS assignee_kind,
               (ar.user_id IS NOT NULL) AS assignee_is_team,
               COALESCE(
                 (SELECT json_agg(json_build_object(
                     'provider', x.provider, 'kind', x.kind, 'externalId', x.external_id, 'url', x.url, 'status', x.status)
                   ORDER BY x.synced_at)
                  FROM external_refs x
                  WHERE x.thread_id = t.id AND x.status <> 'detached'),
                 '[]'::json) AS refs,
               ${commentsJson(tx, asOwner)} AS comments,
               COALESCE(
                 (SELECT json_agg(json_build_object(
                     'id', a.id, 'kind', a.kind, 'contentType', a.content_type,
                     'width', a.width, 'height', a.height)
                   ORDER BY a.created_at)
                  FROM attachments a
                  WHERE a.thread_id = t.id AND a.deleted_at IS NULL AND a.state = 'bound'),
                 '[]'::json) AS attachments
        FROM upd t
        JOIN reviewers r ON r.id = t.created_by
        LEFT JOIN reviewers ar ON ar.id = t.assignee_id
        JOIN environments e ON e.id = t.environment_id
      `;

      /**
       * `thread.resolved` — B2's second topic, queued in the SAME transaction
       * as the status change, so a resolve that commits without its
       * notification is impossible and a notification about a resolve that
       * rolled back cannot exist.
       *
       * Only on the transition INTO `resolved`, and only when a mail transport
       * is configured. `progress` and `review` are working states the studio
       * moves through on its own; mailing on each would train people to filter
       * the sender before the one message that matters arrives.
       */
      if (status === "resolved" && updated?.[0] && (await notifications())) {
        const t = updated[0] as Record<string, unknown>;
        await queueResolvedNotice(tx, {
          orgId: p.org_id,
          projectId: p.id,
          threadId: threadRow,
          threadKey: String(t["key"] ?? ""),
          version: Number(t["version"] ?? 0),
          // A reviewer resolving their own snag should not be mailed about
          // it. An OWNER resolving from the dashboard has no reviewer row in
          // scope here, and `threadRow` is a uuid that matches no reviewer —
          // so it excludes nobody, which is the right answer: everyone who
          // took part hears that the studio closed it.
          actorId: session?.sub ?? threadRow,
          actorName: asOwner ? "The studio" : "Someone",
          pageUrl: String((t["context"] as Record<string, unknown> | null)?.["url"] ?? ""),
        });
      }

      /**
       * "this snag is yours now", an hour from now and only if it is
       * still true then (`mail/assigned.ts`). Queued here, in the transaction
       * that assigned it, like every outbox row; only when it is a NEW holder
       * and only when mail is configured at all (off and say so,
       * rather than rows that arrive in a burst the day somebody sets it up).
       */
      if (assigneeRow && assigneeRow !== previousAssignee && actor && updated?.[0] && (await notifications())) {
        const t = updated[0] as Record<string, unknown>;
        const actorName = asOwner
          ? owner!.name || owner!.email
          : ((
              await tx<{ name: string }[]>`SELECT name FROM reviewers WHERE id = ${session!.sub}::uuid`
            )[0]?.name ?? "Someone");
        await queueAssignedNotice(tx, {
          orgId: p.org_id,
          projectId: p.id,
          threadId: threadRow,
          threadKey: String(t["key"] ?? ""),
          version: Number(t["version"] ?? 0),
          assigneeId: assigneeRow,
          actor,
          actorName,
          ...(assignDelayMs !== undefined ? { delayMs: assignDelayMs } : {}),
        });
      }
      // …and the assignee moving the status themselves has seen it.
      if (status !== undefined && actor && updated?.[0]) {
        await dropAssignedBy(tx, threadRow, actor);
      }

      // Our status is canonical, the tracker's follows — queued here, in
      // the transaction that moved it, keyed on the version so every change
      // is one row. The worker maps by state type: resolved closes as
      // completed, anything else reopens; a thread with no issue is skipped.
      if (status !== undefined && updated?.[0]) {
        for (const link of await trackers(p.org_id, p.id)) {
          await queueIntegrationEvent(tx as postgres.TransactionSql, {
            orgId: p.org_id,
            projectId: p.id,
            integrationId: link.id,
            threadId: threadRow,
            provider: link.provider,
            topic: "issue.state",
            version: Number((updated[0] as Record<string, unknown>)["version"] ?? 0),
          });
        }
      }

      return updated;
    });
    /**
     * F-26, on the wire. 409 and not 412: `If-Match` semantics would make this
     * a header concern, and the design describes a product event ("someone else
     * updated this while you were typing") that the client renders with **Post
     * anyway** and **See what changed** — a conflict, not a failed
     * precondition. `currentVersion` rides along so the refetch has something
     * to compare against, and so a caller that legitimately wants to overwrite
     * can re-send with it — which IS "Post anyway", expressed on the wire.
     */
    if (badAssignee) {
      return fail(c, 400, "validation_failed", "That person cannot be assigned on this site — they are not in its pool.", {
        field: "assignee",
      });
    }
    if (conflict !== undefined) {
      return fail(
        c,
        409,
        "version_conflict",
        "Someone else updated this while you were working on it. Reload to see their change, then try again.",
        { currentVersion: conflict, sentVersion: expected },
      );
    }
    if (!row) return fail(c, 404, "thread_not_found", "No such thread in this project.");

    /**
     * Every agent write lands in `events` with the
     * reviewer id and the token id.
     *
     * A SECOND transaction, and this is the one place that is not ideal: the
     * UPDATE above is a single self-contained statement inside `inOrg`, and
     * threading the audit insert into it would mean restructuring a CTE whose
     * comment block records what happened the last time someone did. The
     * budget stays sound either way — it counts events, so an audit row that
     * fails to write makes the budget stricter, never looser. A status change
     * that commits without its audit row is a real gap; it is a smaller one
     * than re-opening that CTE, and `mark_ready` is idempotent.
     */
    if (asAgent && !asOwner) {
      await inOrg(sql, p.org_id, async (tx) => {
        const reviewerId = await agentReviewer(tx, {
          orgId: p.org_id,
          projectId: p.id,
          tokenId: mcp!.tokenId,
          tokenName: mcp!.name,
        });
        await recordAgentWrite(tx, {
          orgId: p.org_id,
          projectId: p.id,
          type: "thread.status_changed",
          subjectType: "thread",
          subjectId: String(row["id"]),
          reviewerId,
          tokenId: mcp!.tokenId,
        });
      });
    }

    return c.json(shape(row));
  });

  /**
   * 05 endpoint 10 — deleting a whole thread, project-scoped like the PATCH
   * above. The studio, any thread; a reviewer, their own.
   *
   * The matrix gives a reviewer "own only", behind the link permission
   * `thread:delete:own` — on by default since 0.1.14 for guests and new
   * links, because the widget offered Delete on a reviewer's own snag and
   * this route refused it. "Own" is narrower than "opened": every live
   * comment in the thread must be theirs, so nobody's reply goes with it.
   * An agent is still refused (an agent proposes, never
   * disposes, and deleting is the most disposing act there is).
   *
   * ── SOFT, LIKE A SITE ──
   *
   * `threads.deleted_at` has been on the row since 0001 and every read
   * already filters on it: the list, the detail, Activity, the counts on
   * Sites and on rounds, MCP (which reads through the list and the detail),
   * the integrations worker and the inbound webhooks. So the delete is one
   * column, and an operator who deletes the wrong thread has a row to
   * restore. `version` and `updated_at` move with it so a `?since=` poll —
   * every other open dashboard, every reviewer's widget — gets the id in
   * `deleted[]` and drops its copy, rather than showing a thread that
   * is gone until somebody reloads.
   *
   * ── THE COMMENTS ARE LEFT ALONE, DELIBERATELY ──
   *
   * Not tombstoned. Every comment read reaches its comments THROUGH the
   * thread (the reads above, Activity, the outbox's brief) and filters the
   * thread's `deleted_at`; the two comment routes that address a comment by
   * its own id (commentEdit.ts) answer 404 once its thread is deleted. So
   * tombstoning them would hide nothing more today, and it would make the
   * delete irreversible — the tombstone NULLs the body, and a restored
   * thread with every word gone is not a restore. The counters stay as they
   * are for the same reason.
   *
   * ── WHAT ELSE GOES WITH IT ──
   *
   *   · Its attachments get `deleted_at`, so the blob route stops serving the
   *     screenshot and Sites stops using it as the card's face. The BYTES stay
   *     in the bucket and `storage_bytes_used` is not decremented: no job
   *     collects soft-deleted attachments yet (the reaper only orphans
   *     never-bound uploads), and the counter is the bucket's truth, not the
   *     rows'. Collecting them is a reaper step that does not exist.
   *   · Its PENDING outbox rows are dropped — a "new reply" mail still inside
   *     its debounce window would otherwise go out quoting a thread the studio
   *     just removed, because the mail worker sends the body it was queued
   *     with and never looks back at the thread. A tracker row would be
   *     dropped by its worker anyway ("the thread is gone"); dropping it here
   *     says so in one place. Rows already in flight are left to finish.
   *   · Linked issues in GitHub, Linear, Jira or Slack are NOT touched. The
   *     `thread.deleted` event is not built, and closing a developer's issue
   *     because a comment was moderated is not obviously what anyone wants.
   *     An inbound webhook for that issue finds no thread and is ignored.
   *
   * ── IDEMPOTENT ──
   *
   * 204 for a thread that is already deleted, like deleting a comment twice:
   * two studio members tidying the same inbox, or one double click on a slow
   * connection, got what they asked for. 404 only for an id that was never a
   * thread in this project.
   */
  app.delete("/api/v1/projects/:uid/threads/:id", async (c) => {
    const p = await project(c.req.param("uid"));
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");

    const owner = c.get("owner");
    const session = c.get("session");
    const mcp = c.get("mcp");
    const asOwner = !!owner && owner.orgId === p.org_id;
    const threadRow = rowId(c.req.param("id"), ID_PREFIX.thread);
    if (!asOwner) {
      if (!owner && !session && !mcp) {
        return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
      }
      /**
       * A REVIEWER may delete a thread they started while nobody has answered
       * it — every live comment in it theirs. The widget offered Delete on a
       * reviewer's own snag and this route refused it, so "I pinned the wrong
       * thing" had no way out but asking the studio. Once someone else has
       * replied, deleting it would delete their words, so it stays the
       * studio's call (an Edit is still theirs, commentEdit.ts).
       */
      if (session && !owner && threadRow) {
        if (!session.perm.includes("thread:delete:own")) {
          return fail(c, 403, "forbidden", "Your review link does not allow deleting comments.");
        }
        // A studio owner or admin signed in from the widget deletes
        // any thread, as in the dashboard.
        const moderator = await inOrg(sql, p.org_id, (tx) => isStudioModerator(tx, p.org_id, session.sub));
        const [t] = moderator ? [{ all_mine: true, any: true }] : await inOrg(sql, p.org_id, (tx) => tx<{ all_mine: boolean; any: boolean }[]>`
          SELECT bool_and(c.author_id = ${session.sub}::uuid) AS all_mine, count(c.id) > 0 AS any
            FROM threads t
            JOIN comments c ON c.thread_id = t.id AND c.deleted_at IS NULL
           WHERE t.id = ${threadRow}::uuid AND t.project_id = ${p.id}::uuid AND t.deleted_at IS NULL
        `);
        if (!t?.any || !t.all_mine) {
          return fail(c, 403, "forbidden", "You can delete a comment you started until someone replies to it.");
        }
      } else {
        // An owner of ANOTHER org is told the same as a reviewer: this is not
        // theirs to delete. Not a 404 — the uid is public and resolves for
        // anyone, so pretending the project is absent would be a lie that
        // protects nothing.
        return fail(c, 403, "forbidden", "Only the studio can delete a comment thread.");
      }
    } else {
      // The matrix: member, admin and owner may; a viewer may not. Nobody
      // can be GIVEN a viewer seat yet (members.ts wires owner and admin only),
      // so this is the rule written down where it applies, before the day the
      // seat exists and every route has to be audited for it.
      if (owner!.role === "viewer") {
        return fail(c, 403, "forbidden", "A viewer cannot delete comments.");
      }
      // The owner cookie's half of `requireOwner()`, run inline — `bearerAuth`
      // is mounted on this path for the widget's reads, so the middleware
      // cannot be (the same arrangement as comments.ts and commentEdit.ts).
      // A bearer request carries no cookie and needs no CSRF check.
      if (!csrfOk(c)) {
        return fail(c, 403, "csrf_failed", "That request could not be verified. Reload the dashboard and try again.");
      }
    }

    if (!threadRow) return fail(c, 404, "thread_not_found", "No such thread in this project.");

    const found = await inOrg(sql, p.org_id, async (tx) => {
      const gone = await softDeleteThreads(tx, p.id, { thread: threadRow }, "the thread was deleted");
      if (!gone) {
        // Already deleted, or never here. Only the second is an error.
        const [was] = await tx<{ id: string }[]>`
          SELECT id FROM threads WHERE id = ${threadRow}::uuid AND project_id = ${p.id}::uuid
        `;
        return !!was;
      }
      return true;
    });
    if (!found) return fail(c, 404, "thread_not_found", "No such thread in this project.");
    return c.body(null, 204);
  });

  return app;
}

/**
 * The thread DELETE's work, for one thread or for every live thread in a
 * round (the round delete) — one copy, so a round's threads go exactly the
 * way a single thread does and "what else goes with it" (the route's comment
 * above) is answered in one place. Inside the caller's transaction, which has
 * already set `app.org_id`. Returns how many threads it marked.
 *
 * `version` and `updated_at` move so a `?since=` poll tombstones each one;
 * attachments on the thread or its comments are marked; pending outbox rows
 * are dropped with `reason` in `last_error`. Comments are left alone, for the
 * reason given above.
 */
export async function softDeleteThreads(
  tx: postgres.TransactionSql,
  projectId: string,
  which: { thread: string } | { round: string },
  reason: string,
): Promise<number> {
  const gone = await tx<{ id: string }[]>`
    UPDATE threads
       SET deleted_at = now(), version = version + 1, updated_at = now()
     WHERE project_id = ${projectId}::uuid AND deleted_at IS NULL
       AND ${"thread" in which ? tx`id = ${which.thread}::uuid` : tx`round_id = ${which.round}::uuid`}
    RETURNING id
  `;
  if (!gone.length) return 0;
  const ids = gone.map((g) => g.id);
  // The thread's own pictures and any bound to its comments:
  // section A6 hangs an attachment off exactly one of the two.
  await tx`
    UPDATE attachments SET deleted_at = now()
     WHERE deleted_at IS NULL
       AND (thread_id = ANY(${ids}::uuid[])
            OR comment_id IN (SELECT id FROM comments WHERE thread_id = ANY(${ids}::uuid[])))
  `;
  await tx`
    UPDATE outbox
       SET status = 'dropped', last_error = ${reason}, completed_at = now()
     WHERE thread_id = ANY(${ids}::uuid[]) AND status = 'pending'
  `;
  return ids.length;
}

/**
 * Fields declared and assigned, NOT constructor parameter properties.
 *
 * The server runs under `node --experimental-strip-types`, which ERASES types
 * and transforms nothing. `constructor(readonly status: number)` is a
 * transform — it emits an assignment that is not in the source — so Node
 * refuses it outright (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) at import time,
 * long after tsc has said the file is fine. Same rule bars enums, namespaces
 * and decorators everywhere under `apps/server`.
 */
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Rows → the `Thread`. The shape the widget already renders, unchanged. */
function shape(r: Record<string, any>) {
  return {
    id: wireId_(r.id, ID_PREFIX.thread),
    key: r.key,
    projectId: undefined,
    status: r.status,
    anchor: r.anchor,
    anchorState: r.anchor_state,
    context: r.context,
    roundNumber: r.round_number,
    comments: (r.comments ?? []).map((c: Record<string, any>) => ({
      ...c,
      id: wireId_(c.id, ID_PREFIX.comment),
      // A tombstone's author is a name and nothing else (commentsJson), so
      // there is no id to prefix — and prefixing `undefined` would put the
      // string "rev_undefined" on the wire.
      author: c.author.id ? { ...c.author, id: wireId_(c.author.id, ID_PREFIX.reviewer) } : c.author,
    })),
    createdBy: {
      id: r.created_by_id ? wireId_(r.created_by_id, ID_PREFIX.reviewer) : undefined,
      name: r.created_by_name,
      kind: r.created_by_kind,
    },
    // ALWAYS present, null when nobody (05 section 6.4b): the dashboard
    // merges a PATCH response over its row with a spread, and a key that is
    // merely absent when un-assigned would leave the old name on the row.
    // Additive for the widget, which does not read it.
    assignee: r.assignee_id
      ? {
          id: wireId_(r.assignee_id, ID_PREFIX.reviewer),
          name: r.assignee_name,
          kind: r.assignee_kind,
          isTeam: !!r.assignee_is_team,
        }
      : null,
    // Where this thread lives elsewhere — the GitHub issue, later the
    // Linear and Jira ones. Always an array, so a merge can clear it.
    refs: (r.refs as Record<string, unknown>[] | null | undefined) ?? [],
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    // F-26's handle. On the LIST as well as the detail, because the dashboard
    // patches straight from a list row — an editor that has to fetch the
    // detail first just to learn the version would make every Resolve two
    // round trips.
    version: r.version,
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : undefined,
    commentCount: r.comment_count_public ?? 0,
    // Present on the LIST too, not only the detail: the dock draws a thumbnail
    // from it, and before this the picture reappeared only on the machine that
    // took it — everyone else saw a comment with no screenshot.
    ...(r.attachments?.length
      ? {
          attachments: (r.attachments as Record<string, any>[]).map((a) => ({
            ...a,
            id: wireId_(a.id, ID_PREFIX.attachment),
            // The proxy route, never a bucket URL: the key is a content hash
            // and the object is stored with `content-disposition: attachment`
            // from an origin nobody should be fetching directly.
            url: `/api/v1/attachments/${wireId_(a.id, ID_PREFIX.attachment)}/blob`,
          })),
        }
      : {}),
    // Dashboard-side grouping, and harmless to a widget that ignores them.
    ...(r.route !== undefined && r.route !== null ? { route: r.route } : {}),
    ...(r.environment_key ? { environment: r.environment_key } : {}),
    // `round` is WHICH round; `roundNumber` above is the thread's place inside
    // it. Both are on the wire because the dashboard groups by the first and
    // draws the second on the pin.
    ...(r.round !== undefined && r.round !== null ? { round: r.round, roundName: r.round_name } : {}),
  };
}

export const THREAD_KEY_PREFIX = THREAD_REF_PREFIX;
