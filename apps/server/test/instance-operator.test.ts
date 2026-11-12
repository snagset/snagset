import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import { createServer as createTcp, type Server as TcpServer, type Socket } from "node:net";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { HTTP_HEADER } from "@snagset/types/names";
import { join, someAddress } from "./join.ts";

/**
 * The instance's settings are the operator's alone, through the real
 * routes, on an instance with sign-up open and nothing set by the
 * environment, which is where the fault was. The address, the remote MCP
 * switch, storage and mail belong to the whole instance, and the routes
 * asked only whether the caller owned A studio. So the second studio to sign
 * up could read the first one's bucket and mail host, fire its transport's
 * test message, connect a bucket of its own (and be sent every studio's
 * pictures), or disconnect storage for all of them. The last test is the
 * same instance with every group set by the environment, as a hosted one
 * is: there the writes were locked already and the read was not.
 *
 * Nothing is seeded by hand. The first studio is made by the first sign-up,
 * which is the claim; everyone else joins through invites or signs up; and
 * every assertion is a request a browser could send. A fake bucket and a fake
 * SMTP server stand in for the outside world and both keep a record, so "the
 * probe never ran" and "no message left" are read off the record rather than
 * inferred from a status code.
 *
 * Skipped without `SNAGSET_TEST_DATABASE_URL`; drops the schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the instance operator tests";

type App = ReturnType<typeof createApp>;
let sql: postgres.Sql;
let app: App;
let bucketServer: HttpServer;
let bucketUrl: string;
/** Every request the fake bucket was sent, as "PUT /bucket". */
const bucketSeen: string[] = [];
const objects = new Map<string, Buffer>();
let smtpServer: TcpServer;
let smtpPort: number;
/** Every address the fake SMTP server was asked to deliver to. */
const mailedTo: string[] = [];

const SECRET = Buffer.alloc(32, 31).toString("base64url");
const PASSWORD = "correct horse battery staple";
const json = { "content-type": "application/json" };
type Who = { cookie: string; csrf: string };
const as = (who: Who) => ({ ...json, Cookie: who.cookie, [HTTP_HEADER.csrf]: who.csrf });
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
/** The session a sign-up, an invite or a switch just opened: its cookies and the CSRF half. */
const signedIn = async (res: Response): Promise<Who> => ({ cookie: cookiesOf(res), csrf: ((await res.json()) as { csrfToken: string }).csrfToken });

