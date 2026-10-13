import { Hono, type Context } from "hono";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type postgres from "postgres";
import { ID_PREFIX } from "@snagset/types/names";
import type { Keyring } from "../keys.ts";
import type { ProjectCache, ProjectRow } from "../projectCache.ts";
import { ProjectUnavailable } from "../projectCache.ts";
import { mintSession, verifySession, withinRefreshWindow, type Permission, type SessionKind, type Ttls } from "../session.ts";
import { inOrg } from "../db/scope.ts";
import { studioReviewerId } from "../studioReviewers.ts";
import { allowedOrigins, originPermitted } from "./cors.ts";
import { sameSite } from "../domain.ts";
import type { OwnerClaims } from "./owner.ts";

/**
 * `POST /api/v1/projects/{uid}/sessions`.
 *
 * *"This is the ONLY redemption endpoint. `POST /api/v1/sessions/redeem` does
 * not exist and never did."* One route mints, refreshes, and is the single
 * place a raw credential is ever presented — which is what makes the logging
 * rule below enforceable in one line rather than audited across a surface.
 */

type Env = { Variables: { requestId: string; owner?: OwnerClaims } };
type Ctx = Context<Env>;

export interface SessionDeps {
  sql: postgres.Sql;
  keys: Keyring;
  projects: ProjectCache;
  ttls: Ttls;
  now?: () => Date;
}

function fail(c: Ctx, status: number, code: string, message: string) {
  return c.json({ error: { code, message, requestId: c.get("requestId") } }, status as 400);
}

/** Every secret in this product: 32 bytes, unpadded base64url, 43 chars. The
 *  hash is taken over the string that arrived on the wire, never a re-decode. */
const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const mintSecret = (): string => randomBytes(32).toString("base64url");

/** `prj_…`/`rev_…` — the row id is bare, the wire form is prefixed. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function rowId(wire: unknown, prefix: string): string | null {
  if (typeof wire !== "string") return null;
  const bare = wire.startsWith(prefix) ? wire.slice(prefix.length) : wire;
  return UUID.test(bare) ? bare.toLowerCase() : null;
}

/** The default: what an ordinary client link may do. */
const CLIENT_PERMISSIONS: Permission[] = ["thread:create", "comment:create", "thread:resolve", "thread:delete:own"];

/**
 * The read-time downgrade. There is no jobs engine yet (
 * the reaper), so `write_mode = 'open'` past its `write_mode_downgrade_at`
 * is evaluated HERE, on every session mint, rather than flipped by a
 * background pass. When the `runDueJobs` lands it should ALSO persist the
 * downgrade (`UPDATE projects SET write_mode = 'link-required', … WHERE …`) so
 * this stays a fallback rather than the only enforcement — but a session
 * request must never trust a `write_mode` column that could be 24 hours
 * stale, which is why this function exists independently of that job.
 */
export function effectiveWriteMode(
  row: { write_mode: string; write_mode_downgrade_at: Date | null },
  at: Date,
): "open" | "link-required" | "verified-only" {
  if (
    row.write_mode === "open" &&
    row.write_mode_downgrade_at &&
    row.write_mode_downgrade_at.getTime() <= at.getTime()
  ) {
    return "link-required";
  }
  return row.write_mode as "open" | "link-required" | "verified-only";
}

/**
 * `perm` is computed ONCE, from the credential, here — the table.
 *
 * *"Nothing about visibility is ever taken from the request. Not a header, not
 * a query parameter, not a field on the body, not the reviewer's own claim
 * about themselves."* `thread:private` and `thread:assign` decide whether a
 * session sees team-only threads, so the only route by which a widget session
 * gets them is a review link whose stored `permissions` already contain them —
 * the "team link".
 */
function permissionsFor(kind: SessionKind, link: { permissions: string[] } | null): Permission[] {
  if (kind === "guest") return CLIENT_PERMISSIONS.filter((p) => p !== "thread:resolve");
  if (kind === "link" && link) {
    const stored = link.permissions.filter((p): p is Permission =>
      ["thread:create", "comment:create", "thread:resolve", "thread:delete:own", "thread:private", "thread:assign"].includes(p),
    );
    return stored.length ? stored : CLIENT_PERMISSIONS;
  }
  return CLIENT_PERMISSIONS;
}

