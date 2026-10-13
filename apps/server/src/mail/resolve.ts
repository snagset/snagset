import type postgres from "postgres";
import type { Config } from "../config.ts";
import type { Keyring } from "../keys.ts";
import { firstOrgId, readSetting } from "../instance/settings.ts";
import { MAIL_SCHEMES, mailerFromUrl, selectMailer } from "./index.ts";
import type { MailerStatus } from "./mailer.ts";

/**
 * Which mailer, and where it came from — the rule for mail.
 *
 * The ENVIRONMENT WINS AND LOCKS: `SNAGSET_MAIL_URL` set means the transport
 * is the environment's and the dashboard shows it without controls. With no
 * variable, the dashboard's stored transport (`instance_settings.mail`) is
 * used, and it takes effect on the next send — the outbox job asks here on
 * every run and the routes ask here before queueing, so connecting a
 * transport from Studio › General needs no restart.
 *
 * Cached for ten seconds per process, the project cache's bargain: a
 * serverless instance reads once per cold start, a long-running one reads
 * every ten seconds at most, and a write from the dashboard invalidates it
 * so the operator's own next click sees their change.
 */
export interface ResolvedMail {
  status: MailerStatus;
  source: "env" | "stored" | "none";
  /** The transport's shape for a row to show — never the secret. */
  scheme?: string;
  host?: string;
  from?: string;
  updatedAt?: Date;
  /** A transport is stored but its secret will not decrypt (a changed SNAGSET_SECRET_KEY). */
  unreadable?: boolean;
}

export interface StoredMail {
  from: string;
  scheme: string;
  host?: string;
}

const TTL_MS = 10_000;
let cache: { at: number; value: ResolvedMail } | null = null;

export function invalidateMailer(): void {
  cache = null;
}

/** `resend://<key>` → `{ scheme: 'resend' }`; `smtp://u:p@host:587` → `{ scheme: 'smtp', host: 'host:587' }`. Never the credentials. */
export function describeMailUrl(raw: string): { scheme: string; host?: string } {
  const at = raw.indexOf("://");
  const scheme = at === -1 ? "" : raw.slice(0, at).toLowerCase();
  if (scheme === "resend" || at === -1) return { scheme };
  const rest = raw.slice(at + 3);
  const hostPart = rest.includes("@") ? rest.slice(rest.lastIndexOf("@") + 1) : rest;
  return { scheme, host: hostPart.split("/")[0] ?? "" };
}

export async function resolveMailer(sql: postgres.Sql, keys: Keyring, cfg: Config): Promise<ResolvedMail> {
  if (cfg.get("SNAGSET_MAIL_URL")) {
    // The environment: no cache needed, `selectMailer` is a pure parse. It
    // THROWS on a half-set or malformed environment, as boot always has.
    const status = selectMailer(cfg);
    return {
      status,
      source: "env",
      ...describeMailUrl(cfg.get("SNAGSET_MAIL_URL")!),
      ...(cfg.get("SNAGSET_MAIL_FROM") ? { from: cfg.get("SNAGSET_MAIL_FROM")! } : {}),
    };
  }
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const none = (reason: string): ResolvedMail => ({ status: { kind: "none", reason }, source: "none" });
  const orgId = await firstOrgId(sql);
  let value: ResolvedMail;
  if (!orgId) {
    value = none("this instance is not claimed yet, so there is nobody to mail.");
  } else {
    const stored = await readSetting<StoredMail>(sql, keys, orgId, "mail");
    if (!stored) {
      value = none(
        "no mail transport is configured, so notifications are off. Connect one on Studio › General, " +
          "or set SNAGSET_MAIL_URL and SNAGSET_MAIL_FROM in the environment.",
      );
    } else if (stored.unreadable || !stored.secret) {
      value = {
        status: {
          kind: "none",
          reason: "a mail transport is stored but its secret will not decrypt — almost always a changed SNAGSET_SECRET_KEY. Connect it again.",
        },
        source: "stored",
        scheme: stored.value.scheme,
        ...(stored.value.host ? { host: stored.value.host } : {}),
        from: stored.value.from,
        updatedAt: stored.updatedAt,
        unreadable: true,
      };
    } else {
      let status: MailerStatus;
      try {
        status = mailerFromUrl(stored.secret, stored.value.from);
      } catch (e) {
        status = { kind: "none", reason: e instanceof Error ? e.message : String(e) };
      }
      value = {
        status,
        source: "stored",
        scheme: stored.value.scheme,
        ...(stored.value.host ? { host: stored.value.host } : {}),
        from: stored.value.from,
        updatedAt: stored.updatedAt,
      };
    }
  }
  cache = { at: Date.now(), value };
  return value;
}

export { MAIL_SCHEMES };
