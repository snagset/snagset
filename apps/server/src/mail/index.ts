import type { Config } from "../config.ts";
import type { Mailer, MailerStatus } from "./mailer.ts";
import { createResendMailer } from "./resend.ts";
import { createSmtpMailer } from "./smtp.ts";

export type { Mail, Mailer, MailerStatus, SendResult } from "./mailer.ts";
export { isConfigured } from "./mailer.ts";

/**
 * Which transports this build can speak. Exported so the boot error can name
 * them rather than describing them, and so a test can assert the list rather
 * than a sentence about the list.
 */
export const MAIL_SCHEMES = ["smtp", "smtps", "resend"] as const;

/**
 * Choose a transport from ONE variable, by its scheme — the only place that
 * decision is made.
 *
 * ── WHY THE SCHEME AND NOT A VARIABLE PER VENDOR ──
 *
 * The first shape was `SNAGSET_RESEND_API_KEY` beside `SNAGSET_SMTP_URL`, and
 * it was wrong for a reason that only shows up on the third provider: a
 * vendor's name in the KEY means every new provider costs a new variable, a
 * new precedence rule, and a new boot-time answer to "which one wins if two
 * are set". The scheme puts that information in the value, where it belongs —
 * `resend://re_…`, `smtp://user:pass@host:587` — so adding Postmark is a new
 * case in one function and no new configuration at all. An operator moving
 * from their own mail server to a provider edits one line.
 *
 * The other rules, implemented rather than restated:
 *
 *   · Unset ⇒ notifications are **off and say so**. Not queued. A feature that
 *     is off and visible is an operator's decision; one that queues rows
 *     nobody will deliver is a bug that surfaces three weeks later as "did
 *     that email ever send?".
 *   · A transport without a From address is a BOOT failure, not a runtime one:
 *     every send would fail identically, and the operator should learn that
 *     now rather than from the first missing notification.
 *   · An unknown scheme is also a boot failure. Falling back to "no mail"
 *     would leave someone who configured mail believing it works, which is the
 *     worst of the three outcomes.
 */
export function selectMailer(cfg: Config): MailerStatus {
  const raw = cfg.get("SNAGSET_MAIL_URL");
  const from = cfg.get("SNAGSET_MAIL_FROM");

  if (!raw) {
    return {
      kind: "none",
      reason:
        "no mail transport is configured, so notifications are off. Set SNAGSET_MAIL_URL " +
        "to resend://<api-key> (recommended — the provider owns SPF/DKIM) or to " +
        "smtp://user:pass@host:587, together with SNAGSET_MAIL_FROM.",
    };
  }
  if (!from) {
    throw new Error(
      "SNAGSET_MAIL_URL is set but SNAGSET_MAIL_FROM is not. Every message needs a From " +
        "address, so this would fail on the first send rather than here.",
    );
  }
  return mailerFromUrl(raw, from);
}

/**
 * A transport URL and a From address → a mailer, or a sentence. The ONE parse
 * — the environment (`selectMailer`) and the dashboard's stored transport
 * (`resolve.ts`) both come through here, so an unsupported scheme is
 * refused with the same words wherever it was typed.
 *
 * Parsed by hand rather than with `new URL`: a Resend key is the AUTHORITY
 * component of `resend://re_abc123`, and WHATWG URL lower-cases hostnames.
 * An API key is case-sensitive, so `new URL().hostname` would silently
 * corrupt it and produce a 401 that looks like a bad key rather than a bad
 * parser.
 */
export function mailerFromUrl(raw: string, from: string): Mailer {
  const at = raw.indexOf("://");
  const scheme = at === -1 ? "" : raw.slice(0, at).toLowerCase();
  const rest = at === -1 ? "" : raw.slice(at + 3);

  if (!(MAIL_SCHEMES as readonly string[]).includes(scheme)) {
    throw new Error(
      `the mail transport has an unsupported scheme ${JSON.stringify(scheme || raw.slice(0, 12))}. ` +
        `This build speaks: ${MAIL_SCHEMES.map((s) => `${s}://`).join(", ")}.`,
    );
  }
  if (scheme === "resend") {
    if (!rest) throw new Error("the mail transport is resend:// with no API key after it.");
    // A trailing slash is what a browser or a copy-paste adds; it is not part
    // of the key, and a key with one on the end fails authentication in a way
    // that reads as "wrong key".
    return createResendMailer(rest.replace(/\/+$/, ""), from);
  }
  return createSmtpMailer({ url: raw, from });
}
