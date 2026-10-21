import { addressPinned, forgetAddress, resolveAddress, storeAddress, validateAddress } from "../instance/address.ts";
import { forgetMcpHttp, mcpHttpPinned, resolveMcpHttp, setMcpHttp } from "../instance/mcpHttp.ts";
import { Hono, type Context } from "hono";
import type postgres from "postgres";
import type { Config } from "../config.ts";
import type { Keyring } from "../keys.ts";
import type { OwnerClaims } from "./owner.ts";
import { can } from "@snagset/types/roles";
import { connectBucket, disconnectBucket, envBucketConfig, storageStatus } from "../storage/settings.ts";
import { clearSetting, writeSetting } from "../instance/settings.ts";
import { describeMailUrl, invalidateMailer, resolveMailer } from "../mail/resolve.ts";
import { isConfigured, mailerFromUrl } from "../mail/index.ts";

/**
 * Instance settings from the dashboard.
 *
 * Two groups today, storage and mail; the trackers' credentials follow with
 * phase 7 on the same store and the same rule:
 *
 *   THE ENVIRONMENT WINS AND LOCKS. If any variable of a group is set, the
 *   group is environment-managed: the row shows the non-secret parts and
 *   says so, and every write here answers `409 managed_by_environment`. A
 *   form that could overwrite what an operator deliberately put in the
 *   environment is how two people end up debugging two different configs.
 *
 *   A TEST BEFORE IT COUNTS. Storage is probed (write → read → delete)
 *   before a byte is stored — `connectBucket` has done that since the CLI.
 *   Mail is parsed before it is stored and can be proved with a test
 *   message to the person who clicked.
 *
 *   OWNERS WRITE, ADMINS SEE. Every write records who.
 *
 * Secrets never come back: the GET carries endpoints, bucket names, schemes,
 * hosts and From addresses, and "set · since when" for the rest.
 */

type Env = { Variables: { requestId: string; owner?: OwnerClaims } };
type Ctx = Context<Env>;

export interface InstanceDeps {
  sql: postgres.Sql;
  keys: Keyring;
  cfg: Config;
  env?: Record<string, string | undefined>;
}

function fail(c: Ctx, status: number, code: string, message: string, details?: unknown) {
  return c.json(
    { error: { code, message, ...(details ? { details } : {}), requestId: c.get("requestId") } },
    status as 400,
  );
}