/** Enough of S3 for the probe: path-style PUT, GET, DELETE; signatures ignored. */
function fakeBucket(): Promise<{ server: HttpServer; url: string }> {
  return new Promise((resolve) => {
    const server = createHttp((req, res) => {
      const key = req.url ?? "/";
      bucketSeen.push(`${req.method} ${key.split("/").slice(0, 2).join("/")}`);
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
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  });
}

/** A yes-to-everything SMTP server that records who each message was for. */
function fakeSmtp(): Promise<{ server: TcpServer; port: number }> {
  return new Promise((resolve) => {
    const server = createTcp((socket: Socket) => {
      let inData = false;
      socket.setEncoding("utf8");
      socket.write("220 test.invalid ESMTP\r\n");
      socket.on("data", (chunk: string) => {
        for (const line of chunk.split("\r\n").filter(Boolean)) {
          if (inData) {
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
          } else {
            const to = /^RCPT TO:<([^>]+)>/i.exec(line)?.[1];
            if (to) mailedTo.push(to);
            socket.write("250 ok\r\n");
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

const register = (body: Record<string, unknown>) =>
  app.request("/auth/register", { method: "POST", headers: { ...json, "x-forwarded-for": someAddress() }, body: JSON.stringify(body) });

/** What a studio would connect, were it allowed: its own address, its own bucket, its own sender. */
type Theirs = { address: string; bucket: string; from: string };
const KILNWORK: Theirs = { address: "https://review.kilnwork.test", bucket: "kilnwork-snaps", from: "Kilnwork <review@kilnwork.test>" };
const ELSEWHERE: Theirs = { address: "https://elsewhere.test", bucket: "elsewhere-takes-it", from: "Elsewhere <bob@elsewhere.test>" };

/**
 * Every route under /api/v1/instance, in the order a person would try them,
 * each with a body the route ACCEPTS from the right person — so a refusal
 * can only be the guard's, never a validation error standing in for one.
 * Disconnecting storage is last because, unguarded, it is the one that
 * cannot be taken back from here: it cleared every studio's connection.
 */
const calls = (theirs: Theirs): [method: string, path: string, body?: unknown][] => [
  ["GET", "/api/v1/instance"],
  ["PUT", "/api/v1/instance/address", { url: theirs.address }],
  ["DELETE", "/api/v1/instance/address"],
  ["PUT", "/api/v1/instance/mcp-http", { enabled: true }],
  ["DELETE", "/api/v1/instance/mcp-http"],
  ["PUT", "/api/v1/instance/storage", { endpoint: bucketUrl, bucket: theirs.bucket, accessKeyId: "AKIAEXAMPLE", secretAccessKey: "not-a-real-secret" }],
  ["PUT", "/api/v1/instance/mail", { url: `smtp://127.0.0.1:${smtpPort}`, from: theirs.from }],
  ["POST", "/api/v1/instance/mail/test"],
  ["DELETE", "/api/v1/instance/mail"],
  ["DELETE", "/api/v1/instance/storage"],
];
const routes = () => calls(KILNWORK).map(([method, path]) => `${method} ${path}`);
/** The same answer on every route. */
const all = (answer: string) => Object.fromEntries(routes().map((r) => [r, answer]));
const writes = () => routes().filter((r) => !r.startsWith("GET "));

/**
 * Everything a write to the instance's settings could move, read straight
 * from the database (the suite's own connection is a superuser's, so every
 * studio's rows are in view) and from the two fakes' records.
 */
const state = async () => ({
  orgs: (
    await sql`
      SELECT slug, storage_config, encode(storage_credentials, 'hex') AS credentials,
             encode(storage_credentials_iv, 'hex') AS iv, storage_connected_at, updated_at
      FROM orgs ORDER BY created_at`
  ).map((r) => ({ ...r })),
  settings: (
    await sql`
      SELECT o.slug, s.key, s.value, encode(s.secret, 'hex') AS secret, s.updated_at
      FROM instance_settings s JOIN orgs o ON o.id = s.org_id ORDER BY o.slug, s.key`
  ).map((r) => ({ ...r })),
  bucket: [...bucketSeen],
  mailed: [...mailedTo],
});
const same = (a: unknown, b: unknown): boolean => {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
};

/**
 * Send them all as one person, and say what each answered — "200", or
 * "403 forbidden" with its sentence beside it — and which of them MOVED
 * something: a row, a request to the bucket, a message. A route can answer
 * an error and still have written first, so the state is read after every
 * call rather than once at the end, where a write and its undoing cancel out.
 * `raw` is everything that came back, the body whole and every header, for
 * the search that looks for what must not be there.
 */
async function sweep(who: Who, theirs: Theirs, on: App = app) {
  const answers: Record<string, string> = {};
  const said: Record<string, string> = {};
  const raw: Record<string, string> = {};
  const moved: string[] = [];
  let was = await state();
  for (const [method, path, body] of calls(theirs)) {
    const res = await on.request(path, { method, headers: as(who), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    const error = res.ok ? null : (JSON.parse(text) as { error: { code: string; message: string } }).error;
    answers[`${method} ${path}`] = error ? `${res.status} ${error.code}` : String(res.status);
    said[`${method} ${path}`] = error ? error.message : text;
    raw[`${method} ${path}`] = `${text}\n${JSON.stringify([...res.headers])}`;
    const now = await state();
    if (!same(now, was)) moved.push(`${method} ${path}`);
    was = now;
  }
  return { answers, said, raw, moved };
}

const seen = async (who: Who, on: App = app) => {
  const res = await on.request("/api/v1/instance", { headers: as(who) });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as Record<string, any>;
};

/** The sentence a studio that is not the operator's is told, on every route. */
const OPERATORS = /Only the studio that claimed this instance/;

/**
 * What every session outside the operator's studio must get, whatever its
 * role there: 403 `forbidden` on all ten in the one sentence, nothing moved
 * by any of them, and none of `facts` (what the instance is connected to)
 * anywhere in what came back.
 */
function assertRefused(got: Awaited<ReturnType<typeof sweep>>, who: string, facts: string[]): void {
  const report = `${who} was answered ${JSON.stringify(got.answers, null, 2)}\nthese moved something: ${JSON.stringify(got.moved)}\nand the read said: ${got.said["GET /api/v1/instance"]}`;
  assert.deepEqual(got.answers, all("403 forbidden"), report);
  for (const route of routes()) assert.match(got.said[route]!, OPERATORS, `${who}, ${route}`);
  assert.deepEqual(got.moved, [], report);
  for (const route of routes()) {
    for (const fact of facts) assert.ok(!got.raw[route]!.includes(fact), `${who}, ${route}: the refusal carried ${fact}`);
  }
}

let ada: Who; // owns Kilnwork, the first studio: the one that claimed the instance
let ana: Who; // an admin there
let mia: Who; // a member there
let bob: Who; // owns Elsewhere, the second studio
let eve: Who; // an admin of Elsewhere

/** What Kilnwork has connected by the time anybody else arrives; none of it may reach another studio. */
const kilnworks = () => ["kilnwork-snaps", bucketUrl, `127.0.0.1:${smtpPort}`, "review@kilnwork.test", "review.kilnwork.test"];

/**
 * And, unchanged by any of this: inside the operator's studio an
 * owner changes, an admin sees and a member does neither, each told so in
 * the sentence they were always told; nobody is answered without a session.
 * Asserted with one studio on the instance and again with three.
 */
async function asToday(): Promise<void> {
  const admin = await sweep(ana, KILNWORK);
  assert.equal(admin.answers["GET /api/v1/instance"], "200", "an admin sees it");
  for (const route of writes()) {
    assert.equal(admin.answers[route], "403 forbidden", `admin, ${route}`);
    assert.match(admin.said[route]!, /Only an owner can change what this instance is connected to/, `admin, ${route}`);
  }
  assert.deepEqual(admin.moved, [], "an admin's refused writes moved nothing");

  const member = await sweep(mia, KILNWORK);
  assert.deepEqual(member.answers, all("403 forbidden"), "a member neither sees nor changes");
  assert.match(member.said["GET /api/v1/instance"]!, /Only an owner or an admin can see what this instance is connected to/);
  for (const route of writes()) assert.match(member.said[route]!, /Only an owner can change what this instance is connected to/, `member, ${route}`);
  assert.deepEqual(member.moved, []);

  for (const [method, path] of calls(KILNWORK)) {
    const res = await app.request(path, { method, headers: json });
    assert.equal(res.status, 401, `no session, ${method} ${path}`);
  }
}

const base = () => ({ sql, secretKey: SECRET, state: "READY" as const, version: "0.0.0-test", commit: "test", sourceUrl: "https://example.test", modified: false });

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) {
    throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  }
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
  ({ server: bucketServer, url: bucketUrl } = await fakeBucket());
  ({ server: smtpServer, port: smtpPort } = await fakeSmtp());
  app = createApp({
    ...base(),
    // Sign-up open, and no address, storage, mail or MCP switch in the
    // environment: every group is the dashboard's to set, so the environment's
    // lock (409 managed_by_environment) is never what refuses anybody here.
    cfg: loadConfig({ DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET, SNAGSET_SIGNUP_OPEN: "true" }),
    env: {},
  });
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

test("one studio, as it is today: its owner changes every setting, its admin sees them, its member does neither", { skip }, async () => {
  const first = await register({ email: "ada@kilnwork.test", password: PASSWORD, name: "Ada", orgName: "Kilnwork" });
  assert.equal(first.status, 201, await first.clone().text());
  ada = await signedIn(first);
  for (const [email, name, role] of [["ana@kilnwork.test", "Ana", "admin"], ["mia@kilnwork.test", "Mia", "member"]] as const) {
    const joined = await join(app, as(ada), { email, name, role, password: PASSWORD });
    assert.equal(joined.status, 201, await joined.clone().text());
    if (role === "admin") ana = await signedIn(joined);
    else mia = await signedIn(joined);
  }

  // The list above is the app's own: a route added under /api/v1/instance
  // with a method of its own is either in `calls`, and so swept as every
  // person below, or this line fails and says which one nobody tried.
  const registered = [...new Set(app.routes.filter((r) => r.method !== "ALL" && r.path.startsWith("/api/v1/instance")).map((r) => `${r.method} ${r.path}`))];
  assert.deepEqual(registered.sort(), routes().sort());

  const fresh = await seen(ada);
  assert.deepEqual(
    [fresh["storage"].connected, fresh["storage"].source, fresh["mail"].configured, fresh["address"].source, fresh["mcpHttp"].source],
    [false, "none", false, "default", "default"],
  );

  const owner = await sweep(ada, KILNWORK);
  assert.deepEqual(owner.answers, all("200"), JSON.stringify(owner.said, null, 2));
  assert.deepEqual(bucketSeen, ["PUT /kilnwork-snaps", "GET /kilnwork-snaps", "DELETE /kilnwork-snaps"], "the probe: write, read, delete");
  assert.deepEqual(mailedTo, ["ada@kilnwork.test"], "the test message went to the person who clicked");
  await asToday();
});

test("a second studio is refused on every one of them, read and write, whatever the role there, and told whose they are", { skip }, async () => {
  // Something to lose first: the first studio connects all four.
  for (const [method, path, body] of calls(KILNWORK).filter(([m]) => m === "PUT")) {
    const res = await app.request(path, { method, headers: as(ada), body: JSON.stringify(body) });
    assert.equal(res.status, 200, `${method} ${path}: ${await res.clone().text()}`);
  }
  const connected = await seen(ada);
  assert.deepEqual(
    [connected["storage"].bucket, connected["mail"].from, connected["address"].url, connected["mcpHttp"].enabled],
    ["kilnwork-snaps", "Kilnwork <review@kilnwork.test>", "https://review.kilnwork.test", true],
  );

  const second = await register({ email: "bob@elsewhere.test", password: PASSWORD, name: "Bob", orgName: "Elsewhere" });
  assert.equal(second.status, 201, await second.clone().text());
  bob = await signedIn(second);

  // Nothing may move, at any point: not the first studio's row in `orgs`
  // (its storage_* columns and updated_at), not a row in the settings store
  // under either studio, not one request to the bucket, not one message.
  const was = await state();
  assertRefused(await sweep(bob, ELSEWHERE), "the second studio's owner", kilnworks());
  // HEAD is the read without its body, and is routed as the GET: refused alike.
  assert.equal((await app.request("/api/v1/instance", { method: "HEAD", headers: as(bob) })).status, 403);

  // The studio is asked before the role. Elsewhere's admin would have been
  // shown the read and its member told "only an owner or an admin"; both are
  // told what its owner is told, because none of it is their studio's.
  const joined = await join(app, as(bob), { email: "eve@elsewhere.test", name: "Eve", role: "admin", password: PASSWORD });
  assert.equal(joined.status, 201, await joined.clone().text());
  eve = await signedIn(joined);
  assertRefused(await sweep(eve, ELSEWHERE), "the second studio's admin", kilnworks());
  const member = await join(app, as(bob), { email: "max@elsewhere.test", name: "Max", role: "member", password: PASSWORD });
  assert.equal(member.status, 201, await member.clone().text());
  assertRefused(await sweep(await signedIn(member), ELSEWHERE), "the second studio's member", kilnworks());

  assert.deepEqual(await state(), was);
  assert.deepEqual(await seen(ada), connected, "and the first studio reads exactly what it read before");

  // Middleware is registered as ALL, and so is a handler added with
  // `app.all`, which the list in the first test would not see. So every ALL
  // under the prefix is accounted for: the session-and-CSRF check from
  // app.ts and the guard, each on the bare path and on everything under it.
  // One more is a route nobody swept, or a mount somebody should look at.
  const mounts = app.routes.filter((r) => r.method === "ALL" && r.path.startsWith("/api/v1/instance")).map((r) => r.path);
  assert.deepEqual(mounts.sort(), ["/api/v1/instance", "/api/v1/instance", "/api/v1/instance/*", "/api/v1/instance/*"]);
});

test("the rule is the studio's, not the person's: an owner of the first is refused from a second studio of their own, and the second's owner sees it as an admin of the first", { skip }, async () => {
  const made = await app.request("/api/v1/orgs", { method: "POST", headers: as(ada), body: JSON.stringify({ name: "Second" }) });
  assert.equal(made.status, 201, await made.clone().text());
  const adaInSecond = await signedIn(made);
  const was = await state();
  const there = await sweep(adaInSecond, { address: "https://second.test", bucket: "second-takes-it", from: "Second <ada@kilnwork.test>" });
  assertRefused(there, "the first studio's owner, from her second studio", kilnworks());

  const back = await app.request("/auth/switch", { method: "POST", headers: as(adaInSecond), body: JSON.stringify({ slug: "kilnwork" }) });
  assert.equal(back.status, 200, await back.clone().text());
  ada = await signedIn(back);
  await seen(ada);

  // The other way round. Bob owns Elsewhere and is refused from it; invited
  // into Kilnwork as an admin, that session sees what an admin sees there,
  // and changes nothing, in the sentence an admin is told.
  const joined = await join(app, as(ada), { email: "bob@elsewhere.test", role: "admin", password: PASSWORD });
  assert.equal(joined.status, 201, await joined.clone().text());
  const bobInKilnwork = await sweep(await signedIn(joined), ELSEWHERE);
  assert.equal(bobInKilnwork.answers["GET /api/v1/instance"], "200");
  for (const route of writes()) {
    assert.equal(bobInKilnwork.answers[route], "403 forbidden", route);
    assert.match(bobInKilnwork.said[route]!, /Only an owner can change/, route);
  }
  assert.deepEqual(bobInKilnwork.moved, []);
  assert.equal((await app.request("/api/v1/instance", { headers: as(bob) })).status, 403, "his own studio's session is still refused");
  assert.deepEqual(await state(), was);
});

test("/api/v1/me says whose they are, so a page can leave the rows out instead of asking and being refused", { skip }, async () => {
  const org = async (who: Who) => ((await (await app.request("/api/v1/me", { headers: as(who) })).json()) as { org: unknown }).org;
  for (const who of [ada, ana, mia]) assert.deepEqual(await org(who), { name: "Kilnwork", slug: "kilnwork", operator: true });
  for (const who of [bob, eve]) assert.deepEqual(await org(who), { name: "Elsewhere", slug: "elsewhere", operator: false });
});

test("with three studios on the instance the first one's owner still changes every setting, down to disconnecting, and its admin and member are answered as before", { skip }, async () => {
  bucketSeen.length = 0;
  mailedTo.length = 0;
  const owner = await sweep(ada, KILNWORK);
  assert.deepEqual(owner.answers, all("200"), JSON.stringify(owner.said, null, 2));
  assert.deepEqual(bucketSeen, ["PUT /kilnwork-snaps", "GET /kilnwork-snaps", "DELETE /kilnwork-snaps"]);
  assert.deepEqual(mailedTo, ["ada@kilnwork.test"]);
  await asToday();
  const end = await seen(ada);
  assert.deepEqual(
    [end["storage"].connected, end["storage"].source, end["mail"].configured, end["address"].source, end["mcpHttp"].source],
    [false, "none", false, "default", "default"],
  );
});

test("with every group set by the environment, as a hosted instance has them, another studio is refused before the environment's lock is reached and learns nothing of what is set", { skip }, async () => {
  // The same database and the same sessions, behind an app whose address,
  // storage, mail and MCP switch all come from the environment. Until the
  // guard this was the one place the writes were already safe (409, the
  // environment wins and locks) while the read answered any studio's owner
  // with the bucket, its endpoint, the mail host and the sender.
  const hosted = createApp({
    ...base(),
    cfg: loadConfig({
      DATABASE_URL: URL_!,
      SNAGSET_SECRET_KEY: SECRET,
      SNAGSET_SIGNUP_OPEN: "true",
      SNAGSET_BASE_URL: "https://cloud.snagset.test",
      SNAGSET_MAIL_URL: `smtp://127.0.0.1:${smtpPort}`,
      SNAGSET_MAIL_FROM: "Cloud <hello@cloud.snagset.test>",
      SNAGSET_MCP_HTTP_ENABLED: "false",
    }),
    env: {
      SNAGSET_STORAGE_S3_ENDPOINT: bucketUrl,
      SNAGSET_STORAGE_S3_BUCKET: "cloud-pictures",
      SNAGSET_STORAGE_S3_ACCESS_KEY_ID: "AKIACLOUD",
      SNAGSET_STORAGE_S3_SECRET_ACCESS_KEY: "not-a-real-secret",
    },
  });

  // The first studio, as instance.test.ts has it for a lone one: it reads
  // what the environment set, every write is the environment's to refuse,
  // and the test message goes out through the environment's transport.
  const first = await sweep(ada, KILNWORK, hosted);
  assert.deepEqual(first.answers, { ...all("409 managed_by_environment"), "GET /api/v1/instance": "200", "POST /api/v1/instance/mail/test": "200" }, JSON.stringify(first.said, null, 2));
  const shown = await seen(ada, hosted);
  assert.deepEqual(
    [shown["storage"].source, shown["storage"].bucket, shown["mail"].source, shown["mail"].from, shown["address"].url, shown["mcpHttp"].source],
    ["env", "cloud-pictures", "env", "Cloud <hello@cloud.snagset.test>", "https://cloud.snagset.test", "env"],
  );

  const clouds = ["cloud-pictures", bucketUrl, `127.0.0.1:${smtpPort}`, "hello@cloud.snagset.test", "cloud.snagset.test"];
  assertRefused(await sweep(bob, ELSEWHERE, hosted), "the second studio's owner, on the hosted instance", clouds);
  assertRefused(await sweep(eve, ELSEWHERE, hosted), "the second studio's admin, on the hosted instance", clouds);
});
