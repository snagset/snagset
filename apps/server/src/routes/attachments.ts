import { Hono, type Context } from "hono";
import { randomUUID, createHash } from "node:crypto";
import type postgres from "postgres";
import { HTTP_HEADER, ID_PREFIX } from "@snagset/types/names";
import type { Keyring } from "../keys.ts";
import type { ProjectCache } from "../projectCache.ts";
import type { SessionClaims } from "../session.ts";
import { getBucket, storageStatus } from "../storage/settings.ts";
import { storageKeyFor } from "../storage/bucket.ts";
import { inOrg, maintenance } from "../db/scope.ts";
import { usage, type LimitsSource } from "../plan.ts";

/**
 * Images through the API — (b).
 *
 * *"Browser → our API (≤ 256 KB by construction, clearing every platform cap)
 * → the server writes to the bucket."* Not a presigned direct PUT: images are
 * already inside the encode budget A9b′ sets, so routing them through the API
 * costs nothing and buys the size check, the quota accounting and the
 * project-scoped auth in one place. The presign path is for `kind: 'file'`,
 * which is (c) and not built here.
 *
 * THE CAP IS ENFORCED SERVER-SIDE, always. The widget encodes to 256 KB
 * (A9b′: WebP where encodable, JPEG on WebKit, quality stepped down until it
 * fits), but a cap only the client applies is not a cap.
 */

type Env = { Variables: { requestId: string; session?: SessionClaims } };
type Ctx = Context<Env>;

export interface AttachmentDeps {
  sql: postgres.Sql;
  keys: Keyring;
  projects: ProjectCache;
  /** `SNAGSET_STORAGE_MAX_IMAGE_BYTES` — 262144, which is A9b′'s 256 KB
   *  budget exactly. The widget encodes to fit it by stepping quality down;
   *  this is the server-side check that makes the budget true rather than
   *  merely intended. */
  maxImageBytes: number;
  /** The studio's limits: the plan's picture storage, checked beside L4's per-project ceiling. */
  limits: LimitsSource;
}

function fail(c: Ctx, status: number, code: string, message: string) {
  return c.json({ error: { code, message, requestId: c.get("requestId") } }, status as 400);
}

