import type { Mail, Mailer, SendResult } from "./mailer.ts";

/**
 * The `http` adapter — Resend.
 *
 * ONE of the two modules in this codebase allowed to touch a mail transport;
 * `mail.test.ts` asserts there is no third. Everything else depends on
 * `Mailer`.
 *
 * `fetch` and nothing else: Resend's API is one POST with a JSON body and a
 * bearer token, and its own SDK is a wrapper around exactly that. A dependency
 * whose job is to build one request object is a dependency that has to be
 * audited, updated and shipped inside a package whose pitch is `npx snagset`.
 * The same argument settled S3 in this repo (aws4fetch over the AWS SDK) and it
 * settles this.
 */

const ENDPOINT = "https://api.resend.com/emails";

/**
 * How long to wait before giving up on the API.
 *
 * Bounded because the caller is a JOB with a budget (`runDueJobs`), and an
 * un-timed fetch inside a budgeted tick means the budget is a suggestion. Ten
 * seconds is far beyond Resend's normal response and far below the 20s tick
 * budget, so a hung request loses one job's turn rather than the whole tick.
 */
const TIMEOUT_MS = 10_000;

export function createResendMailer(apiKey: string, from: string): Mailer {
  return {
    kind: "http",
    from,
    async send(mail: Mail): Promise<SendResult> {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [mail.to],
          subject: mail.subject,
          text: mail.text,
          ...(mail.html === undefined ? {} : { html: mail.html }),
          // Resend takes custom headers as an object on the send payload.
          ...(mail.headers === undefined ? {} : { headers: mail.headers }),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) throw new Error(await describe(res));

      // Resend answers `{ id }`. A body that does not parse is not a failure to
      // send — the mail is already accepted — so the id is dropped rather than
      // the send being reported as failed and retried into a duplicate.
      const id = await res
        .json()
        .then((b) => (b as { id?: string }).id ?? null)
        .catch(() => null);
      return { id };
    },
  };
}

/**
 * Turn a Resend error into a sentence that names the fix.
 *
 * The same reasoning as the S3 error mapper next door: the raw body is JSON
 * around one useful word, and the operator reading this at 9pm needs the next
 * step rather than the status code. The three below are the ones a first
 * configuration actually hits — an unverified sending domain in particular,
 * which is the single most common Resend setup failure and whose message
 * ("domain is not verified") does not say where to go.
 */
async function describe(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  const message = (() => {
    try {
      return (JSON.parse(body) as { message?: string }).message ?? body.slice(0, 200);
    } catch {
      return body.slice(0, 200);
    }
  })();

  if (res.status === 401 || res.status === 403) {
    return (
      `resend rejected the API key (${res.status}). Check the key in SNAGSET_MAIL_URL — ` +
      `it starts "re_" and is created at resend.com/api-keys. A key with only ` +
      `"sending access" to a different domain fails here too.`
    );
  }
  if (res.status === 422 && /domain/i.test(message)) {
    return (
      `resend refused the From address "${message}". The sending DOMAIN must be ` +
      `verified at resend.com/domains before it will accept mail from it — ` +
      `check SNAGSET_MAIL_FROM uses a domain you have added there.`
    );
  }
  if (res.status === 429) {
    return `resend rate-limited us (429). The outbox will retry with backoff; no mail was lost.`;
  }
  return `resend returned ${res.status}: ${message}`;
}
