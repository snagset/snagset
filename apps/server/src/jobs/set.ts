import type postgres from "postgres";
import type { Config } from "../config.ts";
import type { Keyring } from "../keys.ts";
import { addressSource } from "../instance/address.ts";
import { resolveMailer } from "../mail/resolve.ts";
import { deliverEmail, type NotifyMode } from "../mail/notify.ts";
import { buildDigests } from "../mail/digest.ts";
import { pushToTrackers, type PushDeps } from "../integrations/outbox.ts";
import { getBucket } from "../storage/settings.ts";
import { l1Jobs } from "./reaper.ts";
import type { Job } from "./index.ts";

/**
 * Every scheduled job, built in ONE place.
 *
 * Two callers want two slices. The sweep (the bin's timer, the platform's
 * cron) runs all of them; the drain a write starts after its response runs only
 * the two that deliver what it queued. Until the whole list was written
 * out twice, in the bin and in the cron route, and a third copy for the drain
 * would have been the one that fell out of step.
 *
 * Built per run, not once: the mail transport and the bucket are settings an
 * owner can change on Studio › General while the server is up, and the
 * next run should use what is there now.
 */

export interface JobSetDeps {
  readonly sql: postgres.Sql;
  readonly cfg: Config;
  readonly keys: Keyring;
  /** Where each tracker's API is: a fake in tests, an Enterprise Server or the
   *  harness otherwise. Absent means the variable, then the vendor's own. */
  readonly githubApiBase?: string | undefined;
  readonly linearApiBase?: string | undefined;
  readonly slackApiBase?: string | undefined;
}

export interface JobSet {
  /** The two drains, mail and the trackers: what a write's drain runs. */
  outbox(): Promise<Job[]>;
  /** The reaper's three, the digest, then the two drains: what the sweep runs. */
  all(): Promise<Job[]>;
}

export function jobSet(d: JobSetDeps): JobSet {
  // The address as it is when each job runs, not when this was built.
  const address = addressSource(d.sql, d.keys, d.cfg);
  const githubApiBase = d.githubApiBase ?? d.cfg.get("SNAGSET_GITHUB_API_BASE");
  const linearApiBase = d.linearApiBase ?? d.cfg.get("SNAGSET_LINEAR_API_BASE");
  const slackApiBase = d.slackApiBase ?? d.cfg.get("SNAGSET_SLACK_API_BASE");
  const push: PushDeps = {
    keys: d.keys,
    baseUrl: address,
    ...(githubApiBase ? { githubApiBase } : {}),
    ...(linearApiBase ? { linearApiBase } : {}),
    ...(slackApiBase ? { slackApiBase } : {}),
  };

  // How the owner hears about comments. The registry validated it and
  // supplies `digest` when it is unset, so anything else here is `each`.
  const notify: NotifyMode = d.cfg.get("SNAGSET_MAIL_NOTIFY") === "each" ? "each" : "digest";

  const outbox = async (): Promise<Job[]> => [
    // The environment first, then the transport connected on Studio › General.
    deliverEmail((await resolveMailer(d.sql, d.keys, d.cfg)).status, address, d.keys, notify),
    pushToTrackers(d.sql, push),
  ];

  return {
    outbox,
    async all() {
      const bucket = await getBucket(d.sql, d.keys).catch(() => null);
      /**
       * The reaper first, as `l1Jobs` orders it: cheapest and most visible
       * first, so a budget that runs out costs the least. Then the digest, in
       * the SWEEP only and BEFORE the drains, so the row it folds is delivered
       * by the delivery job in the same run: on Vercel's daily cron that is
       * the difference between a digest at 03:00 and one at the next write.
       * Not in `outbox()`: a write's drain is never the reason for a digest.
       */
      const digest =
        notify === "digest" ? [buildDigests((await resolveMailer(d.sql, d.keys, d.cfg)).status)] : [];
      return [...l1Jobs(bucket), ...digest, ...(await outbox())];
    },
  };
}