/**
 * What a studio member signed in from the widget may do — the team
 * link's set, every permission there is. They are the studio: the
 * dashboard already shows them team-only threads and lets them assign, and a
 * widget that showed them less than the dashboard would be a second, smaller
 * idea of who they are.
 */
/** A silently-minted member session's absolute cap. */
const SILENT_CAP_S = 12 * 60 * 60;

const MEMBER_PERMISSIONS: Permission[] = [
  "thread:create",
  "comment:create",
  "thread:resolve",
  "thread:delete:own",
  "thread:private",
  "thread:assign",
];

/**
 * A browser origin as the widget's `location.origin` spells it — scheme,
 * host, optional port, nothing else — or null. Re-serialised through `URL`
 * and compared with what arrived, so `https://acme.com/` or
 * `https://acme.com@evil.test` is refused rather than normalised into
 * something that passes: the value is about to become a `postMessage`
 * target, and a target is exact or it is wrong.
 */
function canonicalOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return u.origin === raw.toLowerCase() ? u.origin : null;
}

interface LinkRow {
  id: string;
  round_id: string | null;
  /** The round the link's `round_id` points at, joined in below. `null`
   *  when `round_id` is null; never null when `round_id` is set, since a link
   *  cannot reference a deleted round (FK). */
  round_number: number | null;
  permissions: string[];
  environments: string[];
  allow_name_override: boolean;
  name: string;
  email: string | null;
  max_uses: number | null;
  use_count: number;
  expires_at: Date;
  revoked_at: Date | null;
}

