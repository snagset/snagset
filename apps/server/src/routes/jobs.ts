import { Hono } from "hono";
import type postgres from "postgres";
import { runDueJobs, summarise } from "../jobs/index.ts";
import type { JobSet } from "../jobs/set.ts";

/**
 * `/api/jobs/run` — the cron target, and now the SWEEP.
 *
 * On the serverless path this is how scheduled work happens at all: a function
 * instance has no process to hold an interval, so `vercel.json` carries a cron
 * that calls this. It used to be every minute, and that alone kept a
 * serverless Postgres awake around the clock. Now a write drains what it
 * queued right after its response (`jobs/soon.ts`), and this runs the reaper
 * and the retries: daily in the scaffold, because Vercel's Hobby plan allows
 * nothing more often, and hourly where the plan allows it. The bin gets the same
 * route and does not need it — it sweeps on its own — but an operator with a
 * stuck queue having a way to force a sweep is worth more than hiding it.
 *
 * ── IT IS AUTHENTICATED, AND THAT IS NOT OPTIONAL ──
 *
 * This is a public URL on the deployment. Left open, anyone can drive the
 * reaper as fast as they can issue requests: every call opens transactions,
 * takes advisory locks and, once the outbox has anything in it, SENDS MAIL.
 * That is a denial-of-service and a mail-amplification surface behind one GET.
 *
 * The platform signs its scheduled invocations with `CRON_SECRET` and sends it
 * as a bearer token. We require it, and an UNSET secret refuses everything:
 * visibly broken beats quietly open, because a cron failing in the platform's
 * log gets fixed and an open endpoint does not get noticed.
 */

export interface JobsDeps {
  readonly sql: postgres.Sql;
  /** The app's own job set, built with the app's keyring. */
  readonly jobs: JobSet;
}

export function jobsRoutes(deps: JobsDeps): Hono {
  const app = new Hono();
  const { sql, jobs: set } = deps;

  app.get("/api/jobs/run", async (c) => {
    const secret = process.env["CRON_SECRET"];
    if (!secret) {
      return c.json(
        {
          error: "cron_not_configured",
          message:
            "CRON_SECRET is not set, so this endpoint refuses every request. Set it in the " +
            "deployment's environment; the platform sends it as a bearer token on scheduled " +
            "invocations. An open jobs endpoint is a way to make this instance send mail on demand.",
        },
        503,
      );
    }
    // Both forms: platforms differ on whether they prefix, and accepting both
    // costs nothing while saving an operator an hour on a 401 with no body.
    const offered = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!timingSafeEqualStr(offered, secret)) {
      return c.json({ error: "unauthorized", message: "Bad or missing cron token." }, 401);
    }

    // Well inside a platform's function ceiling. A sweep that runs out of
    // budget leaves the rest for the next write's drain or the next sweep,
    // which is what `runDueJobs` is built for; the alternative is a function
    // killed mid-transaction.
    const summary = await runDueJobs(sql, await set.all(), { budgetMs: 25_000, log: (m) => console.log(m) });
    if (summary.ran.some((r) => r.did > 0) || summary.failed.length) console.log(summarise(summary));

    return c.json({
      ms: summary.ms,
      ran: summary.ran,
      skipped: summary.skipped,
      failed: summary.failed,
    });
  });

  return app;
}

/** Constant-time compare, so the token cannot be recovered by timing. */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