export function instanceRoutes(deps: InstanceDeps): Hono<Env> {
  const { sql, keys, cfg } = deps;
  const env = deps.env ?? process.env;
  const app = new Hono<Env>();

  const mustBeOwner = (c: Ctx): OwnerClaims | Response => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    if (!can(owner.role, "studio")) return fail(c, 403, "forbidden", "Only an owner can change what this instance is connected to.");
    return owner;
  };

  const snapshot = async () => {
    const st = await storageStatus(sql, keys, env);
    const mail = await resolveMailer(sql, keys, cfg);
    const address = await resolveAddress(sql, keys, cfg);
    const mcpHttp = await resolveMcpHttp(sql, keys, cfg);
    return {
      address: { url: address.url, source: address.source, updatedAt: address.updatedAt ? address.updatedAt.toISOString() : null },
      // The remote MCP transport's switch: the environment's, the owner's, or off.
      mcpHttp: { enabled: mcpHttp.enabled, source: mcpHttp.source, updatedAt: mcpHttp.updatedAt ? mcpHttp.updatedAt.toISOString() : null },
      storage: {
        source: st.source ?? "none",
        connected: st.connected,
        ...(st.config.endpoint ? { endpoint: st.config.endpoint } : {}),
        ...(st.config.bucket ? { bucket: st.config.bucket } : {}),
        ...(st.config.region ? { region: st.config.region } : {}),
        ...(st.config.publicBaseUrl ? { publicBaseUrl: st.config.publicBaseUrl } : {}),
        connectedAt: st.connectedAt ? st.connectedAt.toISOString() : null,
        ...(st.unreadable ? { unreadable: true } : {}),
      },
      mail: {
        source: mail.source,
        configured: isConfigured(mail.status),
        ...(mail.scheme ? { scheme: mail.scheme } : {}),
        ...(mail.host ? { host: mail.host } : {}),
        ...(mail.from ? { from: mail.from } : {}),
        updatedAt: mail.updatedAt ? mail.updatedAt.toISOString() : null,
        ...(mail.unreadable ? { unreadable: true } : {}),
        ...(!isConfigured(mail.status) ? { reason: mail.status.reason } : {}),
      },
    };
  };

  app.get("/api/v1/instance", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    // Owners change it and admins see it. A member does neither
    // the bucket's endpoint, the mail host and the sender are the
    // operator's plumbing, not a designer's, and Studio › General is not
    // drawn for them.
    if (!can(owner.role, "settings")) return fail(c, 403, "forbidden", "Only an owner or an admin can see what this instance is connected to.");
    return c.json(await snapshot());
  });

  // ── address ────────────────────────────────────────────────────

  app.put("/api/v1/instance/address", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    if (addressPinned(cfg)) {
      return fail(c, 409, "managed_by_environment", "The address is set by the environment (SNAGSET_BASE_URL). Change it there.");
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const raw = typeof body?.["url"] === "string" ? (body["url"] as string) : "";
    const v = validateAddress(raw);
    if (!v.ok) return fail(c, 422, "validation_failed", v.reason, { field: "url" });
    await storeAddress(sql, keys, owner.orgId, v.origin, owner.userId);
    return c.json(await snapshot());
  });

  app.delete("/api/v1/instance/address", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    if (addressPinned(cfg)) {
      return fail(c, 409, "managed_by_environment", "The address is set by the environment (SNAGSET_BASE_URL). Change it there.");
    }
    await forgetAddress(sql, owner.orgId);
    return c.json(await snapshot());
  });

  // ── the remote MCP transport ───────────────────────────────────

  app.put("/api/v1/instance/mcp-http", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    if (mcpHttpPinned(cfg)) {
      return fail(c, 409, "managed_by_environment", "The remote MCP transport is set by the environment (SNAGSET_MCP_HTTP_ENABLED). Change it there.");
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const enabled = body?.["enabled"];
    if (typeof enabled !== "boolean") return fail(c, 422, "validation_failed", "Say whether the remote transport is on: enabled, true or false.", { field: "enabled" });
    await setMcpHttp(sql, keys, owner.orgId, enabled, owner.userId);
    return c.json(await snapshot());
  });

  app.delete("/api/v1/instance/mcp-http", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    if (mcpHttpPinned(cfg)) {
      return fail(c, 409, "managed_by_environment", "The remote MCP transport is set by the environment (SNAGSET_MCP_HTTP_ENABLED). Change it there.");
    }
    await forgetMcpHttp(sql, owner.orgId);
    return c.json(await snapshot());
  });

  // ── storage ──────────────────────────────────────────────────────────

  app.put("/api/v1/instance/storage", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    if (envBucketConfig(env)) {
      return fail(c, 409, "managed_by_environment", "Storage is set by the environment (SNAGSET_STORAGE_S3_*). Change it there.");
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const str = (k: string) => (typeof body?.[k] === "string" ? (body![k] as string).trim() : "");
    const endpoint = str("endpoint");
    const bucket = str("bucket");
    const accessKeyId = str("accessKeyId");
    const secretAccessKey = str("secretAccessKey");
    const region = str("region") || "auto";
    const publicBaseUrl = str("publicBaseUrl");
    for (const [field, v] of [["endpoint", endpoint], ["bucket", bucket], ["accessKeyId", accessKeyId], ["secretAccessKey", secretAccessKey]] as const) {
      if (!v) return fail(c, 422, "validation_failed", `${field} is required.`, { field });
    }
    if (!/^https?:\/\//.test(endpoint)) {
      return fail(c, 422, "validation_failed", "The endpoint is a URL, like https://ams3.digitaloceanspaces.com.", { field: "endpoint" });
    }
    const result = await connectBucket(
      sql,
      keys,
      { endpoint, bucket, region, ...(publicBaseUrl ? { publicBaseUrl } : {}) },
      { accessKeyId, secretAccessKey },
    );
    if (!result.ok) {
      return fail(c, 422, "validation_failed", `The ${result.step} probe failed: ${result.detail}`, {
        step: result.step,
        detail: result.detail,
      });
    }
    return c.json(await snapshot());
  });

  app.delete("/api/v1/instance/storage", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    if (envBucketConfig(env)) {
      return fail(c, 409, "managed_by_environment", "Storage is set by the environment (SNAGSET_STORAGE_S3_*). Change it there.");
    }
    await disconnectBucket(sql);
    return c.json(await snapshot());
  });

  // ── mail ─────────────────────────────────────────────────────────────

  app.put("/api/v1/instance/mail", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    if (cfg.get("SNAGSET_MAIL_URL")) {
      return fail(c, 409, "managed_by_environment", "Mail is set by the environment (SNAGSET_MAIL_URL). Change it there.");
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const url = typeof body?.["url"] === "string" ? body["url"].trim() : "";
    const from = typeof body?.["from"] === "string" ? body["from"].trim() : "";
    if (!url) return fail(c, 422, "validation_failed", "Give the transport: resend://<api-key>, or smtp://user:pass@host:587.", { field: "url" });
    if (!from || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from.replace(/^.*<([^>]+)>$/, "$1"))) {
      return fail(c, 422, "validation_failed", "Give the From address every message is sent from.", { field: "from" });
    }
    try {
      // The same parse boot applies to the environment: an unsupported scheme
      // or a key-less resend:// is refused HERE with the same sentence.
      mailerFromUrl(url, from);
    } catch (e) {
      return fail(c, 422, "validation_failed", e instanceof Error ? e.message : String(e), { field: "url" });
    }
    await writeSetting(sql, keys, {
      orgId: owner.orgId,
      key: "mail",
      value: { from, ...describeMailUrl(url) },
      secret: url,
      updatedBy: owner.userId,
    });
    invalidateMailer();
    return c.json(await snapshot());
  });

  app.delete("/api/v1/instance/mail", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    if (cfg.get("SNAGSET_MAIL_URL")) {
      return fail(c, 409, "managed_by_environment", "Mail is set by the environment (SNAGSET_MAIL_URL). Change it there.");
    }
    await clearSetting(sql, owner.orgId, "mail");
    invalidateMailer();
    return c.json(await snapshot());
  });

  /** The proof: a message to the person who clicked, with the provider's sentence on failure. */
  app.post("/api/v1/instance/mail/test", async (c) => {
    const owner = mustBeOwner(c);
    if (owner instanceof Response) return owner;
    const mail = await resolveMailer(sql, keys, cfg);
    if (!isConfigured(mail.status)) {
      return fail(c, 409, "integration_not_configured", "No mail transport is connected yet.");
    }
    try {
      const sent = await mail.status.send({
        to: owner.email,
        subject: "Snagset can send mail",
        text:
          "This is the test message from Studio › General. If you are reading it, notifications " +
          "from this instance will arrive the same way.\n",
      });
      return c.json({ to: owner.email, id: sent.id });
    } catch (e) {
      return fail(c, 502, "mail_send_failed", e instanceof Error ? e.message : String(e));
    }
  });

  return app;
}
