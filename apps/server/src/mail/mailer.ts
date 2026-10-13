/**
 * The `Mailer` seam, and built BEFORE the first notification call
 * site exists, which is the entire point of naming it in the lock.
 *
 * *"otherwise the transport gets imported in eight places, and the import lint
 * is what catches the ninth."* Everything that sends mail depends on this
 * interface; exactly one module per adapter touches a transport. `mail.test.ts`
 * asserts that by grep, because a rule nothing checks is a rule that lasts
 * until the next feature.
 *
 * ── WHY TWO ADAPTERS, WHEN ONE WOULD RUN ──
 *
 * They answer different questions. `http` (Resend) is the DELIVERABILITY
 * answer: a provider owns SPF, DKIM and DMARC, and a self-hosted box mailing
 * third-party addresses without them lands in spam — which no amount of
 * retrying fixes, because the mail was accepted and then filed away. `smtp` is
 * the SOVEREIGNTY answer: an operator who already runs a mail server should not
 * have to add a vendor to a product whose pitch is that it self-hosts.
 *
 * Neither is required. `DATABASE_URL` remains the only mandatory variable
 * and with no transport configured notifications are OFF AND SAY SO
 * rather than queueing rows nobody will deliver.
 */

export interface Mail {
  readonly to: string;
  readonly subject: string;
  /** Always present. A text/plain part is not a fallback for old clients — it
   *  is what a screen reader, a notification preview and a plain-text-only
   *  reader actually get, and it is the half most senders get wrong. */
  readonly text: string;
  /** Optional; when absent the mail is text-only, which is a legitimate
   *  choice rather than a degraded one. */
  readonly html?: string;
  /**
   * Extra RFC 5322 headers. Exists for ONE thing at present and is worth
   * naming: `List-Unsubscribe` and `List-Unsubscribe-Post`, which have to
   * ride on the message itself — a link in the body is not an opt-out a
   * mailbox provider can render a button for, and the button is what stops
   * people reporting the mail as spam instead.
   *
   * Deliberately a flat record rather than a typed pair: the next header this
   * needs (`References`, for threading) is a different shape, and a two-field
   * interface would have to be widened the day it arrives.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface SendResult {
  /** The provider's id for this message, when it gives one. Stored so a
   *  support question about one email has an answer. */
  readonly id: string | null;
}

export interface Mailer {
  /** Which transport this is, for the boot report and the dashboard. */
  readonly kind: "http" | "smtp";
  /** The From address every message goes out as. */
  readonly from: string;
  /**
   * Send one message.
   *
   * Throws on failure — including on a 4xx the provider will never accept.
   * The caller (the outbox) decides what is retryable; a transport that
   * swallowed its own errors would make that decision impossible to make
   * correctly, and "the mail did not send and nothing said so" is the failure
   * mode this whole seam exists to prevent.
   */
  send(mail: Mail): Promise<SendResult>;
}

/** Why no mailer is configured, in the words the dashboard shows. */
export interface MailerAbsent {
  readonly kind: "none";
  readonly reason: string;
}

export type MailerStatus = Mailer | MailerAbsent;

export function isConfigured(m: MailerStatus): m is Mailer {
  return m.kind !== "none";
}