export function sessionRoutes(deps: SessionDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { sql, keys, projects, ttls } = deps;
  const now = deps.now ?? (() => new Date());

  /** The environment a session is minted for: the named one, or the project's default. */
  const environmentOf = async (project: ProjectRow, envKey: string | null) => {
    const [environment] = await inOrg(sql, project.org_id, (tx) => tx<{ id: string; key: string; label: string }[]>`
      SELECT id, key, label FROM environments
      WHERE project_id = ${project.id} AND deleted_at IS NULL
        AND ${envKey ? tx`key = ${envKey}` : tx`is_default`}
      LIMIT 1
    `);
    return environment ?? null;
  };

  /**
   * The project, or the response that refuses it — shared by both routes
   * below, because "which project states mint a session" answered twice is
   * two answers.
   */
  const live = async (c: Ctx, uid: string): Promise<ProjectRow | Response> => {
    let project: ProjectRow | null;
    try {
      project = await projects.get(uid);
    } catch (e) {
      // Fail closed. A stale cache entry is a stale session_epoch, and that
      // means a revoked reviewer keeps working (projectCache.ts).
      if (e instanceof ProjectUnavailable) {
        c.header("Retry-After", "5");
        return fail(c, 503, "database_unavailable", "The server cannot reach its database right now.");
      }
      throw e;
    }
    if (!project) return fail(c, 404, "project_not_found", "No project with that uid.");

    // The codes, not the blanket 401: a paused project is 403 and a
    // disabled one 410 everywhere else in this API, and a client branches on
    // the status class. "Your token is wrong" and "this project is switched
    // off" are different problems with different next steps.
    if (project.status === "paused") {
      return fail(c, 403, "project_paused", "This project is paused. Its owner can resume it.");
    }
    if (project.status === "disabled" || project.status === "deleting") {
      return fail(c, 410, "project_disabled", "This project is no longer accepting comments.");
    }
    return project;
  };

  app.post("/api/v1/projects/:uid/sessions", async (c) => {
    const uid = c.req.param("uid");
    const project = await live(c, uid);
    if (project instanceof Response) return project;

    // Computed once, up front, from the row the cache just gave us — see
    // `effectiveWriteMode`'s own comment for why this can't wait for a reaper.
    const writeMode = effectiveWriteMode(project, now());

    const body = (await c.req.json().catch(() => null)) as Record<string, any> | null;
    if (!body) return fail(c, 400, "validation_failed", "A JSON body is required.");

    // And the shape of rule: a request that tries to grant itself
    // visibility is refused rather than ignored, because silently dropping the
    // field teaches the caller it worked.
    for (const forbidden of ["role", "isTeam", "includePrivate", "permissions", "perm"]) {
      if (forbidden in body || (body.identity && forbidden in body.identity)) {
        return fail(
          c,
          422,
          "field_not_permitted",
          `"${forbidden}" is not accepted here. What a session may see is decided by its credential, never by the request.`,
        );
      }
    }

    const bearer = /^Bearer (.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    const identity = body.identity as Record<string, any> | undefined;

    // ── REFRESH: a bearer and no identity. Silent, and the whole reason
    //    a reviewer is not asked to re-open their link four times an afternoon.
    if (bearer && !identity) {
      const v = await verifySession(keys, bearer, {
        projectUid: uid,
        expectedEpoch: project.session_epoch,
        allowExpired: true,
        absoluteTtlS: ttls.absoluteS,
        now,
      });
      if (!v.ok) {
        const code = v.reason === "session_revoked" ? "session_revoked" : "unauthorized";
        return fail(c, 401, code, "That session is no longer valid. Re-open your review link to continue.");
      }

      // A link session re-checks the link on refresh: revocation is
      // instant at exchange AND on every refresh, which is what bounds how long
      // a revoked link keeps working to one sliding window.
      let linkExpiresAt: number | undefined;
      if (v.claims.lnk) {
        const [link] = await inOrg(sql, project.org_id, (tx) => tx<{ expires_at: Date; revoked_at: Date | null }[]>`
          SELECT expires_at, revoked_at FROM review_links WHERE id = ${v.claims.lnk}
        `);
        if (!link || link.revoked_at || link.expires_at <= now()) {
          return fail(c, 401, "token_revoked", "This review link has been turned off.");
        }
        linkExpiresAt = Math.floor(link.expires_at.getTime() / 1000);
      }

      if (!withinRefreshWindow(v.claims, ttls, linkExpiresAt, now)) {
        return fail(c, 401, "session_expired", "This review session has reached its limit. Re-open your review link.");
      }

      /**
       * `in_studio` is the re-check, in the same round trip. A STUDIO
       * MEMBER'S widget session (`sub` a reviewer row with `user_id` set) is
       * only as good as the membership it was minted from: removed from the
       * studio, made a viewer, or their account deleted, and the next refresh
       * is refused rather than carrying them to the twelve-hour cap. Every
       * other reviewer has no `user_id` and passes on the first disjunct.
       */
      const [reviewer] = await inOrg(sql, project.org_id, (tx) => tx<
        { identity_valid_after: Date | null; in_studio: boolean }[]
      >`
        SELECT r.identity_valid_after,
               (r.user_id IS NULL OR EXISTS (
                  SELECT 1 FROM memberships m
                  JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
                  WHERE m.org_id = r.org_id AND m.user_id = r.user_id AND m.role <> 'viewer'
               )) AS in_studio
        FROM reviewers r WHERE r.id = ${v.claims.sub}
      `);
      if (reviewer?.identity_valid_after && v.claims.iat * 1000 < reviewer.identity_valid_after.getTime()) {
        return fail(c, 401, "session_revoked", "This reviewer has been signed out.");
      }
      if (reviewer && !reviewer.in_studio) {
        return fail(c, 401, "session_revoked", "This account is no longer a member of the studio.");
      }

      const minted = await mintSession(
        keys,
        {
          projectUid: uid,
          reviewerId: v.claims.sub,
          environmentKey: v.claims.env,
          kind: v.claims.kind,
          reviewLinkId: v.claims.lnk,
          permissions: v.claims.perm,
          sessionEpoch: project.session_epoch,
          // Carried forward — the cap does not slide (session.ts).
          sid: v.claims.sid,
          iat: v.claims.iat,
          ...(v.claims.iex ? { iex: v.claims.iex } : {}),
          ...(linkExpiresAt ? { linkExpiresAt } : {}),
        },
        ttls,
        now,
      );
      return c.json({
        sessionToken: minted.token,
        expiresAt: minted.expiresAt.toISOString(),
        refreshableUntil: minted.refreshableUntil.toISOString(),
        serverTime: now().toISOString(),
      });
    }

    if (!identity || typeof identity.kind !== "string") {
      return fail(c, 400, "validation_failed", "identity.kind is required (guest or link).");
    }
    if (identity.kind === "verified") {
      // The HMAC handshake is. Saying so beats a 500.
      return fail(c, 501, "not_implemented", "Verified identity is not available on this build yet.");
    }
    if (identity.kind !== "guest" && identity.kind !== "link") {
      return fail(c, 400, "validation_failed", `Unknown identity kind "${identity.kind}".`);
    }

    // ── the write-mode gate. This is what closed the hole: a project past
    //    `open`'s grace window (or minted `link-required`/`verified-only`)
    //    used to mint a guest session anyway, because nothing here ever read
    //    `write_mode`. `verified-only` is checked FIRST: neither a `guest`
    //    identity (no credential at all) nor a `link` identity is ever
    //    `verified`, so both must be refused before the guest/link check
    //    below gets a chance to mislabel a verified-only rejection as
    //    "get a link" (registers the two codes
    //    this way, and the table maps mode -> code the same way; a
    //    guest-first ordering here made a verified-only project answer
    //    guests with 403 link_required instead of verified_identity_required
    //    — a link would not have helped them). Only once verified-only is
    //    out of the way does a guest identity fall through to link_required
    //    for anything short of `open`.
    if (writeMode === "verified-only") {
      return fail(
        c,
        403,
        "verified_identity_required",
        "This project requires a verified identity to comment.",
      );
    }
    if (identity.kind === "guest" && writeMode !== "open") {
      return fail(
        c,
        403,
        "link_required",
        "This project needs a review link to comment. Ask the studio for one.",
      );
    }

    // ── The environment. Absent means the project's default (the widget only
    //    knows a name if the host put one on the script tag).
    const envKey = typeof body.environment === "string" && body.environment ? body.environment : null;
    const environment = await environmentOf(project, envKey);
    if (!environment) {
      return fail(
        c,
        400,
        "environment_not_found",
        envKey ? `This project has no environment called "${envKey}".` : "This project has no default environment.",
      );
    }

    // ── the validation table, IN ORDER.
    let link: LinkRow | null = null;
    if (identity.kind === "link") {
      if (typeof identity.token !== "string" || !identity.token) {
        return fail(c, 401, "token_invalid", "That review link is not valid.");
      }
      // Looked up BY HASH, so an unknown token and a wrong one take the same
      // path — there is no row to compare against and therefore nothing to
      // compare in variable time.
      // LEFT JOIN rounds so a round-pinned link can report the round
      // NUMBER (what a reviewer and the widget both mean by "round"), not
      // just its opaque id -- rounds.id never left the server before this.
      const [found] = await inOrg(sql, project.org_id, (tx) => tx<LinkRow[]>`
        SELECT rl.id, rl.round_id, rd.number AS round_number, rl.permissions, rl.environments,
               rl.allow_name_override, rl.name, rl.email,
               rl.max_uses, rl.use_count, rl.expires_at, rl.revoked_at
        FROM review_links rl
        LEFT JOIN rounds rd ON rd.id = rl.round_id
        WHERE rl.project_id = ${project.id} AND rl.token_hash = ${sha256(identity.token)}
      `);
      if (!found) return fail(c, 401, "token_invalid", "That review link is not valid.");
      if (found.revoked_at) return fail(c, 401, "token_revoked", "This review link has been turned off.");
      if (found.expires_at <= now()) {
        return fail(c, 401, "token_expired", "This review link has expired. Ask for a new one.");
      }
      if (!found.environments.includes("*") && !found.environments.includes(environment.key)) {
        return fail(c, 401, "token_wrong_environment", "This review link is not for this environment.");
      }
      link = found;
    }

    const kind: SessionKind = identity.kind;
    const permissions = permissionsFor(kind, link);

    // ── The reviewer.: the SERVER mints the holder secret and returns
    //    it once; later exchanges present it back.
    const presented = typeof identity.holderSecret === "string" ? identity.holderSecret : null;
    const presentedId = rowId(identity.holderId, ID_PREFIX.reviewer);
    let holderSecret: string | null = null;
    let reviewerId: string | null = null;
    let reviewerName: string;

    // `allow_name_override = false` ⇒ the link's own name is authoritative and
    // a typed one is silently IGNORED, never a 422: the reviewer then sees the
    // name they will be posting under rather than the one they asked for.
    const typedName = typeof identity.name === "string" ? identity.name.trim().slice(0, 80) : "";
    reviewerName = link && !link.allow_name_override ? link.name : typedName || link?.name || "Anonymous";

    if (presented && presentedId) {
      const [existing] = await inOrg(sql, project.org_id, (tx) => tx<{ id: string; name: string }[]>`
        SELECT id, name FROM reviewers
        WHERE id = ${presentedId} AND project_id = ${project.id}
          AND holder_secret_hash = ${sha256(presented)}
          AND blocked_at IS NULL AND erased_at IS NULL
      `);
      // "a mismatch does NOT error — it silently mints a new guest
      // identity, because a stale storage entry must never lock a reviewer
      // out." So this is an `if`, not a guard clause.
      if (existing) {
        reviewerId = existing.id;
        if (typedName && (!link || link.allow_name_override)) {
          await inOrg(sql, project.org_id, (tx) => tx`UPDATE reviewers SET name = ${reviewerName}, last_seen_at = now() WHERE id = ${reviewerId}`);
        } else {
          await inOrg(sql, project.org_id, (tx) => tx`UPDATE reviewers SET last_seen_at = now() WHERE id = ${reviewerId}`);
        }
      }
    }

    if (!reviewerId) {
      // The `max_uses` check happens HERE, not above, because it counts
      // PEOPLE: a holder who already has a row is readmitted even on an
      // exhausted link, and only a genuinely new person is refused.
      if (link && link.max_uses !== null && link.use_count >= link.max_uses) {
        return fail(c, 401, "token_exhausted", "This review link has reached its limit.");
      }

      holderSecret = mintSecret();
      const id = randomUUID();
      const inserted = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${project.org_id}, true)`;
        const rows = await tx<{ id: string }[]>`
          INSERT INTO reviewers (id, org_id, project_id, kind, name, email, review_link_id, holder_secret_hash)
          VALUES (${id}, ${project.org_id}, ${project.id}, ${kind}, ${reviewerName},
                  ${link?.email ?? null}, ${link?.id ?? null}, ${sha256(holderSecret!)})
          ON CONFLICT (project_id, review_link_id, holder_secret_hash) WHERE kind = 'link'
          DO NOTHING
          RETURNING id
        `;
        // Use_count increments ONLY on a returned id — that is what makes
        // it count people rather than exchanges. `last_used_at` rides along, so
        // an exchange is one extra statement rather than two.
        if (rows[0] && link) {
          await tx`
            UPDATE review_links SET use_count = use_count + 1, last_used_at = now() WHERE id = ${link.id}
          `;
        } else if (link) {
          await tx`UPDATE review_links SET last_used_at = now() WHERE id = ${link.id}`;
        }
        return rows[0]?.id ?? null;
      });
      reviewerId = inserted;

      if (!reviewerId) {
        // The conflict fired: this holder already has a row on this link.
        const [again] = await inOrg(sql, project.org_id, (tx) => tx<{ id: string }[]>`
          SELECT id FROM reviewers
          WHERE project_id = ${project.id} AND review_link_id = ${link?.id ?? null}
            AND holder_secret_hash = ${sha256(holderSecret!)} AND kind = 'link'
        `);
        reviewerId = again?.id ?? null;
        holderSecret = null;
      }
      if (!reviewerId) return fail(c, 500, "internal_error", "Could not create a reviewer.");
    }

    const linkExpiresAt = link ? Math.floor(link.expires_at.getTime() / 1000) : undefined;
    const minted = await mintSession(
      keys,
      {
        projectUid: uid,
        reviewerId,
        environmentKey: environment.key,
        kind,
        reviewLinkId: link?.id ?? null,
        permissions,
        sessionEpoch: project.session_epoch,
        ...(linkExpiresAt ? { linkExpiresAt } : {}),
      },
      ttls,
      now,
    );

    return c.json(
      {
        sessionToken: minted.token,
        expiresAt: minted.expiresAt.toISOString(),
        refreshableUntil: minted.refreshableUntil.toISOString(),
        reviewer: { id: ID_PREFIX.reviewer + reviewerId, name: reviewerName, kind },
        // Returned ONCE, on first creation of this person. Absent on
        // every later exchange, which is how the client knows to keep the one
        // it has.
        ...(holderSecret ? { holderSecret } : {}),
        environment,
        permissions,
        // `number` alongside `id` -- the widget stores the NUMBER beside
        // the bearer and passes `?round=<number>` on `GET …/threads`; the
        // internal `rounds.id` is never a query param anywhere in 05.
        ...(link?.round_id ? { round: { id: link.round_id, number: link.round_number } } : {}),
        serverTime: now().toISOString(),
      },
      201,
    );
  });

  /**
   * The member session itself, for an owner whose studio, role and origin the
   * caller has already checked — shared by the popup's route and the silent
   * one, so the two cannot drift into two ideas of what a member's
   * session is.
   */
  const mintMember = async (
    c: Ctx,
    owner: OwnerClaims,
    project: ProjectRow,
    uid: string,
    origin: string,
    envKey: string | null,
    /** The absolute cap for this session; the instance's, unless shorter. */
    capS: number = ttls.absoluteS,
  ): Promise<Response> => {
    const environment = await environmentOf(project, envKey);
    if (!environment) {
      return fail(
        c,
        400,
        "environment_not_found",
        envKey ? `This project has no environment called "${envKey}".` : "This project has no default environment.",
      );
    }

    const reviewer = await inOrg(sql, project.org_id, async (tx) => {
      const id = await studioReviewerId(tx, {
        orgId: project.org_id,
        projectId: project.id,
        userId: owner.userId,
        name: owner.name,
        email: owner.email,
      });
      const [row] = await tx<{ id: string; name: string }[]>`
        UPDATE reviewers SET last_seen_at = now() WHERE id = ${id}::uuid RETURNING id, name
      `;
      return row!;
    });

    const nowS = Math.floor(now().getTime() / 1000);
    const minted = await mintSession(
      keys,
      {
        projectUid: uid,
        reviewerId: reviewer.id,
        environmentKey: environment.key,
        kind: "verified",
        reviewLinkId: null,
        permissions: MEMBER_PERMISSIONS,
        sessionEpoch: project.session_epoch,
        iex: nowS + Math.min(capS, ttls.absoluteS),
      },
      ttls,
      now,
    );

    // The exchange's shape, so the widget stores it with the code it already
    // has — plus `origin`, the one the dashboard must post to, echoed from
    // the check above rather than re-derived on the page.
    return c.json(
      {
        sessionToken: minted.token,
        expiresAt: minted.expiresAt.toISOString(),
        refreshableUntil: minted.refreshableUntil.toISOString(),
        reviewer: { id: ID_PREFIX.reviewer + reviewer.id, name: reviewer.name, kind: "verified" as const },
        environment,
        permissions: MEMBER_PERMISSIONS,
        // Owners and admins may delete anyone's comment from the widget, as in
        // the dashboard — a hint for which controls to draw; the delete routes
        // read the membership themselves (isStudioModerator).
        moderator: owner.role === "owner" || owner.role === "admin",
        origin,
        serverTime: now().toISOString(),
      },
      201,
    );
  };

  /**
   * `POST /api/v1/projects/{uid}/sessions/member`, "Sign in with
   * Snagset".
   *
   * A studio member reviewing a client's site from the widget was asked for
   * a name and an email like any guest, and their comments landed under a
   * guest row that was not the one their dashboard replies used. The widget
   * cannot simply ask the dashboard who is signed in: the client's site is
   * on another domain, the dashboard cookie is first-party to the server,
   * and third-party cookies are not something to build on. So the widget
   * opens a popup on the dashboard, the dashboard asks the member to
   * confirm, and the page calls THIS route with the cookie it already has —
   * then posts the session to the opener at the exact origin checked here.
   *
   * DASHBOARD-CLASS, although it mints a widget credential: `requireOwner()`
   * is mounted in front of it (app.ts), so it takes the cookie AND the CSRF
   * pair, and a page the member merely visits cannot mint one with their
   * cookie — it can make the browser send the cookie, not read the CSRF half
   * to echo it. The confirm click is the other half: a popup that minted on
   * load would hand a session to any allow-listed page that opened one.
   *
   * THE ORIGIN IS CHECKED HERE, NOT TRUSTED FROM THE PAGE. It is where the
   * dashboard will `postMessage` the token, so it must be a page the widget
   * could legitimately be running on — the same verdict the CORS layer gives
   * (`originPermitted`: allow-list, domain, localhost). Anything else is a
   * 403, and the dashboard never has a token to post to it.
   *
   * THE IDENTITY IS THE STUDIO ROW (`studioReviewerId`), kind `verified`
   * with `user_id` set — the row a dashboard reply is written under, so a
   * comment from the widget and a reply from the dashboard are one author.
   * No migration: 0001's CHECK already accepts `verified` with a `user_id`
   * as "vouched for by one of our own dashboard users", which is exactly
   * what this is. `iex` is the absolute cap, so `refreshableUntil` is the
   * twelve hours every session gets; the refresh above re-checks the
   * membership, which is what ends it early.
   *
   * The write mode does not apply. `link-required` and `verified-only` say
   * who may comment from OUTSIDE the studio; a member is not outside it.
   */
  app.post("/api/v1/projects/:uid/sessions/member", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    const uid = c.req.param("uid");
    const project = await live(c, uid);
    if (project instanceof Response) return project;
    // 404, not 403, for another studio's site — reviewLinks.ts's rule: a uid
    // existing at all is not information another org gets to learn.
    if (project.org_id !== owner.orgId) return fail(c, 404, "project_not_found", "No project with that uid.");
    if (owner.role === "viewer") {
      return fail(c, 403, "forbidden", "Your role in this studio cannot comment.");
    }

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const origin = canonicalOrigin(body?.origin);
    if (!origin) {
      return fail(c, 400, "validation_failed", "origin must be the page's origin, like https://acme.com.");
    }
    if (!originPermitted(await allowedOrigins(sql, project.id), project.domain, origin)) {
      return fail(
        c,
        403,
        "origin_not_allowed",
        `${origin} is not one of this site's addresses. Add it in the site's settings first.`,
      );
    }

    const envKey = typeof body?.environment === "string" && body.environment ? body.environment : null;
    return mintMember(c, owner, project, uid, origin, envKey);
  });

  /**
   * `POST /api/v1/projects/{uid}/sessions/member/silent`, the silent
   * member sign-in for a client page on the SAME SITE as the dashboard.
   *
   * The studio's real setup is `snagset.studio.dev` for the dashboard and
   * `acme.studio.dev` for the client's staging site: two origins, ONE site.
   * A `SameSite=Lax` cookie is sent on any same-site request, credentialed
   * fetches included, so the widget on acme.… can simply ask "am I a
   * member?" with the dashboard cookie riding along — no popup, no click.
   * On an unrelated client domain the browser sends nothing (cross-site), the
   * answer is a cheap 401, and the popup stays the way in.
   *
   * WHY THE CLICK IS NOT NEEDED HERE, when the decision says it is not a courtesy:
   * The click guards against a page that opens the popup and receives a
   * token by `postMessage` without the member knowing. Here the token goes
   * nowhere but the response body, and the browser lets only an origin this
   * response names (`Access-Control-Allow-Origin` + credentials, cors.ts)
   * read it — and every such origin is, by the checks below, one of the
   * site's own addresses on the studio's own registrable domain. A page that
   * can read this response is a page the widget is installed on, under a
   * domain the studio controls.
   *
   * NO CSRF PAIR — the widget cannot read the dashboard's CSRF cookie (it is
   * host-only on the server's host), so this route is NOT behind
   * `requireOwner()` (app.ts mounts that on `…/sessions/member` exactly,
   * which does not match this path). It is protected by three checks, and
   * every one of them must pass:
   *
   *   1. `Sec-Fetch-Site` is `same-site` or `same-origin`. A Fetch Metadata
   *      header: set by the browser, not settable by page script, so a
   *      cross-site page cannot claim to be a neighbour. MISSING is a refusal
   *      — an old browser that does not send it uses the popup, as it always
   *      could.
   *   2. `Origin` is exactly an origin, `originPermitted` accepts it for this
   *      site (the CORS layer's and the popup route's own verdict), AND it is
   *      the same site as this server's own host (`sameSite`, domain.ts:
   *      last two labels equal and not a shared hosting or registry suffix —
   *      two customers' `*.vercel.app` apps are NOT one site). Localhost
   *      only when the server is on localhost too.
   *   3. A dashboard cookie session for a member of the site's studio whose
   *      role is not `viewer` — the popup route's own rule.
   *
   * The order is the cheap one: the two header checks touch nothing, and a
   * page with no cookie (a CLIENT on a same-site staging page, which is most
   * callers) gets its 401 before any query of this route's own — `ownerAuth`
   * only queries when a cookie is present, and the project lookup the CORS
   * layer did is cached.
   *
   * The body is optional and `text/plain` if present (`{"environment":"…"}`):
   * a POST with no custom header and a safelisted content type is a CORS
   * SIMPLE request, so there is no preflight round trip on every page load.
   * (cors.ts answers a preflight correctly anyway.)
   */
  app.post("/api/v1/projects/:uid/sessions/member/silent", async (c) => {
    const fetchSite = c.req.header("Sec-Fetch-Site");
    if (fetchSite !== "same-site" && fetchSite !== "same-origin") {
      return fail(c, 403, "forbidden", "Silent sign-in only answers a page on the dashboard's own site.");
    }
    const origin = canonicalOrigin(c.req.header("Origin"));
    // The server's own host as the browser addressed it — the same reading
    // `/auth/login`'s origin check makes, and the host `Sec-Fetch-Site` was
    // computed against. Port dropped: a site has no port.
    const serverHost = (c.req.header("Host") ?? new URL(c.req.url).host).replace(/:\d+$/, "");
    if (!origin || !sameSite(new URL(origin).hostname, serverHost)) {
      return fail(c, 403, "forbidden", "Silent sign-in only answers a page on the dashboard's own site.");
    }

    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    const uid = c.req.param("uid");
    const project = await live(c, uid);
    if (project instanceof Response) return project;
    if (project.org_id !== owner.orgId) return fail(c, 404, "project_not_found", "No project with that uid.");
    if (owner.role === "viewer") {
      return fail(c, 403, "forbidden", "Your role in this studio cannot comment.");
    }
    if (!originPermitted(await allowedOrigins(sql, project.id), project.domain, origin)) {
      return fail(
        c,
        403,
        "origin_not_allowed",
        `${origin} is not one of this site's addresses. Add it in the site's settings first.`,
      );
    }

    const raw = await c.req.text().catch(() => "");
    let body: Record<string, unknown> | null = null;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    const envKey = typeof body?.environment === "string" && body.environment ? body.environment : null;
    /**
     * TWELVE HOURS, whatever SNAGSET_SESSION_ABSOLUTE_TTL_S says. Nobody
     * clicked for this session: any script on a permitted same-site page —
     * an XSS on a client's staging site, a dangling subdomain taken over —
     * can obtain one while a member visits. Renewal is silent too, so the
     * short cap costs the member nothing; it only bounds how long a session
     * lifted that way stays good. The popup, approved with a click, keeps
     * the instance's cap (a studio may raise it to 30 days).
     */
    return mintMember(c, owner, project, uid, origin, envKey, SILENT_CAP_S);
  });

  return app;
}
