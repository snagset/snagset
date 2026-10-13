import type postgres from "postgres";
import { maintenance } from "./db/scope.ts";

/**
 * The 10-second project cache.
 *
 * *"Immediate revocation without a per-request DB read: bump
 * `projects.session_epoch`. The server caches `(uid → { org_id, status,
 * write_mode, read_mode, session_epoch, config_version, ip_salt })` in-process
 * for 10 s, so revocation takes effect within 10 s across all nodes at zero
 * query cost."*
 *
 * That is the whole design: a session carries `epo`, every authenticated
 * request compares it against this cache, and revoking a link bumps the row.
 * No query per request, and no node needs telling.
 *
 * FAIL CLOSED. When a refresh fails, this throws rather than serving the entry
 * it already has. A stale entry is a stale `session_epoch`, and a stale
 * `session_epoch` means a revoked reviewer keeps working for as long as the
 * database stays unreachable — which is exactly the moment nobody is watching.
 * Ten seconds of correct 503s is a recoverable outage; an unbounded window
 * where revocation silently does not apply is not.
 */

export interface ProjectRow {
  id: string;
  org_id: string;
  uid: string;
  name: string;
  status: string;
  /** The site's domain (`projects.settings.domain`), or null when it has only origins. */
  domain: string | null;
  write_mode: string;
  /** The grace-period clock: NULL means no pending downgrade (either the
   *  mode is already `link-required`/`verified-only`, or an owner cleared it
   *  with "keep it open"). See `effectiveWriteMode` in `routes/sessions.ts`. */
  write_mode_downgrade_at: Date | null;
  read_mode: string | null;
  session_epoch: number;
  config_version: number;
  config_etag: string;
  key_prefix: string;
  ip_salt: Buffer;
}

export class ProjectUnavailable extends Error {
  constructor(cause: string) {
    super(`the project cache could not refresh: ${cause}`);
    this.name = "ProjectUnavailable";
  }
}

export interface ProjectCache {
  /** The project, or null when no such uid exists. Throws `ProjectUnavailable`
   *  when the database cannot answer — never a stale hit. */
  get(uid: string): Promise<ProjectRow | null>;
  /** Drop an entry immediately. Called by revoke, so the operator who clicked
   *  it sees the effect on THIS node without waiting out the TTL. */
  invalidate(uid: string): void;
}

interface Entry {
  at: number;
  row: ProjectRow | null;
}

export function createProjectCache(
  sql: postgres.Sql,
  opts: { ttlMs?: number; now?: () => number } = {},
): ProjectCache {
  const ttl = opts.ttlMs ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();
  // One in-flight query per uid: a cold cache under load would otherwise send
  // one identical query per concurrent request, which is the stampede the
  // cache exists to prevent.
  const inflight = new Map<string, Promise<ProjectRow | null>>();

  async function load(uid: string): Promise<ProjectRow | null> {
    const rows = await maintenance(sql, (tx) => tx<ProjectRow[]>`
      SELECT id, org_id, uid, name, status, write_mode, write_mode_downgrade_at, read_mode,
             session_epoch, config_version, config_etag, key_prefix, ip_salt,
             settings->>'domain' AS domain
      FROM projects WHERE uid = ${uid} AND deleted_at IS NULL
    `);
    return rows[0] ?? null;
  }

  return {
    async get(uid) {
      const hit = entries.get(uid);
      if (hit && now() - hit.at < ttl) return hit.row;

      let pending = inflight.get(uid);
      if (!pending) {
        pending = load(uid)
          .then((row) => {
            entries.set(uid, { at: now(), row });
            return row;
          })
          .catch((e: unknown) => {
            // Do NOT fall back to `hit.row`. See the header.
            entries.delete(uid);
            throw new ProjectUnavailable(e instanceof Error ? e.message : String(e));
          })
          .finally(() => inflight.delete(uid));
        inflight.set(uid, pending);
      }
      return pending;
    },
    invalidate(uid) {
      entries.delete(uid);
    },
  };
}
