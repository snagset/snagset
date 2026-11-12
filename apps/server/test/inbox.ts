import { createServer, type Server, type Socket } from "node:net";

/**
 * A mailbox for a test: a yes-to-everything SMTP server that KEEPS what it
 * was handed. Not a `*.test.ts`, so the runner does not pick it up.
 *
 * The suites that mail a link (account-links.test.ts) point the real
 * transport at this — `SNAGSET_MAIL_URL=smtp://127.0.0.1:<port>` — so what a
 * test reads is what `mail/smtp.ts` actually put on the wire, decoded the
 * way a mail client would decode it. A fake `Mailer` would prove the route
 * called `send`; this proves a person could have clicked.
 */
export interface Received {
  to: string;
  subject: string;
  text: string;
}

export interface Inbox {
  /** The transport URL to hand the instance. */
  url: string;
  messages: Received[];
  /** Resolves once at least `count` messages have arrived; rejects, naming what did arrive, if they do not. */
  until(count: number, ms?: number): Promise<void>;
  close(): Promise<void>;
}

const decodeWords = (s: string): string =>
  s.replace(/=\?utf-8\?b\?([^?]*)\?=\s*/gi, (_m, b64: string) => Buffer.from(b64, "base64").toString("utf8")).trim();

function parse(raw: string, rcpt: string): Received {
  const split = raw.indexOf("\r\n\r\n");
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? "" : raw.slice(split + 4);
  // Unfold continuation lines before reading a header.
  const headers = head.replace(/\r\n[ \t]+/g, " ").split("\r\n");
  const header = (name: string): string => {
    const line = headers.find((h) => h.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    return line ? line.slice(name.length + 1).trim() : "";
  };
  const base64 = /base64/i.test(header("Content-Transfer-Encoding"));
  return {
    to: rcpt,
    subject: decodeWords(header("Subject")),
    text: base64 ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8") : body,
  };
}

export function startInbox(): Promise<Inbox> {
  const messages: Received[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let inData = false;
    let data: string[] = [];
    let rcpt = "";
    socket.setEncoding("utf8");
    socket.write("220 inbox.invalid ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const at = buffer.indexOf("\r\n");
        if (at === -1) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(parse(data.join("\r\n"), rcpt));
            data = [];
            socket.write("250 2.0.0 kept\r\n");
          } else {
            // RFC 5321 §4.5.2: a leading dot was doubled by the sender.
            data.push(line.startsWith("..") ? line.slice(1) : line);
          }
          continue;
        }
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") socket.write("250-inbox.invalid\r\n250 SIZE 10240000\r\n");
        else if (verb === "RCPT") {
          rcpt = (/<([^>]+)>/.exec(line)?.[1] ?? "").toLowerCase();
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 ok\r\n");
      }
    });
    socket.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `smtp://127.0.0.1:${port}`,
        messages,
        async until(count, ms = 4000) {
          const end = Date.now() + ms;
          while (messages.length < count) {
            if (Date.now() > end) {
              throw new Error(`expected ${count} message(s), ${messages.length} arrived: ${messages.map((m) => `${m.to} — ${m.subject}`).join(" | ") || "none"}`);
            }
            await new Promise((r) => setTimeout(r, 10));
          }
        },
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
