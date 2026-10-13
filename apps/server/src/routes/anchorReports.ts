import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ID_PREFIX } from "@snagset/types/names";
import type { ProjectCache } from "../projectCache.ts";
import type { Env } from "../app.ts";
import { inOrg } from "../db/scope.ts";

/**
 * Anchor outcome reporting (endpoint 18).
 *
 * ── WHY THIS IS NOT A `PATCH` ──
 *
 * The obvious shape is "the client tells us the pin's new state", and 03
 * rejected it outright. Anchor state is not the client's opinion to overwrite:
 * a reviewer on a 375 px phone whose cascade fails to re-anchor would orphan
 * the pin **for the whole team**, and the desktop that resolved it a second
 * later could not undo that. So a report is a report — telemetry plus a hint —
 * and the server merges it monotonically.
 *
 * ── WHY IT ALWAYS RETURNS 204 ──
 *
 * A reviewer must never see an error because their phone disagreed with their
 * laptop about a pin. Over-limit reports are DROPPED with a 204 rather than
 * queued: they are a metric, not the reviewer's words, and the
 * one thing worse than losing a metric is making somebody's comment fail to
 * save because of one.
 *
 * The two exceptions are both "this request is malformed", not "this pin is
 * disputed": an unknown `strategy` is 422 because a telemetry table that
 * accepts anything measures nothing, and a `threadId` in another project is
 * 404 because that is a cross-project write attempt wearing a typo's clothes.
 */

type Ctx = Context<Env>;

