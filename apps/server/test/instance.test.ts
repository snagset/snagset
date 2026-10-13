import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import { createServer as createTcp, type Server as TcpServer, type Socket } from "node:net";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { HTTP_HEADER } from "@snagset/types/names";

/**
 * Instance settings from the dashboard — through the real routes, with a
 * fake bucket and a fake SMTP server so nothing leaves the machine. Skipped
 * without `SNAGSET_TEST_DATABASE_URL`; drops the schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the instance settings tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let owner: { cookie: string; csrf: string };
let admin: { cookie: string; csrf: string };
let bucketServer: HttpServer;
let bucketUrl: string;
let bucketMode: "ok" | "forbidden" = "ok";
const objects = new Map<string, Buffer>();
let smtpServer: TcpServer;
let smtpPort: number;
const smtpSeen: string[] = [];

const SECRET = Buffer.alloc(32, 9).toString("base64url");
const PASSWORD = "correct horse battery staple";

/** Enough of S3 for the probe: path-style PUT, GET, DELETE; signatures ignored. */
function fakeBucket(): Promise<{ server: HttpServer; url: string }> {
  return new Promise((resolve) => {
    const server = createHttp((req, res) => {
      if (bucketMode === "forbidden") {
        res.writeHead(403, { "content-type": "application/xml" });
        res.end("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
        return;
      }
      const key = req.url ?? "/";
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "PUT") {
          objects.set(key, Buffer.concat(chunks));
          res.writeHead(200).end();
        } else if (req.method === "GET") {
          const body = objects.get(key);
          if (!body) return void res.writeHead(404).end();
          res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
        } else if (req.method === "DELETE") {
          objects.delete(key);
          res.writeHead(204).end();
        } else {
          res.writeHead(405).end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/** A yes-to-everything SMTP server that records what it was sent. */
function fakeSmtp(): Promise<{ server: TcpServer; port: number }> {
  return new Promise((resolve) => {
    const server = createTcp((socket: Socket) => {
      let inData = false;
      socket.setEncoding("utf8");
      socket.write("220 test.invalid ESMTP\r\n");
      socket.on("data", (chunk: string) => {
        for (const line of chunk.split("\r\n").filter(Boolean)) {
          if (inData) {
            smtpSeen.push(line);
            if (line === ".") {
              inData = false;
              socket.write("250 2.0.0 queued\r\n");
            }
            continue;
          }
          const verb = line.split(" ")[0]!.toUpperCase();
          if (verb === "EHLO") socket.write("250-test.invalid\r\n250-SIZE 10240000\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (verb === "AUTH") socket.write("235 2.7.0 ok\r\n");
          else if (verb === "DATA") {
            inData = true;
            socket.write("354 go\r\n");
          } else if (verb === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
          } else socket.write("250 ok\r\n");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, `login failed for ${email}: ${text}`);
  return {
    cookie: res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "),
    csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken,
  };
}
const as = (who: { cookie: string; csrf: string }) => ({ "content-type": "application/json", Cookie: who.cookie, [HTTP_HEADER.csrf]: who.csrf });
const json = (res: Response) => res.json() as Promise<Record<string, any>>;

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) {
    throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  }
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
  const orgId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    for (const [email, role] of [["o@e.test", "owner"], ["a@e.test", "admin"]] as const) {
      const id = randomUUID();
      await tx`INSERT INTO users (id, org_id, email, password_hash) VALUES (${id}, ${orgId}, ${email}, ${hashPassword(PASSWORD)})`;
      await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${id}, ${role}::snag_member_role)`;
    }
  });
  ({ server: bucketServer, url: bucketUrl } = await fakeBucket());
  ({ server: smtpServer, port: smtpPort } = await fakeSmtp());
  app = createApp({
    sql,
    cfg: loadConfig({ DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
    // The instance routes read the environment through this, so the suite's
    // own process environment (which may carry a real bucket) never leaks in.
    env: {},
  });
  owner = await login("o@e.test");
  admin = await login("a@e.test");
});

after(async () => {
  bucketServer?.close();
  smtpServer?.close();
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

test("a fresh instance: nothing connected, and each row says so; admins see it, nobody else does", { skip }, async () => {
  const res = await app.request("/api/v1/instance", { headers: as(owner) });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await json(res);
  assert.equal(body["storage"].connected, false);
  assert.equal(body["storage"].source, "none");
  assert.equal(body["mail"].configured, false);
  assert.match(body["mail"].reason, /Studio › General/);
  // The remote MCP transport is off until someone decides.
  assert.deepEqual(body["mcpHttp"], { enabled: false, source: "default", updatedAt: null });
  assert.equal((await app.request("/api/v1/instance", { headers: as(admin) })).status, 200);
  assert.equal((await app.request("/api/v1/instance")).status, 401);
});

test("a bucket is probed before it is stored: bad keys are refused with the step, good ones connect without a restart", { skip }, async () => {
  const body = { endpoint: bucketUrl, bucket: "snaps", accessKeyId: "AKIA", secretAccessKey: "shh" };
  bucketMode = "forbidden";
  const bad = await app.request("/api/v1/instance/storage", { method: "PUT", headers: as(owner), body: JSON.stringify(body) });
  assert.equal(bad.status, 422, await bad.clone().text());
  const err = (await json(bad))["error"];
  assert.equal(err.code, "validation_failed");
  assert.equal(err.details.step, "write");
  assert.equal(objects.size, 0);

  bucketMode = "ok";
  const ok = await app.request("/api/v1/instance/storage", { method: "PUT", headers: as(owner), body: JSON.stringify(body) });
  assert.equal(ok.status, 200, await ok.clone().text());
  const st = (await json(ok))["storage"];
  assert.equal(st.connected, true);
  assert.equal(st.source, "stored");
  assert.equal(st.bucket, "snaps");
  assert.ok(!JSON.stringify(st).includes("shh"), "the secret never comes back");
  assert.equal(objects.size, 0, "the probe cleaned up after itself");
  // The widget's bootstrap learns it at once — features() reads the store per request.
  const [org] = await sql<{ storage_connected_at: Date | null }[]>`SELECT storage_connected_at FROM orgs`;
  assert.ok(org!.storage_connected_at);

  const admins = await app.request("/api/v1/instance/storage", { method: "PUT", headers: as(admin), body: JSON.stringify(body) });
  assert.equal(admins.status, 403);

  const gone = await app.request("/api/v1/instance/storage", { method: "DELETE", headers: as(owner) });
  assert.equal(gone.status, 200);
  assert.equal((await json(gone))["storage"].connected, false);
});

test("a mail transport is parsed before it is stored, shows its shape and never its secret, and can prove itself", { skip }, async () => {
  const bad = await app.request("/api/v1/instance/mail", {
    method: "PUT",
    headers: as(owner),
    body: JSON.stringify({ url: "carrier-pigeon://coop", from: "review@kilnwork.studio" }),
  });
  assert.equal(bad.status, 422);
  assert.match((await json(bad))["error"].message, /unsupported scheme/);

  // No credentials: the SMTP client refuses to send a password over a
  // connection that offers no STARTTLS, and the fake offers none — which is
  // the client being right, not the test being wrong.
  const url = `smtp://127.0.0.1:${smtpPort}`;
  const ok = await app.request("/api/v1/instance/mail", {
    method: "PUT",
    headers: as(owner),
    body: JSON.stringify({ url, from: "Snagset <review@kilnwork.studio>" }),
  });
  assert.equal(ok.status, 200, await ok.clone().text());
  const m = (await json(ok))["mail"];
  assert.equal(m.configured, true);
  assert.equal(m.source, "stored");
  assert.equal(m.scheme, "smtp");
  assert.equal(m.host, `127.0.0.1:${smtpPort}`);
  assert.ok(!JSON.stringify(m).includes("smtp://"), "the transport URL never comes back");

  const sent = await app.request("/api/v1/instance/mail/test", { method: "POST", headers: as(owner) });
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.equal((await json(sent))["to"], "o@e.test");
  assert.ok(smtpSeen.some((l) => /Snagset can send mail/.test(l)), "the message reached the transport");

  const gone = await app.request("/api/v1/instance/mail", { method: "DELETE", headers: as(owner) });
  assert.equal((await json(gone))["mail"].configured, false);
  const none = await app.request("/api/v1/instance/mail/test", { method: "POST", headers: as(owner) });
  assert.equal(none.status, 409);
});

test("the environment wins and locks: an env-set group shows its shape and refuses every write", { skip }, async () => {
  const locked = createApp({
    sql,
    cfg: loadConfig({
      SNAGSET_BASE_URL: "https://review.kilnwork.studio",
      DATABASE_URL: URL_!,
      SNAGSET_SECRET_KEY: SECRET,
      SNAGSET_MAIL_URL: "resend://re_envkey",
      SNAGSET_MAIL_FROM: "review@kilnwork.studio",
      SNAGSET_MCP_HTTP_ENABLED: "false",
    }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
    env: {
      SNAGSET_BASE_URL: "https://review.kilnwork.studio",
      SNAGSET_STORAGE_S3_ENDPOINT: bucketUrl,
      SNAGSET_STORAGE_S3_BUCKET: "envbucket",
      SNAGSET_STORAGE_S3_ACCESS_KEY_ID: "AKIA",
      SNAGSET_STORAGE_S3_SECRET_ACCESS_KEY: "shh",
    },
  });
  const res = await locked.request("/api/v1/instance", { headers: as(owner) });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await json(res);
  assert.equal(body["storage"].source, "env");
  assert.equal(body["storage"].bucket, "envbucket");
  assert.equal(body["mail"].source, "env");
  assert.equal(body["mail"].scheme, "resend");
  assert.equal(body["mail"].from, "review@kilnwork.studio");
  assert.equal(body["address"].source, "env");
  assert.equal(body["address"].url, "https://review.kilnwork.studio");
  // Set to EITHER value, the variable is a decision — off here, and locked off.
  assert.equal(body["mcpHttp"].source, "env");
  assert.equal(body["mcpHttp"].enabled, false);
  const addr = await locked.request("/api/v1/instance/address", { method: "PUT", headers: as(owner), body: JSON.stringify({ url: "https://elsewhere.test" }) });
  assert.equal(addr.status, 409);
  assert.equal((await json(addr))["error"].code, "managed_by_environment");
  assert.ok(!JSON.stringify(body).includes("re_envkey"));
  for (const [method, path] of [["PUT", "/api/v1/instance/storage"], ["DELETE", "/api/v1/instance/storage"], ["PUT", "/api/v1/instance/mail"], ["DELETE", "/api/v1/instance/mail"], ["PUT", "/api/v1/instance/mcp-http"], ["DELETE", "/api/v1/instance/mcp-http"]] as const) {
    const r = await locked.request(path, {
      method,
      headers: as(owner),
      ...(method === "PUT"
        ? { body: JSON.stringify({ url: "resend://x", from: "a@b.co", endpoint: bucketUrl, bucket: "b", accessKeyId: "k", secretAccessKey: "s", enabled: true }) }
        : {}),
    });
    assert.equal(r.status, 409, `${method} ${path}: ${await r.clone().text()}`);
    assert.equal((await json(r))["error"].code, "managed_by_environment");
  }
});

test("the address: this machine's by default, validated before it is stored, read back live, and forgettable", { skip }, async () => {
  const fresh = await json(await app.request("/api/v1/instance", { headers: as(owner) }));
  assert.equal(fresh["address"].source, "default");
  assert.equal(fresh["address"].url, "http://localhost:8080");

  const put = (url: string, who = owner) =>
    app.request("/api/v1/instance/address", { method: "PUT", headers: as(who), body: JSON.stringify({ url }) });
  // Https unless loopback; the origin only.
  const plain = await put("http://review.kilnwork.studio");
  assert.equal(plain.status, 422);
  assert.match((await json(plain))["error"].message, /https:\/\//);
  const path = await put("https://review.kilnwork.studio/dashboard");
  assert.equal(path.status, 422);
  assert.match((await json(path))["error"].message, /origin/);
  const junk = await put("kilnwork");
  assert.equal(junk.status, 422);
  assert.equal((await put("https://review.kilnwork.studio", admin)).status, 403, "owners only");

  const ok = await put("https://review.kilnwork.studio/");
  assert.equal(ok.status, 200, await ok.clone().text());
  const stored = await json(ok);
  assert.equal(stored["address"].source, "stored");
  assert.equal(stored["address"].url, "https://review.kilnwork.studio", "normalised to the origin");
  assert.ok(stored["address"].updatedAt);

  // Loopback http is fine — a laptop names itself.
  assert.equal((await put("http://localhost:8081")).status, 200);
  assert.equal((await json(await app.request("/api/v1/instance", { headers: as(owner) })))["address"].url, "http://localhost:8081");

  const gone = await app.request("/api/v1/instance/address", { method: "DELETE", headers: as(owner) });
  assert.equal(gone.status, 200);
  assert.equal((await json(gone))["address"].source, "default");
});
