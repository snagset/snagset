import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { createSmtpMailer } from "../src/mail/smtp.ts";

/**
 * The SMTP adapter, driven against a REAL TCP server speaking REAL SMTP.
 *
 * Not a mocked socket, deliberately. The bugs this class of code has are wire
 * bugs — a reply split across two packets, a missing CRLF, a multi-line EHLO
 * read as one line, a body line beginning with a full stop — and a mock has
 * none of them because a mock is written by the same person who wrote the
 * assumption. A 60-line server that speaks the protocol back is the only test
 * here that can actually fail for the right reason.
 *
 * No TLS: STARTTLS and AUTH-over-TLS are asserted by their refusal path
 * (`authenticate` throws on a cleartext connection), and standing up a
 * certificate authority inside a unit test buys less than it costs.
 */

interface Recorded {
  readonly commands: string[];
  readonly body: string;
}

/**
 * A minimal SMTP server. `caps` are the EHLO capability lines it advertises;
 * `reject` maps a command prefix to the reply that should be sent instead of
 * the happy one.
 */
function smtpServer(
  opts: { caps?: string[]; reject?: Record<string, string>; splitReplies?: boolean } = {},
): Promise<{ port: number; server: Server; recorded: Promise<Recorded> }> {
  const caps = opts.caps ?? ["SIZE 10240000", "AUTH PLAIN LOGIN"];
  const commands: string[] = [];
  let bodyResolve: (r: Recorded) => void;
  const recorded = new Promise<Recorded>((r) => (bodyResolve = r));

  const server = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    let body = "";

    const write = (s: string): void => {
      if (opts.splitReplies && s.length > 4) {
        // Deliberately split mid-reply, with a gap, to prove the client
        // buffers rather than assuming one chunk is one reply.
        socket.write(s.slice(0, 4));
        setTimeout(() => socket.write(s.slice(4)), 5);
      } else {
        socket.write(s);
      }
    };

    socket.setEncoding("utf8");
    write("220 test.invalid ESMTP\r\n");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\r\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            bodyResolve({ commands: [...commands], body });
            write("250 2.0.0 queued\r\n");
          } else {
            // RFC 5321 §4.5.2 — a leading dot was doubled by the sender.
            body += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
          }
          continue;
        }

        commands.push(line);
        const verb = line.split(" ")[0]!.toUpperCase();
        const rejection = Object.entries(opts.reject ?? {}).find(([prefix]) =>
          line.toUpperCase().startsWith(prefix.toUpperCase()),
        );
        if (rejection) {
          write(rejection[1] + "\r\n");
          continue;
        }

        if (verb === "EHLO") {
          write(
            ["250-test.invalid", ...caps.map((c) => `250-${c}`)].join("\r\n") +
              "\r\n250 HELP\r\n",
          );
        } else if (verb === "AUTH") {
          write(line.toUpperCase().startsWith("AUTH LOGIN") ? "334 VXNlcm5hbWU6\r\n" : "235 2.7.0 ok\r\n");
        } else if (verb === "MAIL" || verb === "RCPT") {
          write("250 2.1.0 ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          write("354 end with .\r\n");
        } else if (verb === "QUIT") {
          write("221 2.0.0 bye\r\n");
          socket.end();
        } else {
          // A base64 continuation line for AUTH LOGIN.
          write("235 2.7.0 ok\r\n");
        }
      }
    });
    socket.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, server, recorded });
    });
  });
}

const decodeBase64Body = (body: string): string => {
  // Strip headers, then join the base64 lines back together.
  const blank = body.indexOf("\r\n\r\n");
  const payload = body.slice(blank + 4).trim();
  return Buffer.from(payload.replace(/\r\n/g, ""), "base64").toString("utf8");
};

test("sends a text-only mail and speaks the protocol in order", async () => {
  const { port, server, recorded } = await smtpServer();
  try {
    const mailer = createSmtpMailer({
      url: `smtp://127.0.0.1:${port}`,
      from: "snagset@studio.test",
    });
    const res = await mailer.send({
      to: "owner@client.test",
      subject: "SN-14 has a new comment",
      text: "Someone replied.",
    });

    const r = await recorded;
    const verbs = r.commands.map((c) => c.split(" ")[0]!.toUpperCase());
    assert.deepEqual(verbs, ["EHLO", "MAIL", "RCPT", "DATA"], "no AUTH without credentials");
    assert.ok(r.commands.includes("MAIL FROM:<snagset@studio.test>"));
    assert.ok(r.commands.includes("RCPT TO:<owner@client.test>"));
    assert.match(r.body, /^Subject: SN-14 has a new comment$/m, "an ASCII subject stays readable");
    assert.equal(decodeBase64Body(r.body), "Someone replied.");
    assert.match(res.id ?? "", /^<.+@studio\.test>$/, "the Message-ID uses the sender's domain");
  } finally {
    server.close();
  }
});