function fail(c: Ctx, status: number, code: string, message: string, details?: unknown) {
  return c.json(
    { error: { code, message, ...(details ? { details } : {}), requestId: c.get("requestId") } },
    status as 400,
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function rowId(wire: unknown, prefix: string): string | null {
  if (typeof wire !== "string") return null;
  const bare = wire.startsWith(prefix) ? wire.slice(prefix.length) : wire;
  return UUID.test(bare) ? bare.toLowerCase() : null;
}

/** The enum, not free text. `manual` is reported by v2 repair, never by `resolve()`. */
const STRATEGY = new Set([
  "testid",
  "domid",
  "css",
  "aria",
  "text-exact",
  "text-fuzzy",
  "path-rect",
  "none",
  "manual",
]);

/**
 * The ordering. `pending` is deliberately absent — it is not a
 * settled state, and rejects it: a client reporting "I have not finished
 * yet" is not reporting an outcome.
 */
const RANK: Record<string, number> = { orphaned: 0, approximate: 1, anchored: 2 };

const MAX_REPORTS = 50;
/** Idempotent within 60 s per (thread, build, strategy). */
const DEDUPE_MS = 60_000;
const RATE_WINDOW_MS = 60_000;

export function anchorReportRoutes(
  sql: postgres.Sql,
  projects: ProjectCache,
  perMinute: () => number,
): Hono<Env> {
  const app = new Hono<Env>();

  app.post("/api/v1/projects/:uid/anchor-reports", async (c) => {
    const p = await projects.get(c.req.param("uid")).catch(() => null);
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");

    const session = c.get("session");
    if (!session) {
      return fail(c, 401, "unauthorized", "Open your review link, or reload the page, and try again.");
    }

    const body = (await c.req.json().catch(() => null)) as { reports?: unknown } | null;
    const reports = Array.isArray(body?.reports) ? (body.reports as Record<string, unknown>[]) : null;
    if (!reports || reports.length === 0 || reports.length > MAX_REPORTS) {
      return fail(
        c,
        400,
        "validation_failed",
        `reports must be an array of 1 to ${MAX_REPORTS} items.`,
        { field: "reports" },
      );
    }

    // Validate EVERY report before writing ANY of them. A batch that is half
    // valid should not leave half a batch in the telemetry — the client has no
    // way to learn which half landed, since the success case is a bare 204.
    const parsed: {
      threadRow: string;
      state: string;
      confidence: number;
      strategy: string;
      build: string | null;
      ms: number | null;
    }[] = [];
    for (const r of reports) {
      const threadRow = rowId(r["threadId"], ID_PREFIX.thread);
      if (!threadRow) {
        return fail(c, 400, "validation_failed", "threadId must be a thread id.", { field: "threadId" });
      }
      const state = String(r["state"]);
      if (!(state in RANK)) {
        return fail(
          c,
          400,
          "validation_failed",
          "state must be one of orphaned, approximate, anchored — 'pending' is not an outcome.",
          { field: "state" },
        );
      }
      const strategy = String(r["strategy"]);
      if (!STRATEGY.has(strategy)) {
        // 422, not 400, and the design says why: a telemetry table that accepts
        // anything measures nothing.
        return fail(c, 422, "validation_failed", `Unknown anchor strategy '${strategy}'.`, {
          field: "strategy",
        });
      }
      const confidence = Number(r["confidence"]);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return fail(c, 400, "validation_failed", "confidence must be between 0 and 1.", {
          field: "confidence",
        });
      }
      const ms = Number(r["ms"]);
      parsed.push({
        threadRow,
        state,
        confidence,
        strategy,
        build: typeof r["build"] === "string" && r["build"] ? r["build"] : null,
        ms: Number.isFinite(ms) ? Math.round(ms) : null,
      });
    }

    /**
     * Rate limit AFTER validation, so a malformed batch still gets its 4xx
     * rather than being silently swallowed by a limit it also tripped — the
     * developer integrating this needs the error more than we need the saving.
     */
    const now = new Date();
    const windowStart = new Date(now.getTime() - RATE_WINDOW_MS);
    const [counter] = await inOrg(sql, p.org_id, (tx) => tx<{ count: string }[]>`
      INSERT INTO rate_counters (org_id, bucket_key, window_start, count, expires_at)
      VALUES (${p.org_id}, ${`anch:${session.sid}`}, ${now}, ${parsed.length},
              ${new Date(now.getTime() + RATE_WINDOW_MS)})
      ON CONFLICT (org_id, bucket_key) DO UPDATE
        SET count = CASE WHEN rate_counters.window_start < ${windowStart} THEN ${parsed.length}
                         ELSE rate_counters.count + ${parsed.length} END,
            window_start = CASE WHEN rate_counters.window_start < ${windowStart} THEN ${now}
                                ELSE rate_counters.window_start END,
            expires_at = ${new Date(now.getTime() + RATE_WINDOW_MS)}
      RETURNING count::text
    `);
    // Dropped, not queued, and not an error.
    if (Number(counter?.count ?? 0) > perMinute()) return c.body(null, 204);

    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${p.org_id}, true)`;

      for (const r of parsed) {
        const [thread] = await tx<
          {
            id: string;
            anchor_state: string;
            anchor_state_build: string | null;
            last_anchor_check: Date | null;
            version: number;
          }[]
        >`
          SELECT id, anchor_state, anchor_state_build, last_anchor_check, version
          FROM threads WHERE id = ${r.threadRow} AND project_id = ${p.id} AND deleted_at IS NULL
        `;
        // Not this project's thread. Skipped rather than failing the batch:
        // the 404 case the design names is a caller sending someone else's id, and
        // by here we have already taken the rate-limit hit for it. A deleted
        // thread is the same shape and is even less worth an error.
        if (!thread) continue;

        /**
         * The 60-second idempotency, by natural key rather than a header. A
         * re-rendering SPA that resolves the same pin four times in a second
         * is not four observations; it is one, seen four times.
         */
        const [recent] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM anchor_events
          WHERE thread_id = ${thread.id}
            AND strategy = ${r.strategy}
            AND build IS NOT DISTINCT FROM ${r.build}
            AND at > ${new Date(now.getTime() - DEDUPE_MS)}
        `;
        if ((recent?.n ?? 0) > 0) continue;

        /**
         * THE MONOTONIC MERGE (normative).
         *
         * A new build is exactly when a pin is allowed to get worse — that is
         * what keeps this monotonic rather than a one-way ratchet that could
         * never report a real regression. Otherwise the maximum wins within
         * the scope, and when neither side knows a build the scope is a
         * rolling 24 hours.
         */
        const newBuild = !!r.build && r.build !== thread.anchor_state_build;
        const stale =
          !r.build &&
          !thread.anchor_state_build &&
          !!thread.last_anchor_check &&
          now.getTime() - new Date(thread.last_anchor_check).getTime() > 24 * 60 * 60 * 1000;

        const resets = newBuild || stale;
        const next = resets
          ? r.state
          : (RANK[r.state] ?? 0) > (RANK[thread.anchor_state] ?? 0)
            ? r.state
            : thread.anchor_state;
        const applied = next !== thread.anchor_state || resets;

        await tx`
          INSERT INTO anchor_events (id, org_id, project_id, thread_id, state, confidence,
                                     strategy, actor_kind, actor_id, build, ms, applied)
          VALUES (${randomUUID()}, ${p.org_id}, ${p.id}, ${thread.id}, ${r.state}::snag_anchor_state,
                  ${r.confidence}, ${r.strategy}, 'runtime', NULL, ${r.build}, ${r.ms}, ${applied})
        `;

        /**
         * `updated_at` and `version` move ONLY when the state actually
         * changed. Telemetry must not wake a polling client, and it must not
         * enqueue an outbox row for a non-event — a reviewer being emailed
         * because somebody's browser re-measured a pin is the kind of noise
         * that teaches people to filter the sender.
         */
        if (next !== thread.anchor_state) {
          await tx`
            UPDATE threads
               SET anchor_state = ${next}::snag_anchor_state,
                   anchor_state_build = ${r.build ?? thread.anchor_state_build},
                   last_anchor_check = ${now},
                   updated_at = ${now},
                   version = version + 1
             WHERE id = ${thread.id}
          `;
        } else {
          await tx`
            UPDATE threads
               SET last_anchor_check = ${now},
                   anchor_state_build = ${r.build ?? thread.anchor_state_build}
             WHERE id = ${thread.id}
          `;
        }
      }
    });

    return c.body(null, 204);
  });

  return app;
}
