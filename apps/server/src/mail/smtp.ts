import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomUUID } from "node:crypto";
import type { Mail, Mailer, SendResult } from "./mailer.ts";

/**
 * The `smtp` adapter — the second and last module allowed to touch a mail
 * transport. `mail.test.ts` asserts there is no third.
 *
 * ── WHY THIS IS HAND-ROLLED ──
 *
 * The same argument as `resend.ts` and as this repo's S3 client: the subset of
 * ESMTP a transactional sender needs is EHLO, optional STARTTLS, optional AUTH,
 * MAIL/RCPT/DATA, QUIT. That is a small, rigidly specified protocol. Against it
 * sits a dependency tree that ships inside a package whose entire pitch is
 * `npx snagset`, and which has to be audited and updated for the life of the
 * product.
 *
 * The risk is real and worth naming: a hand-rolled SMTP client that gets AUTH
 * or line endings wrong sends NOTHING, and mail is exactly where a subtle
 * protocol bug hides. That is why `smtp.test.ts` drives this against a real TCP
 * server speaking real SMTP rather than against a mocked socket — the bugs this
 * class of code has are wire bugs, and a mock cannot have them.
 *
 * ── TWO DECISIONS THAT REMOVE WHOLE CATEGORIES OF BUG ──
 *
 * **Everything is base64.** Bodies are base64 with charset=utf-8 and subjects
 * are RFC 2047 base64 encoded-words. This is not about size — base64 is 33%
 * bigger than quoted-printable for ASCII text. It is that the base64 alphabet
 * contains no `.` and no CR/LF, which makes DOT-STUFFING (RFC 5321 §4.5.2)
 * and the 998-character line limit unreachable by construction. A line of a
 * reviewer's comment that happens to begin with a full stop is a real message
 * that a naive sender truncates, and this is the version of the fix that cannot
 * be forgotten in one branch.
 *
 * **CRLF, always, everywhere.** `\n` alone is accepted by some servers and
 * silently mangles the message on others. One constant, used everywhere.
 */

const CRLF = "\r\n";
const CONNECT_TIMEOUT_MS = 10_000;
/** Per command. A server that accepts the connection and then stops answering
 *  is the failure mode a socket-level timeout does not catch. */
const REPLY_TIMEOUT_MS = 15_000;

export interface SmtpOptions {
  /** `smtp://` (plain, upgraded with STARTTLS when offered) or `smtps://`
   *  (TLS from the first byte). */
  readonly url: string;
  readonly from: string;
}

export function createSmtpMailer(opts: SmtpOptions): Mailer {
  const url = new URL(opts.url);
  const implicitTls = url.protocol === "smtps:";
  const port = url.port ? Number(url.port) : implicitTls ? 465 : 587;
  const host = url.hostname;
  const user = url.username ? decodeURIComponent(url.username) : null;
  const pass = url.password ? decodeURIComponent(url.password) : null;

  return {
    kind: "smtp",
    from: opts.from,
    async send(mail: Mail): Promise<SendResult> {
      const messageId = `<${randomUUID()}@${senderDomain(opts.from)}>`;
      const session = await open(host, port, implicitTls);
      try {
        await session.expect(220);
        let caps = await ehlo(session, host);

        if (!implicitTls && caps.has("STARTTLS")) {
          await session.command("STARTTLS", 220);
          await session.upgrade(host);
          // RFC 3207 §4.2: everything the server said before STARTTLS is
          // discarded and EHLO is re-issued. Servers routinely advertise AUTH
          // only after the upgrade, so skipping this makes authentication
          // silently unavailable on a correctly configured server.
          caps = await ehlo(session, host);
        }

        if (user && pass) await authenticate(session, caps, user, pass);

        const envelopeFrom = envelopeAddress(opts.from);
        if (!/^[^\s<>@]+@[^\s<>@]+$/.test(envelopeFrom)) {
          throw new Error(`Invalid SMTP sender address: ${opts.from}`);
        }
        await session.command(`MAIL FROM:<${envelopeFrom}>`, 250);
        const envelopeTo = envelopeAddress(mail.to);
        await session.command(`RCPT TO:<${envelopeTo}>`, 250);
        await session.command("DATA", 354);
        await session.raw(build(mail, opts.from, messageId) + CRLF + "." + CRLF, 250);
        // QUIT is best-effort: the message is accepted at the 250 above, and a
        // server that drops the connection instead of answering QUIT has still
        // taken it. Treating that as a send failure would retry a delivered
        // message — the one outcome the outbox exists to prevent.
        await session.command("QUIT", 221).catch(() => {});
        return { id: messageId };
      } finally {
        session.close();
      }
    },
  };
}

