import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import type { Tracker } from "./store.ts";

/**
 * A tracker → us — for GitHub, for Linear: the status half
 * for a self-host.
 *
 * NO ECHO. The change is written here, directly, and not through the status
 * PATCH — so it queues no `issue.state` row and cannot bounce back. And when
 * the change is ours to begin with (our worker moved the issue, the tracker
 * tells us it moved), the thread already carries the status and the write
 * is a no-op.
 *
 * REPLAY-PROOF by the sync ledger: `UNIQUE (provider, direction,
 * delivery_id)` — a redelivered delivery id inserts nothing and changes
 * nothing.
 */

export function verifyGitHubSignature(raw: string, header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice(7), "hex");
  const want = createHmac("sha256", secret).update(raw, "utf8").digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

export interface IssueStateEvent {
  provider: Tracker;
  orgId: string;
  projectId: string;
  deliveryId: string;
  /** The tracker's id for the issue, as `external_refs.external_id` holds it. */
  externalId: string;
  /** Our status, already mapped by state type — or `detach` when the tracker deleted the issue. */
  status: "resolved" | "progress" | "open" | "detach";
}

export type Applied =
  | { kind: "resolved" | "reopened"; status: string; threadId: string; threadKey: string; version: number; pageUrl: string }
  | { kind: "detached"; threadId: string }
  | { kind: "ignored"; why: "replay" | "no-thread" | "unchanged" | "action" };

export async function applyIssueState(sql: postgres.Sql, ev: IssueStateEvent): Promise<Applied> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${ev.orgId}, true)`;
    // The ledger row first: a replay stops here, before anything is touched.
    const hash = createHash("sha256").update(`${ev.status}:${ev.externalId}`).digest();
    const [ref] = await tx<{ thread_id: string }[]>`
      SELECT thread_id FROM external_refs
       WHERE project_id = ${ev.projectId}::uuid AND provider = ${ev.provider}::snag_provider AND kind = 'issue'
         AND external_id = ${ev.externalId} AND status <> 'detached'
    `;
    const [ledger] = await tx<{ id: string }[]>`
      INSERT INTO sync_ledger (id, org_id, project_id, provider, direction, delivery_id, entity_kind, entity_id, external_id, content_hash, thread_id)
      VALUES (${randomUUID()}, ${ev.orgId}::uuid, ${ev.projectId}::uuid, ${ev.provider}::snag_provider, 'inbound', ${ev.deliveryId}, 'status',
              ${ref?.thread_id ?? null}, ${ev.externalId}, ${hash}, ${ref?.thread_id ?? null})
      ON CONFLICT (provider, direction, delivery_id) DO NOTHING
      RETURNING id
    `;
    if (!ledger) return { kind: "ignored", why: "replay" };
    if (!ref) return { kind: "ignored", why: "no-thread" };

    if (ev.status === "detach") {
      await tx`UPDATE external_refs SET status = 'detached', synced_at = now()
                WHERE thread_id = ${ref.thread_id}::uuid AND provider = ${ev.provider}::snag_provider AND kind = 'issue'`;
      return { kind: "detached", threadId: ref.thread_id };
    }
    const [t] = await tx<{ status: string; key: string; version: number; context: Record<string, unknown> | null }[]>`
      SELECT status, key, version, context FROM threads WHERE id = ${ref.thread_id}::uuid AND deleted_at IS NULL FOR UPDATE
    `;
    if (!t) return { kind: "ignored", why: "no-thread" };
    if (t.status === ev.status) return { kind: "ignored", why: "unchanged" };
    const [row] = await tx<{ version: number }[]>`
      UPDATE threads
         SET status = ${ev.status}::snag_thread_status,
             resolved_at = ${ev.status === "resolved" ? tx`now()` : tx`NULL`},
             version = version + 1, updated_at = now()
       WHERE id = ${ref.thread_id}::uuid
       RETURNING version
    `;
    return {
      kind: ev.status === "resolved" ? "resolved" : "reopened",
      status: ev.status,
      threadId: ref.thread_id,
      threadKey: t.key,
      version: row?.version ?? t.version + 1,
      pageUrl: String(t.context?.["url"] ?? ""),
    };
  });
}

/** GitHub's `issues` actions, mapped: closed resolves (any reason — no archived status), reopened opens, deleted detaches. */
export async function applyGitHubIssueEvent(
  sql: postgres.Sql,
  ev: { orgId: string; projectId: string; deliveryId: string; action: string; issueNumber: number },
): Promise<Applied> {
  const status = ev.action === "closed" ? "resolved" : ev.action === "reopened" ? "open" : ev.action === "deleted" ? "detach" : null;
  if (!status) return { kind: "ignored", why: "action" };
  return applyIssueState(sql, {
    provider: "github",
    orgId: ev.orgId,
    projectId: ev.projectId,
    deliveryId: ev.deliveryId,
    externalId: String(ev.issueNumber),
    status,
  });
}
