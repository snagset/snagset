import { randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ensureStudioReviewers } from "./studioReviewers.ts";
import { ID_PREFIX } from "@snagset/types/names";

/**
 * Creating a project — the ONE place, extracted because there were already two
 * and the decision was about to make three.
 *
 * A project is not a row. It is a row plus **two environments plus a round**,
 * and every one of those is load-bearing in a way that fails late:
 * `threads.environment_id` and `threads.round_id` are both NOT NULL, so a
 * project created without them accepts no comments at all — it looks perfectly
 * healthy in the dashboard and rejects the first pin somebody tries to leave.
 *
 * Both existing copies carried a comment saying so, in different words, one of
 * them noting the claim route *"learned this the hard way"*. Two copies of a
 * lesson is one copy too many: the third caller is
 * `POST /api/v1/projects` (the multi-site), and the way that goes wrong is
 * not by forgetting the lesson but by never having read it.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──
 *
 * No org, no user, no membership, no session, no setup-token cleanup. Those
 * belong to CLAIMING an instance, which happens once; this happens every time
 * somebody adds a site. Folding them together is what made the two copies
 * diverge in the first place — one of them had to invent an owner, the other
 * already had one.
 */

export interface NewProject {
  readonly orgId: string;
  readonly name: string;
  /** Who is adding it. Round 1's `created_by`; a round is a studio act. */
  readonly createdBy: string;
  /** Exact origins or single-level wildcards. Validated by `validateOrigins`. */
  readonly origins?: readonly string[];
  /** The finite `open` window, in hours. */
  readonly graceHours: number;
  /** The site's domain; null or absent when it will live on exact origins only. */
  domain?: string | null;
}

export interface CreatedProject {
  readonly id: string;
  readonly uid: string;
  readonly name: string;
}

/**
 * `prj_` + 12 Crockford base32 characters, and the
 * `CHECK (uid ~ '^prj_[0-9abcdefghjkmnpqrstvwxyz]{12}$')` is the enforcement.
 * Crockford excludes I, L, O and U so a uid read aloud or copied off a screen
 * cannot be misheard; the lowercase form is what the CHECK wants.
 *
 * Rejection sampling, not `% 32`: a byte modulo 32 makes the first 8 symbols
 * of the alphabet fractionally likelier than the rest, which is 60 bits of
 * entropy quietly becoming fewer for no reason at all.
 */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
export function wireId(prefix: string, length = 12): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= 256 - (256 % 32)) continue;
      out += CROCKFORD[byte % 32];
      if (out.length === length) break;
    }
  }
  return prefix + out;
}

/**
 * Validate an origin list, throwing a sentence rather than returning a filtered
 * one.
 *
 * A silently-dropped origin is the worst outcome available here: the site is
 * added, the tag is pasted, and every request from it is refused by CORS with
 * no indication that the origin the operator typed is not the origin stored.
 * Mirrors 0001's own CHECK so the failure arrives with a fix rather than as a
 * constraint violation.
 */
export function validateOrigins(origins: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of origins) {
    const origin = raw.trim();
    if (!origin) continue;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(
        `${JSON.stringify(origin)} is not an origin. It needs a scheme: https://staging.acme.com, ` +
          `not staging.acme.com.`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`${JSON.stringify(origin)} must be http:// or https://.`);
    }
    if (parsed.pathname !== "/" || parsed.search) {
      throw new Error(
        `${JSON.stringify(origin)} has a path. An origin is scheme + host + port and nothing else.`,
      );
    }
    // Rebuilt from the parse rather than passed through, so a trailing slash,
    // an upper-case host or a default port cannot produce two rows that are
    // the same origin spelled differently — `projects_origins` is UNIQUE on
    // (project_id, pattern) and would happily hold both.
    out.push(parsed.origin.toLowerCase());
  }
  return out;
}

export async function createProject(
  tx: postgres.TransactionSql,
  input: NewProject,
): Promise<CreatedProject> {
  const id = randomUUID();
  const uid = wireId(ID_PREFIX.project);
  const name = input.name.trim() || "Untitled site";
  const origins = validateOrigins(input.origins ?? []);

  await tx`
    INSERT INTO projects (id, org_id, uid, name, ip_salt, config_etag, write_mode_downgrade_at, settings)
    VALUES (${id}, ${input.orgId}, ${uid}, ${name},
            ${randomBytes(32)}, ${randomBytes(8).toString("hex")},
            now() + ${input.graceHours}::int * interval '1 hour',
            ${tx.json(input.domain ? { domain: input.domain } : {})}::jsonb)
  `;

  // `threads.environment_id` is NOT NULL.
  for (const [key, label, isDefault] of [
    ["production", "Production", true],
    ["preview", "Preview", false],
  ] as const) {
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${randomUUID()}, ${input.orgId}, ${id}, ${key}, ${label}, ${isDefault})
    `;
  }

  // Round 1. The decision makes every thread belong to exactly one round and
  // `threads.round_id` is NOT NULL — this line is the difference between a
  // project that works and one that appears to.
  await tx`
    INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
    VALUES (${randomUUID()}, ${input.orgId}, ${id}, 1, 'Round 1', ${input.createdBy})
  `;

  // Studio people are reviewer rows in every project — made here
  // for the members that exist, and on membership create for the projects
  // that do. The assignee pool is a pure read because of these two lines.
  await ensureStudioReviewers(tx, { orgId: input.orgId, projectId: id });

  for (const origin of origins) {
    await tx`
      INSERT INTO project_origins (id, org_id, project_id, pattern, is_wildcard)
      VALUES (${randomUUID()}, ${input.orgId}, ${id}, ${origin}, ${origin.includes("*.")})
    `;
  }

  return { id, uid, name };
}