/** EHLO, and the capability set it returns, upper-cased for comparison. */
async function ehlo(session: Session, host: string): Promise<Set<string>> {
  const reply = await session.command(`EHLO ${clientName(host)}`, 250);
  const caps = new Set<string>();
  for (const line of reply.split(CRLF).slice(1)) {
    const verb = line.slice(4).trim().toUpperCase();
    if (verb) caps.add(verb.split(" ")[0]!);
    // AUTH's mechanisms are on the same line as the verb.
    if (verb.startsWith("AUTH ")) for (const m of verb.slice(5).split(/\s+/)) caps.add(`AUTH=${m}`);
  }
  return caps;
}

/**
 * AUTH, preferring PLAIN.
 *
 * PLAIN is one round trip and LOGIN is three; both send the password base64'd,
 * which is encoding and not encryption — so this refuses to run at all on a
 * connection that is not TLS. An adapter that would rather authenticate in
 * cleartext than fail is an adapter that leaks the operator's mail password to
 * anyone on the path, once, silently, and then works fine.
 */
async function authenticate(
  session: Session,
  caps: Set<string>,
  user: string,
  pass: string,
): Promise<void> {
  if (!session.secure) {
    throw new Error(
      "refusing to send SMTP credentials over an unencrypted connection. " +
        "The server did not offer STARTTLS — use smtps:// (implicit TLS, usually " +
        "port 465), or a server that supports STARTTLS on 587.",
    );
  }
  if (caps.has("AUTH=PLAIN") || (!caps.has("AUTH=LOGIN") && caps.has("AUTH"))) {
    const token = Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
    await session.command(`AUTH PLAIN ${token}`, 235);
    return;
  }
  if (caps.has("AUTH=LOGIN")) {
    await session.command("AUTH LOGIN", 334);
    await session.command(Buffer.from(user, "utf8").toString("base64"), 334);
    await session.command(Buffer.from(pass, "utf8").toString("base64"), 235);
    return;
  }
  throw new Error(
    "the SMTP server advertised no authentication mechanism this client supports " +
      "(PLAIN or LOGIN). Credentials were supplied in SNAGSET_MAIL_URL, so it was " +
      "expected to need them.",
  );
}