const EXT: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export function attachmentRoutes(deps: AttachmentDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { sql, keys, projects } = deps;

  /**
   * Upload one image. `kind` is `screenshot` or `image` — the automatic
   * capture and a reviewer's own picture, which differ only in provenance.
   */
  app.post("/api/v1/projects/:uid/attachments", async (c) => {
    const project = await projects.get(c.req.param("uid"));
    if (!project) return fail(c, 404, "project_not_found", "No project with that uid.");

    const session = c.get("session");
    if (!session) return fail(c, 401, "unauthorized", "Open your review link, or reload the page, and try again.");

    const bucket = await getBucket(sql, keys);
    if (!bucket) {
      // Annotation mode. 409 rather than 500: the instance is working exactly
      // as configured, and the fix is an operator action, not a retry.
      return fail(
        c,
        409,
        "storage_not_configured",
        "This instance has no bucket connected, so it does not store pictures. Comments still work.",
      );
    }

    const kind = c.req.header(HTTP_HEADER.attachmentKind) ?? "screenshot";
    if (kind !== "screenshot" && kind !== "image") {
      return fail(c, 422, "validation_failed", `Unsupported attachment kind "${kind}" on this route.`);
    }

    const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
    const ext = EXT[contentType];
    if (!ext) {
      return fail(c, 415, "unsupported_media_type", `Expected an image; got "${contentType || "nothing"}".`);
    }

    const body = new Uint8Array(await c.req.arrayBuffer());
    if (!body.length) return fail(c, 400, "validation_failed", "The body was empty.");
    if (body.length > deps.maxImageBytes) {
      // The widget encodes to A9b′'s 256 KB budget; this is the check that
      // makes the budget true rather than merely intended.
      return fail(
        c,
        413,
        "body_too_large",
        `That image is ${Math.round(body.length / 1024)} KB; the limit is ${Math.round(deps.maxImageBytes / 1024)} KB.`,
      );
    }

    // The lifetime quota, counted in bucket bytes. Checked BEFORE the
    // write, because a quota enforced after the fact is a bill.
    if (project.id) {
      const [p] = await inOrg(sql, project.org_id, (tx) => tx<{ used: string; limit: string }[]>`
        SELECT storage_bytes_used AS used, storage_bytes_limit AS limit FROM projects WHERE id = ${project.id}
      `);
      const limit = Number(p?.limit ?? 0);
      if (limit > 0 && Number(p!.used) + body.length > limit) {
        return fail(
          c,
          413,
          "storage_quota_exceeded",
          "This project has used its picture storage. Existing comments are unaffected.",
        );
      }
    }

    // The plan's number for the whole studio, over every site. Read
    // before any write, like the ceiling above; unlimited on every self-host.
    const plan = await deps.limits(project.org_id);
    if (plan.storageBytes !== null) {
      const used = (await inOrg(sql, project.org_id, (tx) => usage(tx, project.org_id))).storageBytes;
      if (used + body.length > plan.storageBytes) {
        return fail(c, 413, "storage_quota_exceeded", "This studio has used the picture storage its plan includes. Existing comments are unaffected; a plan with more storage lifts it.");
      }
    }

    // The same digest the storage key is derived from — stored so integrity can
    // be checked without re-reading the object, and so a duplicate upload is
    // recognisable by content rather than by key alone.
    const digest = createHash("sha256").update(body).digest();
    const key = storageKeyFor(project.id, body, ext);
    const width = Number(c.req.header(HTTP_HEADER.attachmentWidth)) || null;
    const height = Number(c.req.header(HTTP_HEADER.attachmentHeight)) || null;

    try {
      await bucket.put(key, body, contentType);
    } catch (e) {
      // The bucket is the operator's, so its failure is theirs to see —
      // and the reviewer's comment must survive it (the widget falls back
      // to sending the thread without a picture).
      console.error(`attachment upload failed [${c.get("requestId")}]`, e);
      return fail(c, 502, "storage_unavailable", "The picture could not be stored. Your comment can still be sent.");
    }

    const id = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${project.org_id}, true)`;
      await tx`
        INSERT INTO attachments (id, org_id, project_id, kind, state, storage_key, storage_backend,
                                 content_type, bytes, width, height, sha256, uploaded_by)
        -- 'pending', and the schema is what taught me that. The CHECKs say
        -- state='bound' requires bound_at AND exactly one of thread_id or
        -- comment_id -- and at upload time the thread does not exist yet,
        -- because the widget uploads the picture and THEN creates the thread
        -- so the attachment ref can ride the same write. So a row is born
        -- pending and is bound by the thread create (v1's wire binds
        -- attachments relationally after the fact).
        VALUES (${id}, ${project.org_id}, ${project.id}, ${kind}::snag_attachment_kind, 'pending',
                ${key}, 's3', ${contentType}, ${body.length}, ${width}, ${height},
                ${digest}, ${session.sub})
        ON CONFLICT (storage_key) DO NOTHING
      `;
      // Two reviewers screenshotting the identical viewport produce the same
      // hash and therefore the same key — one object, and the byte count is
      // only charged once.
      await tx`
        UPDATE projects SET storage_bytes_used = storage_bytes_used + ${body.length}
        WHERE id = ${project.id}
          AND EXISTS (SELECT 1 FROM attachments WHERE id = ${id})
      `;
    });

    const [row] = await maintenance(sql, (tx) => tx<{ id: string }[]>`
      SELECT id FROM attachments WHERE storage_key = ${key}
    `);
    return c.json(
      {
        id: ID_PREFIX.attachment + (row?.id ?? id),
        kind,
        contentType,
        byteSize: body.length,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      },
      201,
    );
  });

  /**
   * Serve the bytes back, proxied — (b): *"images proxied through the
   * blob route, cacheable"*.
   *
   * Proxied rather than redirected to a presigned URL because an image in a
   * comment thread is fetched by an `<img>` on our own origin, and a redirect
   * to a short-lived URL breaks the moment the page outlives the signature.
   */
  app.get("/api/v1/attachments/:id/blob", async (c) => {
    const wire = c.req.param("id");
    const id = wire.startsWith(ID_PREFIX.attachment) ? wire.slice(ID_PREFIX.attachment.length) : wire;
    const [row] = await maintenance(sql, (tx) => tx<{ storage_key: string; content_type: string; project_id: string }[]>`
      SELECT storage_key, content_type, project_id FROM attachments
      WHERE id = ${id} AND deleted_at IS NULL
    `);
    if (!row) return fail(c, 404, "not_found", "No such attachment.");

    const bucket = await getBucket(sql, keys);
    if (!bucket) return fail(c, 409, "storage_not_configured", "This instance has no bucket connected.");

    const bytes = await bucket.get(row.storage_key).catch(() => null);
    if (!bytes) return fail(c, 404, "not_found", "That picture is not in the bucket.");

    // Immutable: the key is a content hash, so the bytes at it cannot change.
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    c.header("Content-Type", row.content_type);
    // Honest note: this route has NO auth. The control is that attachment ids
    // are unguessable UUIDs (a capability URL) plus ACAO: * so an <img> on any
    // origin can render it. A signed/expiring form is attachment_shares
    // and is not built yet.
    c.header("Cross-Origin-Resource-Policy", "cross-origin");
    c.header("Access-Control-Allow-Origin", "*");
    return c.body(bytes as unknown as ArrayBuffer);
  });

  return app;
}

/** A9b: derived server-side from bucket presence, never probed by the widget. */
export async function features(
  sql: postgres.Sql,
  keys: Keyring,
  env: Record<string, string | undefined> = process.env,
): Promise<{ screenshots: boolean; uploads: boolean }> {
  const st = await storageStatus(sql, keys, env);
  return { screenshots: st.connected, uploads: st.connected };
}