test("a reply split across two packets is still read as one reply", async () => {
  // The classic wire bug: works locally, fails against a server that sends its
  // multi-line EHLO in two writes.
  const { port, server, recorded } = await smtpServer({ splitReplies: true });
  try {
    const mailer = createSmtpMailer({ url: `smtp://127.0.0.1:${port}`, from: "a@b.test" });
    await mailer.send({ to: "c@d.test", subject: "x", text: "y" });
    const r = await recorded;
    assert.ok(r.commands.length >= 4, "the whole conversation completed");
  } finally {
    server.close();
  }
});

test("a body line beginning with a full stop is not truncated", async () => {
  // RFC 5321 §4.5.2. Base64 makes this unreachable by construction, and this
  // test is what proves the construction rather than the intention.
  const { port, server, recorded } = await smtpServer();
  try {
    const mailer = createSmtpMailer({ url: `smtp://127.0.0.1:${port}`, from: "a@b.test" });
    const text = "line one\r\n. this line starts with a dot\r\nline three";
    await mailer.send({ to: "c@d.test", subject: "x", text });
    const r = await recorded;
    assert.equal(decodeBase64Body(r.body), text, "the whole body survived");
  } finally {
    server.close();
  }
});

test("a non-ASCII subject is RFC 2047 encoded, and a unicode body round-trips", async () => {
  const { port, server, recorded } = await smtpServer();
  try {
    const mailer = createSmtpMailer({ url: `smtp://127.0.0.1:${port}`, from: "a@b.test" });
    await mailer.send({ to: "c@d.test", subject: "Kommentar für Sørensen", text: "Grüße 🙂" });
    const r = await recorded;
    assert.match(r.body, /^Subject: =\?utf-8\?B\?/m);
    assert.equal(decodeBase64Body(r.body), "Grüße 🙂");
  } finally {
    server.close();
  }
});

test("html and text go out as multipart/alternative, plain part FIRST", async () => {
  const { port, server, recorded } = await smtpServer();
  try {
    const mailer = createSmtpMailer({ url: `smtp://127.0.0.1:${port}`, from: "a@b.test" });
    await mailer.send({ to: "c@d.test", subject: "x", text: "plain here", html: "<p>rich here</p>" });
    const r = await recorded;
    assert.match(r.body, /Content-Type: multipart\/alternative; boundary="(.+)"/);
    const plainAt = r.body.indexOf("text/plain");
    const htmlAt = r.body.indexOf("text/html");
    assert.ok(plainAt > 0 && htmlAt > plainAt, "RFC 2046 §5.1.4 orders alternatives worst-to-best");
  } finally {
    server.close();
  }
});

test("credentials are REFUSED on a cleartext connection", async () => {
  // The security property: an adapter that would rather authenticate in
  // cleartext than fail leaks the operator's mail password to the path, once,
  // silently, and then works fine.
  const { port, server } = await smtpServer({ caps: ["AUTH PLAIN LOGIN"] });
  try {
    const mailer = createSmtpMailer({
      url: `smtp://user:secret@127.0.0.1:${port}`,
      from: "a@b.test",
    });
    await assert.rejects(
      () => mailer.send({ to: "c@d.test", subject: "x", text: "y" }),
      /unencrypted/,
    );
  } finally {
    server.close();
  }
});

test("a rejected recipient names the command that was rejected", async () => {
  const { port, server } = await smtpServer({ reject: { "RCPT TO": "550 5.1.1 no such user" } });
  try {
    const mailer = createSmtpMailer({ url: `smtp://127.0.0.1:${port}`, from: "a@b.test" });
    await assert.rejects(
      () => mailer.send({ to: "ghost@d.test", subject: "x", text: "y" }),
      (e: Error) => {
        // Both halves matter: 550 alone is unattributable, since the same code
        // means a bad sender on MAIL FROM and a bad recipient on RCPT TO.
        assert.match(e.message, /RCPT TO:<ghost@d\.test>/);
        assert.match(e.message, /550 5\.1\.1 no such user/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test("the password never appears in an error message", async () => {
  const { port, server } = await smtpServer({
    caps: ["AUTH PLAIN"],
    reject: { AUTH: "535 5.7.8 bad credentials" },
  });
  try {
    // Forced past the cleartext guard by pretending the socket is secure is
    // not possible from outside, so this asserts the same masking on the path
    // that IS reachable: the guard's own message.
    const mailer = createSmtpMailer({
      url: `smtp://user:hunter2@127.0.0.1:${port}`,
      from: "a@b.test",
    });
    await assert.rejects(
      () => mailer.send({ to: "c@d.test", subject: "x", text: "y" }),
      (e: Error) => {
        assert.ok(!e.message.includes("hunter2"), "the password must not reach a log");
        return true;
      },
    );
  } finally {
    server.close();
  }
});