/** The message itself: headers, then either one part or a multipart pair. */
function build(mail: Mail, from: string, messageId: string): string {
  const headers = [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ];

  // Extra headers before the Content-Type block, because everything after that
  // point describes the BODY and a header appended there would land inside the
  // part rather than on the message. CRLF and newline are stripped from the
  // value: a header injection here would let anything that reaches this
  // function add arbitrary headers, and one of them is `Bcc`.
  for (const [name, value] of Object.entries(mail.headers ?? {})) {
    headers.push(`${name}: ${encodeHeader(String(value).replace(/[\r\n]+/g, " "))}`);
  }

  if (mail.html === undefined) {
    headers.push('Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: base64");
    return headers.join(CRLF) + CRLF + CRLF + base64Lines(mail.text);
  }

  // The boundary is random rather than fixed: a fixed boundary that appears in
  // a reviewer's comment ends the part early and truncates the mail. Random
  // does not make that impossible, but 32 hex characters makes it a
  // non-event, where a memorable constant makes it a matter of time.
  const boundary = `=_${randomUUID().replace(/-/g, "")}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  // Plain part FIRST: RFC 2046 §5.1.4 orders alternatives worst-to-best, and a
  // client shows the LAST one it understands. Reversed, every graphical client
  // shows the plain text.
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.html),
    `--${boundary}--`,
  ];
  return headers.join(CRLF) + CRLF + CRLF + parts.join(CRLF);
}

/** RFC 2047 encoded-word, but only when the subject needs one: an ASCII
 *  subject stays readable in a raw message, which matters when the thing you
 *  are debugging is why the mail did not arrive. */
function encodeHeader(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?utf-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/** Base64, wrapped at 76 characters per RFC 2045 §6.8. Servers are entitled to
 *  reject longer lines and some do. */
function base64Lines(s: string): string {
  const b64 = Buffer.from(s, "utf8").toString("base64");
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join(CRLF);
}

/** Extract bare email address from an RFC 5322 address (e.g. "Name <user@domain.com>" -> "user@domain.com"). */
function envelopeAddress(address: string): string {
  const match = address.match(/<([^<>]+)>/);
  return (match ? match[1]! : address).trim();
}

/** The domain half of the From address, for the Message-ID. */
function senderDomain(from: string): string {
  const email = envelopeAddress(from);
  const at = email.lastIndexOf("@");
  const domain = at === -1 ? "" : email.slice(at + 1).replace(/[>\s]/g, "");
  return domain || "localhost";
}

/** What we call ourselves in EHLO. Not the server's name — ours — and a bare
 *  hostname is what a server expects from a client without a public FQDN. */
function clientName(host: string): string {
  return /^[\d.]+$/.test(host) || host.includes(":") ? "[127.0.0.1]" : "snagset";
}

// ── The session ───────────────────────────────────────────────────────────

interface Session {
  readonly secure: boolean;
  expect(code: number): Promise<string>;
  command(line: string, code: number): Promise<string>;
  /** Send a payload that is already terminated (the DATA body). */
  raw(payload: string, code: number): Promise<string>;
  upgrade(host: string): Promise<void>;
  close(): void;
}

async function open(host: string, port: number, tls: boolean): Promise<Session> {
  let socket: Socket = await new Promise<Socket>((resolve, reject) => {
    const s = tls
      ? tlsConnect({ host, port, servername: host }, () => resolve(s))
      : createConnection({ host, port }, () => resolve(s));
    s.setTimeout(CONNECT_TIMEOUT_MS, () => {
      s.destroy();
      reject(new Error(`timed out connecting to ${host}:${port} after ${CONNECT_TIMEOUT_MS}ms`));
    });
    s.once("error", reject);
  });
  let secure = tls;

  // One buffer for the whole session. SMTP replies arrive in whatever chunks
  // the network chose, and a reply is not complete until a line matches
  // `NNN<space>` — the continuation form is `NNN-`. Reading per-chunk instead
  // is the classic bug: it works locally and fails against a server that
  // sends its multi-line EHLO in two packets.
  let buffer = "";
  let waiter: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
  let closed: Error | null = null;

  const settle = (): void => {
    if (!waiter) return;
    const match = /^\d{3} [^\r\n]*\r\n/m.exec(buffer);
    if (!match) return;
    const end = buffer.indexOf(match[0]) + match[0].length;
    const reply = buffer.slice(0, end);
    buffer = buffer.slice(end);
    const w = waiter;
    waiter = null;
    w.resolve(reply);
  };

  const attach = (s: Socket): void => {
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buffer += chunk;
      settle();
    });
    s.on("error", (e: Error) => {
      closed = e;
      waiter?.reject(e);
      waiter = null;
    });
    s.on("close", () => {
      closed ??= new Error("the SMTP server closed the connection");
      waiter?.reject(closed);
      waiter = null;
    });
  };
  attach(socket);

  const read = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (closed) return reject(closed);
      waiter = { resolve, reject };
      settle();
      const timer = setTimeout(() => {
        if (waiter) {
          waiter = null;
          reject(new Error(`the SMTP server did not reply within ${REPLY_TIMEOUT_MS}ms`));
        }
      }, REPLY_TIMEOUT_MS);
      timer.unref();
    });

  const check = (reply: string, want: number, sent: string): string => {
    const code = Number(reply.slice(0, 3));
    if (code !== want) {
      // The command is echoed because "550 5.7.1 rejected" without it is
      // unattributable — the same code means a bad sender on MAIL FROM and a
      // bad recipient on RCPT TO.
      throw new Error(`SMTP ${sent} → ${reply.trim()}`);
    }
    return reply;
  };

  return {
    get secure() {
      return secure;
    },
    async expect(code) {
      return check(await read(), code, "<greeting>");
    },
    async command(line, code) {
      socket.write(line + CRLF);
      // The password is never echoed into an error message.
      const shown = /^AUTH /.test(line) ? line.split(" ").slice(0, 2).join(" ") : line;
      return check(await read(), code, shown);
    },
    async raw(payload, code) {
      socket.write(payload);
      return check(await read(), code, "DATA");
    },
    async upgrade(hostname) {
      const plain = socket;
      plain.removeAllListeners("data");
      plain.removeAllListeners("error");
      plain.removeAllListeners("close");
      socket = await new Promise<Socket>((resolve, reject) => {
        const s = tlsConnect({ socket: plain, servername: hostname }, () => resolve(s));
        s.once("error", reject);
      });
      secure = true;
      buffer = "";
      attach(socket);
    },
    close() {
      socket.destroy();
    },
  };
}
