import { randomUUID } from "node:crypto";
import type postgres from "postgres";

/**
 * Studio people as REVIEWERS.
 *
 * Types `Thread.assignee` as a `Reviewer`, and the pool a
 * thread can be assigned to is *studio people ∪ everyone who has commented in
 * the project*. The right half of that union always had reviewer rows; the
 * left half is materialised here: one `kind='verified'` row per member per
 * project, with `user_id` set, which is what 0001's CHECK accepts as the
 * verification ("vouched for by one of our own dashboard users").
 *
 * WHEN.: *"materialised on two dashboard writes — project create,
 * and membership create … the pool route is a pure read."* Materialising on
 * READ was rejected there, and the reason holds: a GET that writes rows looks
 * harmless until it runs inside a cached, rate-limited or replicated path.
 * So `createProject` calls this for the new project, the members route calls
 * it for the new person, and 0005 backfills every instance that predates it.
 *
 * ONE STATEMENT, IDEMPOTENT. `reviewers_user_uniq` is UNIQUE (project_id,
 * user_id) WHERE user_id IS NOT NULL, so the INSERT … SELECT can be run twice
 * — or raced by the reply route's found-or-create below — and lands each row
 * once. Soft-deleted users are skipped: somebody who has left the studio is
 * not somebody to hand work to.
 */
export async function ensureStudioReviewers(
  tx: postgres.TransactionSql,
  scope: { orgId: string; projectId?: string; userId?: string },
): Promise<void> {
  await tx`
    INSERT INTO reviewers (id, org_id, project_id, kind, name, email, user_id)
    SELECT gen_random_uuid(), p.org_id, p.id, 'verified',
           COALESCE(NULLIF(u.name, ''), u.email), u.email, u.id
    FROM memberships m
    JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
    JOIN projects p ON p.org_id = m.org_id AND p.deleted_at IS NULL
    WHERE m.org_id = ${scope.orgId}::uuid
      ${scope.projectId ? tx`AND p.id = ${scope.projectId}::uuid` : tx``}
      ${scope.userId ? tx`AND u.id = ${scope.userId}::uuid` : tx``}
    ON CONFLICT (project_id, user_id) WHERE user_id IS NOT NULL DO NOTHING
  `;
}

/**
 * The studio person's reviewer row in a project — found, or created on the
 * spot. The reply route needs it for the author of an owner's reply, and it
 * keeps working for a row that predates the backfill or was created between
 * a membership and a project by a path this file does not know about.
 */
export async function studioReviewerId(
  tx: postgres.TransactionSql,
  o: { orgId: string; projectId: string; userId: string; name: string; email: string },
): Promise<string> {
  const [existing] = await tx<{ id: string }[]>`
    SELECT id FROM reviewers WHERE project_id = ${o.projectId}::uuid AND user_id = ${o.userId}::uuid
  `;
  if (existing) return existing.id;
  const id = randomUUID();
  const [made] = await tx<{ id: string }[]>`
    INSERT INTO reviewers (id, org_id, project_id, kind, name, email, user_id)
    VALUES (${id}::uuid, ${o.orgId}::uuid, ${o.projectId}::uuid, 'verified',
            ${o.name || o.email}, ${o.email}, ${o.userId}::uuid)
    ON CONFLICT (project_id, user_id) WHERE user_id IS NOT NULL DO NOTHING
    RETURNING id
  `;
  if (made) return made.id;
  // The conflict fired: somebody else inserted it between the two statements.
  const [again] = await tx<{ id: string }[]>`
    SELECT id FROM reviewers WHERE project_id = ${o.projectId}::uuid AND user_id = ${o.userId}::uuid
  `;
  return again!.id;
}

/**
 * Whether a widget session belongs to a studio OWNER or ADMIN — a member who
 * signed in from the widget and may delete anyone's comment there, as
 * they may in the dashboard. Not a `member`: the SQL below is the
 * `moderate` row of `@snagset/types/roles`, kept in step by hand because it
 * has to be read from the membership at the moment of the delete. Read from the membership at the moment of the
 * delete, never from the token: a demotion takes effect on the next request,
 * not at the next refresh. A guest's or link reviewer's row has no user_id
 * and is never one.
 */
export async function isStudioModerator(
  tx: postgres.TransactionSql,
  orgId: string,
  reviewerId: string,
): Promise<boolean> {
  const [row] = await tx<{ ok: boolean }[]>`
    SELECT true AS ok
      FROM reviewers r
      JOIN memberships m ON m.user_id = r.user_id AND m.org_id = r.org_id
      JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
     WHERE r.id = ${reviewerId}::uuid AND r.org_id = ${orgId}::uuid
       AND m.role IN ('owner', 'admin')
  `;
  return !!row;
}
