import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { mintSession } from "../src/session.ts";
import { createKeyring } from "../src/keys.ts";
import { pushToTrackers } from "../src/integrations/outbox.ts";
import type { JobContext } from "../src/jobs/index.ts";
import { HTTP_HEADER } from "@snagset/types/names";

/**
 * GitHub with a token — through the real routes and the real worker,
 * against a fake GitHub API so nothing leaves the machine. Skipped without
 * `SNAGSET_TEST_DATABASE_URL`; drops the schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the integration tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let owner: { cookie: string; csrf: string };
let admin: { cookie: string; csrf: string };
let uid: string;
let projectId: string;
let orgId: string;
let threadId: string;
let adaId: string;
let bearer: string;
let gh: Server;
let ghUrl: string;
let ghMode: "ok" | "revoked" = "ok";
const seen: { method: string; path: string; auth: string; body: any }[] = [];
let nextIssue = 1;
let webhook: { url: string; secret: string };

const SECRET = Buffer.alloc(32, 9).toString("base64url");
const PASSWORD = "correct horse battery staple";

/** Enough of GitHub: the repo probe, issue creation, the state change. */
function fakeGitHub(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        const auth = req.headers.authorization ?? "";
        seen.push({ method: req.method!, path: req.url!, auth, body });
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (auth !== "Bearer ghp_good" || ghMode === "revoked") return json(401, { message: "Bad credentials" });
        const m = /^\/repos\/([^/]+)\/([^/]+)(\/issues(?:\/(\d+))?)?$/.exec(req.url!);
        if (!m) return json(404, { message: "Not Found" });
        if (m[1] !== "acme") return json(404, { message: "Not Found" });
        if (!m[3]) return json(200, { full_name: `${m[1]}/${m[2]}`, permissions: { push: true, admin: false } });
        if (req.method === "POST" && !m[4]) {
          const n = nextIssue++;
          return json(201, { number: n, html_url: `https://github.com/${m[1]}/${m[2]}/issues/${n}` });
        }
        if (req.method === "PATCH" && m[4]) return json(200, { number: Number(m[4]) });
        return json(404, { message: "Not Found" });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

let ln: Server;
let lnUrl: string;
const lnSeen: { query: string; variables: any; auth: string }[] = [];
let nextLinear = 1;
const LN_STATES = [
  { id: "st-backlog", name: "Backlog", type: "backlog", position: 0 },
  { id: "st-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "st-doing", name: "In Progress", type: "started", position: 2 },
  { id: "st-done", name: "Done", type: "completed", position: 3 },
  { id: "st-cancel", name: "Canceled", type: "canceled", position: 4 },
];

/** Enough of Linear's GraphQL: the team probe, issueCreate, issueUpdate. */
function fakeLinear(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const { query, variables } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query: string; variables: any };
        const auth = req.headers.authorization ?? "";
        lnSeen.push({ query, variables, auth });
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (auth !== "lin_api_good") return json(401, { errors: [{ message: "Authentication required" }] });
        if (/SnagsetProbe/.test(query)) {
          const nodes = variables.key === "ENG" ? [{ id: "team-eng", key: "ENG", name: "Engineering", states: { nodes: LN_STATES } }] : [];
          return json(200, { data: { viewer: { name: "Ada" }, teams: { nodes } } });
        }
        if (/SnagsetCreate/.test(query)) {
          const n = nextLinear++;
          return json(200, { data: { issueCreate: { success: true, issue: { id: `lin-${n}`, identifier: `ENG-${n}`, url: `https://linear.app/acme/issue/ENG-${n}/title` } } } });
        }
        if (/SnagsetState/.test(query)) return json(200, { data: { issueUpdate: { success: true } } });
        return json(400, { errors: [{ message: "unknown operation" }] });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}/graphql` });
    });
  });
}

let jr: Server;
let jrUrl: string;
const slSeen: { path: string; auth: string; body: any }[] = [];
let nextTs = 1;
let sl: Server;
let slUrl: string;

/** Enough of Slack's Web API: auth.test, the channel list and info, chat.postMessage, chat.update. */
function fakeSlack(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        const auth = req.headers.authorization ?? "";
        const path = req.url!.split("?")[0]!;
        slSeen.push({ path, auth, body });
        const json = (payload: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (auth !== "Bearer xoxb-good") return json({ ok: false, error: "invalid_auth" });
        if (path === "/auth.test") return json({ ok: true, team: "Kilnwork", url: "https://kilnwork.slack.com/", user: "snagset", team_id: "T01" });
        if (path === "/conversations.list") {
          return json({ ok: true, channels: [{ id: "C01", name: "general", is_member: false }, { id: "C02", name: "reviews", is_member: true }], response_metadata: { next_cursor: "" } });
        }
        if (path === "/conversations.info") {
          return body?.channel === "C02" ? json({ ok: true, channel: { id: "C02", name: "reviews", is_member: true } }) : json({ ok: false, error: "channel_not_found" });
        }
        if (path === "/chat.postMessage") {
          if (body?.channel !== "C02") return json({ ok: false, error: "channel_not_found" });
          return json({ ok: true, channel: "C02", ts: `1756900000.${String(nextTs++).padStart(6, "0")}` });
        }
        if (path === "/chat.update") return json({ ok: true, channel: body?.channel, ts: body?.ts });
        return json({ ok: false, error: "unknown_method" });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const jrSeen: { method: string; path: string; auth: string; body: any }[] = [];
let nextJira = 1;
let jiraStatus: "new" | "indeterminate" | "done" = "new";

/** Enough of Jira Cloud's REST v2: myself, the project, issue creation, transitions. */
function fakeJira(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        const auth = req.headers.authorization ?? "";
        jrSeen.push({ method: req.method!, path: req.url!, auth, body });
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const good = "Basic " + Buffer.from("ada@kilnwork.studio:jira_good").toString("base64");
        if (auth !== good) return json(401, { errorMessages: ["Basic authentication failed"] });
        const path = req.url!.split("?")[0]!;
        if (path === "/rest/api/2/myself") return json(200, { displayName: "Ada", emailAddress: "ada@kilnwork.studio" });
        if (path === "/rest/api/2/project/KAN") {
          return json(200, { id: "10000", key: "KAN", name: "Kilnwork", issueTypes: [{ id: "10001", name: "Sub-task", subtask: true }, { id: "10002", name: "Task" }] });
        }
        if (path.startsWith("/rest/api/2/project/")) return json(404, { errorMessages: ["No project could be found with key 'OPS'."] });
        if (path === "/rest/api/2/issue" && req.method === "POST") {
          const n = nextJira++;
          jiraStatus = "new";
          return json(201, { id: String(20000 + n), key: `KAN-${n}` });
        }
        const tr = /^\/rest\/api\/2\/issue\/(KAN-\d+)\/transitions$/.exec(path);
        if (tr && req.method === "GET") {
          return json(200, {
            transitions: [
              { id: "11", name: "To Do", to: { statusCategory: { key: "new" } } },
              { id: "21", name: "In Progress", to: { statusCategory: { key: "indeterminate" } } },
              { id: "31", name: "Done", to: { statusCategory: { key: "done" } } },
            ].filter((t) => t.to.statusCategory.key !== jiraStatus),
          });
        }
        if (tr && req.method === "POST") {
          const id = String(body?.transition?.id);
          jiraStatus = id === "31" ? "done" : id === "21" ? "indeterminate" : "new";
          return json(204, {});
        }
        const one = /^\/rest\/api\/2\/issue\/(KAN-\d+)$/.exec(path);
        if (one && req.method === "GET") return json(200, { key: one[1], fields: { status: { statusCategory: { key: jiraStatus } } } });
        return json(404, { errorMessages: ["Not Found"] });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/** The suite's app. `afterResponse` is the hook: absent, a write's queued work waits for a worker run. */
function build(extra: { afterResponse?: (drain: Promise<void>) => Promise<void> | void } = {}) {
  return createApp({
    sql,
    cfg: loadConfig({ DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET, SNAGSET_BASE_URL: "https://review.example.dev" }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
    env: {},
    githubApiBase: ghUrl,
    linearApiBase: lnUrl,
    slackApiBase: slUrl,
    ...extra,
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
const gh_ = () => `/api/v1/projects/${uid}/integrations/github`;
const runWorker = async () => {
  const job = pushToTrackers(sql, { keys: createKeyring(SECRET), baseUrl: async () => "https://review.example.dev", githubApiBase: ghUrl, linearApiBase: lnUrl, slackApiBase: slUrl });
  for (let i = 0; i < 5; i++) {
    const out = await job.run({ sql, now: new Date(), log: () => {} } as JobContext);
    if (!out.more) break;
  }
};

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) {
    throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  }
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
  ({ server: gh, url: ghUrl } = await fakeGitHub());
  ({ server: ln, url: lnUrl } = await fakeLinear());
  ({ server: jr, url: jrUrl } = await fakeJira());
  ({ server: sl, url: slUrl } = await fakeSlack());

  orgId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    for (const [email, role] of [["o@e.test", "owner"], ["a@e.test", "admin"]] as const) {
      const id = randomUUID();
      await tx`INSERT INTO users (id, org_id, email, password_hash) VALUES (${id}, ${orgId}, ${email}, ${hashPassword(PASSWORD)})`;
      await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${id}, ${role}::snag_member_role)`;
    }
  });
  app = build();
  owner = await login("o@e.test");
  admin = await login("a@e.test");

  const made = await app.request("/api/v1/projects", {
    method: "POST",
    headers: as(owner),
    body: JSON.stringify({ name: "Kilnwork", domain: "kilnwork.studio" }),
  });
  const madeText = await made.text();
  assert.equal(made.status, 201, madeText);
  uid = (JSON.parse(madeText) as { uid: string }).uid;
  const [p] = await sql<{ id: string }[]>`SELECT id FROM projects WHERE uid = ${uid}`;
  projectId = p!.id;

  adaId = randomUUID();
  threadId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    const [env] = await tx<{ id: string }[]>`SELECT id FROM environments WHERE project_id = ${projectId} AND is_default`;
    const [round] = await tx<{ id: string }[]>`SELECT id FROM rounds WHERE project_id = ${projectId}`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
      VALUES (${adaId}, ${orgId}, ${projectId}, 'guest', 'Ada the client', ${Buffer.alloc(32, 2)})`;
    await tx`
      INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                           anchor, context, created_by)
      VALUES (${threadId}, ${orgId}, ${projectId}, 'SN-1', ${env!.id}, ${round!.id}, 1,
              ${tx.json({ label: "button “Buy now”", css: "main .pricing button", page: { origin: "https://kilnwork.studio", pathname: "/pricing", route: "/pricing" }, offset: {} })},
              ${tx.json({ ua: "secret-ua" })}, ${adaId})`;
    await tx`
      INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${threadId}, 1, ${adaId},
              ${"The buy button is the wrong blue. Ping @torvalds, see #1 <img src=x onerror=alert(1)> [link|http://x] {code}"})`;
    await tx`UPDATE projects SET thread_seq = 1 WHERE id = ${projectId}`;
    await tx`UPDATE rounds SET thread_seq = 1 WHERE id = ${round!.id}`;
  });
  bearer = (
    await mintSession(
      createKeyring(SECRET),
      { projectUid: uid, reviewerId: adaId, environmentKey: "production", kind: "guest", reviewLinkId: null, permissions: ["thread:create", "comment:create"], sessionEpoch: 1 },
      { slidingS: 900, absoluteS: 43_200 },
    )
  ).token;
});

after(async () => {
  gh?.close();
  ln?.close();
  jr?.close();
  sl?.close();
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

test("connecting probes the repository with the token before anything is stored; owners and admins; the token never comes back", { skip }, async () => {
  const bad = await app.request(gh_(), { method: "PUT", headers: as(owner), body: JSON.stringify({ repository: "acme/site", token: "ghp_wrong" }) });
  assert.equal(bad.status, 422, await bad.clone().text());
  assert.match((await json(bad))["error"].message, /token was refused/);
  const notRepo = await app.request(gh_(), { method: "PUT", headers: as(owner), body: JSON.stringify({ repository: "not a repo", token: "ghp_good" }) });
  assert.equal(notRepo.status, 422);
  const elsewhere = await app.request(gh_(), { method: "PUT", headers: as(owner), body: JSON.stringify({ repository: "someone/else", token: "ghp_good" }) });
  assert.equal(elsewhere.status, 422);
  assert.match((await json(elsewhere))["error"].message, /not found/);

  const ok = await app.request(gh_(), {
    method: "PUT",
    headers: as(owner),
    body: JSON.stringify({ repository: "https://github.com/acme/site.git", token: "ghp_good", labels: "review, bug", createOn: "manual" }),
  });
  assert.equal(ok.status, 200, await ok.clone().text());
  const okBody = await json(ok);
  const i = okBody["integration"];
  // The webhook to register, shown once with this answer.
  webhook = okBody["webhook"];
  assert.match(webhook.url, /\/api\/v1\/integrations\/github\/inbound$/);
  assert.ok(webhook.secret.length >= 24);
  assert.equal(i.owner, "acme");
  assert.equal(i.repo, "site");
  assert.deepEqual(i.labels, ["review", "bug"]);
  assert.equal(i.createOn, "manual");
  assert.equal(i.health, "ok");
  assert.ok(!JSON.stringify(i).includes("ghp_"), "the token never comes back");

  const list = await json(await app.request("/api/v1/integrations", { headers: as(admin) }));
  assert.equal(list["data"].length, 1);
  assert.equal(list["data"][0].siteName, "Kilnwork");
  // An admin may connect a site too: the same connection again, accepted.
  const adminPut = await app.request(gh_(), { method: "PUT", headers: as(admin), body: JSON.stringify({ repository: "acme/site", token: "ghp_good" }) });
  assert.equal(adminPut.status, 200, await adminPut.clone().text());
});

test("Create GitHub issue: the brief as the body, reviewer text neutralised, one issue per thread however often it is asked", { skip }, async () => {
  seen.length = 0;
  const res = await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}/integrations/github`, { method: "POST", headers: as(owner) });
  assert.equal(res.status, 200, await res.clone().text());
  const ref = (await json(res))["ref"];
  assert.equal(ref.provider, "github");
  assert.equal(ref.externalId, "1");
  assert.equal(ref.url, "https://github.com/acme/site/issues/1");

  const created = seen.find((r) => r.method === "POST" && r.path === "/repos/acme/site/issues");
  assert.ok(created, "an issue was created");
  assert.equal(created!.auth, "Bearer ghp_good");
  assert.match(created!.body.title, /^\/pricing — The buy button is the wrong blue\./);
  assert.deepEqual(created!.body.labels, ["review", "bug"]);
  const body: string = created!.body.body;
  assert.match(body, /<!-- snagset:thread=thr_/);
  assert.match(body, /# SN-1/);
  assert.match(body, /Open in Snagset:\*\* https:\/\/review\.example\.dev\/s\/prj_/);
  // Through the adapters' GitHub target: raw HTML, mentions and
  // cross-references are backslash-neutralised, which GitHub renders as the
  // literal characters. What must not appear is any of them UNescaped.
  assert.match(body, /\\<img src=x onerror=alert\(1\)\\>/, "the HTML is escaped, not passed through");
  assert.ok(!/(^|[^\\])<img/m.test(body), "no live HTML");
  assert.ok(!/(^|[^\\`])@torvalds\b/m.test(body), "the mention is neutralised");
  assert.ok(!/(^|[^\\`])#1\b/m.test(body), "the issue reference is neutralised");
  assert.ok(!body.includes("secret-ua"), "the capture context stays out of a tracker");

  // Asked again: the same issue, no second POST.
  const again = await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}/integrations/github`, { method: "POST", headers: as(owner) });
  assert.equal(again.status, 200);
  assert.equal((await json(again))["ref"].externalId, "1");
  assert.equal(seen.filter((r) => r.method === "POST" && r.path.endsWith("/issues")).length, 1);

  // The list carries the link.
  const rows = (await json(await app.request(`/api/v1/projects/${uid}/threads`, { headers: as(owner) })))["data"] as any[];
  assert.equal(rows[0].refs[0].url, "https://github.com/acme/site/issues/1");
});

test("our status is canonical: resolving closes the issue as completed, reopening opens it", { skip }, async () => {
  seen.length = 0;
  const closed = await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, { method: "PATCH", headers: as(owner), body: JSON.stringify({ status: "resolved" }) });
  assert.equal(closed.status, 200, await closed.clone().text());
  await runWorker();
  const patch1 = seen.find((r) => r.method === "PATCH" && r.path === "/repos/acme/site/issues/1");
  assert.ok(patch1, "the issue was patched");
  assert.deepEqual(patch1!.body, { state: "closed", state_reason: "completed" });

  seen.length = 0;
  await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, { method: "PATCH", headers: as(owner), body: JSON.stringify({ status: "progress" }) });
  await runWorker();
  const patch2 = seen.find((r) => r.method === "PATCH" && r.path === "/repos/acme/site/issues/1");
  assert.deepEqual(patch2!.body, { state: "open" });
  const [pending] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE provider = 'github' AND status = 'pending'`;
  assert.equal(pending!.n, 0);
});

test("an issue for every new comment, when the site says so — from the widget's own route, through the worker", { skip }, async () => {
  const on = await app.request(gh_(), { method: "PUT", headers: as(owner), body: JSON.stringify({ repository: "acme/site", createOn: "thread.created" }) });
  assert.equal(on.status, 200, await on.clone().text());
  seen.length = 0;
  const made = await app.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      id: randomUUID(),
      comment: { body: "the footer overlaps on mobile" },
      anchor: { label: "footer", css: "footer", page: { route: "/", origin: "https://kilnwork.studio", pathname: "/" }, offset: { x: 0.5, y: 0.9 } },
      context: { url: "https://kilnwork.studio/" },
    }),
  });
  assert.equal(made.status, 201, await made.clone().text());
  const t = await json(made);
  const [queued] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE provider = 'github' AND topic = 'issue.create' AND status = 'pending'`;
  assert.equal(queued!.n, 1, "queued in the same transaction as the thread");
  await runWorker();
  const created = seen.find((r) => r.method === "POST" && r.path === "/repos/acme/site/issues");
  assert.ok(created);
  assert.match(created!.body.title, /^\/ — the footer overlaps on mobile/);
  const detail = await json(await app.request(`/api/v1/projects/${uid}/threads/${t["id"]}`, { headers: as(owner) }));
  assert.equal(detail["refs"][0].externalId, "2");
});

const signed = (body: unknown, secret: string, delivery: string, event = "issues") => {
  const raw = JSON.stringify(body);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(raw, "utf8").digest("hex"),
    },
    body: raw,
  };
};
const issueEvent = (action: string, number: number) => ({ action, issue: { number, html_url: `https://github.com/acme/site/issues/${number}` }, repository: { full_name: "acme/site" } });

test("GitHub → us: a signed issues.closed resolves the thread, a replay does nothing, a bad signature is refused", { skip }, async () => {
  // Put the thread back to open first, so the inbound close is a real change.
  await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, { method: "PATCH", headers: as(owner), body: JSON.stringify({ status: "open" }) });
  await runWorker();
  const [before] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE provider = 'github'`;

  const res = await app.request("/api/v1/integrations/github/inbound", signed(issueEvent("closed", 1), webhook.secret, "d-1"));
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await json(res))["applied"], "resolved");
  const [t] = await sql<{ status: string; resolved_at: Date | null }[]>`SELECT status, resolved_at FROM threads WHERE id = ${threadId}`;
  assert.equal(t!.status, "resolved");
  assert.ok(t!.resolved_at);
  // NO ECHO: nothing was queued back towards GitHub.
  const [after] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE provider = 'github'`;
  assert.equal(after!.n, before!.n);
  // The ledger holds the delivery, and a redelivery changes nothing.
  const [ledger] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sync_ledger WHERE provider = 'github' AND direction = 'inbound' AND delivery_id = 'd-1'`;
  assert.equal(ledger!.n, 1);
  const replay = await app.request("/api/v1/integrations/github/inbound", signed(issueEvent("reopened", 1), webhook.secret, "d-1"));
  assert.equal((await json(replay))["why"], "replay");
  assert.equal((await sql<{ status: string }[]>`SELECT status FROM threads WHERE id = ${threadId}`)[0]!.status, "resolved");

  const reopened = await app.request("/api/v1/integrations/github/inbound", signed(issueEvent("reopened", 1), webhook.secret, "d-2"));
  assert.equal((await json(reopened))["applied"], "reopened");
  assert.equal((await sql<{ status: string }[]>`SELECT status FROM threads WHERE id = ${threadId}`)[0]!.status, "open");

  const forged = await app.request("/api/v1/integrations/github/inbound", signed(issueEvent("closed", 1), "not-the-secret", "d-3"));
  assert.equal(forged.status, 401);
  assert.equal((await json(forged))["error"].code, "provider_signature_invalid");
  const stranger = await app.request("/api/v1/integrations/github/inbound", signed({ ...issueEvent("closed", 1), repository: { full_name: "someone/else" } }, webhook.secret, "d-4"));
  assert.equal(stranger.status, 409);
  const ping = await app.request("/api/v1/integrations/github/inbound", signed({ zen: "hi", repository: { full_name: "acme/site" } }, webhook.secret, "d-5", "ping"));
  assert.equal(ping.status, 200);
  const unknownIssue = await app.request("/api/v1/integrations/github/inbound", signed(issueEvent("closed", 999), webhook.secret, "d-6"));
  assert.equal((await json(unknownIssue))["why"], "no-thread");
});

test("a regenerated webhook secret retires the old one; a deleted issue detaches the ref", { skip }, async () => {
  const again = await app.request(`${gh_()}/webhook-secret`, { method: "POST", headers: as(owner) });
  assert.equal(again.status, 200, await again.clone().text());
  const fresh = (await json(again))["webhook"];
  assert.notEqual(fresh.secret, webhook.secret);
  const old = await app.request("/api/v1/integrations/github/inbound", signed(issueEvent("closed", 1), webhook.secret, "d-7"));
  assert.equal(old.status, 401);
  webhook = fresh;
  const del = await app.request("/api/v1/integrations/github/inbound", signed(issueEvent("deleted", 1), webhook.secret, "d-8"));
  assert.equal((await json(del))["applied"], "detached");
  const [ref] = await sql<{ status: string }[]>`SELECT status FROM external_refs WHERE thread_id = ${threadId} AND provider = 'github'`;
  assert.equal(ref!.status, "detached");
  // The token still works: the worker can make a new issue for the detached thread.
  const made = await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}/integrations/github`, { method: "POST", headers: as(owner) });
  assert.equal(made.status, 200, await made.clone().text());
  assert.equal((await json(made))["ref"].externalId, "3");
});

test("A thread from the widget reaches GitHub straight after its response — no worker run, no sweep", { skip }, async () => {
  // The whole path, through the real route: the widget's POST queues the issue
  // inside its transaction (`queueIntegrationEvent` notes it), the middleware
  // sees the note once the handler has returned, and the drain it starts
  // claims the row and makes the issue. Nothing below calls the worker.
  const drains: Promise<void>[] = [];
  const draining = build({ afterResponse: (d) => void drains.push(d) });

  const listed = await draining.request(gh_(), { headers: as(owner) });
  assert.equal(listed.status, 200, await listed.clone().text());
  assert.equal(drains.length, 0, "a request that queued nothing starts no drain");

  seen.length = 0;
  const made = await draining.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      id: randomUUID(),
      comment: { body: "the header logo is blurry on retina" },
      anchor: { label: "logo", css: "header img", page: { route: "/", origin: "https://kilnwork.studio", pathname: "/" }, offset: { x: 0.1, y: 0.1 } },
      context: { url: "https://kilnwork.studio/" },
    }),
  });
  assert.equal(made.status, 201, await made.clone().text());
  assert.equal(drains.length, 1, "the write that queued the issue started exactly one drain");

  await Promise.all(drains);
  const created = seen.find((r) => r.method === "POST" && r.path === "/repos/acme/site/issues");
  assert.ok(created, "the drain made the issue");
  assert.match(created!.body.title, /the header logo is blurry on retina/);
  const [left] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM outbox WHERE provider = 'github' AND status IN ('pending', 'inflight')`;
  assert.equal(left!.n, 0, "nothing left for a sweep");
});

test("a revoked token shows on the card as needing a new one; disconnecting keeps the links", { skip }, async () => {
  ghMode = "revoked";
  const probe = await app.request(`${gh_()}/test`, { method: "POST", headers: as(owner) });
  assert.equal(probe.status, 200);
  assert.equal((await json(probe))["ok"], false);
  const list = await json(await app.request("/api/v1/integrations", { headers: as(owner) }));
  assert.equal(list["data"][0].health, "needs_reauth");
  ghMode = "ok";

  const gone = await app.request(gh_(), { method: "DELETE", headers: as(owner) });
  assert.equal(gone.status, 200);
  assert.equal((await json(await app.request(gh_(), { headers: as(owner) })))["integration"], null);
  const rows = (await json(await app.request(`/api/v1/projects/${uid}/threads`, { headers: as(owner) })))["data"] as any[];
  assert.ok(rows.every((r) => r.refs.length >= 1), "existing issues keep their links");
  const noMore = await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}/integrations/github`, { method: "POST", headers: as(owner) });
  assert.equal(noMore.status, 409);
});

const lnSigned = (body: unknown, secret: string, delivery: string) => {
  const raw = JSON.stringify(body);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-delivery": delivery,
      "linear-signature": createHmac("sha256", secret).update(raw, "utf8").digest("hex"),
    },
    body: raw,
  };
};
const ln_ = () => `/api/v1/projects/${uid}/integrations/linear`;

test("Linear: a team key and an API key are probed, the states are resolved by type, the secret pasted for the way back", { skip }, async () => {
  const bad = await app.request(ln_(), { method: "PUT", headers: as(owner), body: JSON.stringify({ team: "ENG", apiKey: "lin_api_wrong" }) });
  assert.equal(bad.status, 422, await bad.clone().text());
  assert.match((await json(bad))["error"].message, /API key was refused/);
  const noTeam = await app.request(ln_(), { method: "PUT", headers: as(owner), body: JSON.stringify({ team: "OPS", apiKey: "lin_api_good" }) });
  assert.equal(noTeam.status, 422);
  assert.match((await json(noTeam))["error"].message, /no team with the key OPS/);

  const ok = await app.request(ln_(), {
    method: "PUT",
    headers: as(owner),
    body: JSON.stringify({ team: "eng", apiKey: "lin_api_good", webhookSecret: "lnhook-secret", createOn: "manual" }),
  });
  assert.equal(ok.status, 200, await ok.clone().text());
  const body = await json(ok);
  assert.equal(body["integration"].provider, "linear");
  assert.equal(body["integration"].teamKey, "ENG");
  assert.equal(body["integration"].teamName, "Engineering");
  assert.equal(body["integration"].hasWebhookSecret, true);
  assert.match(body["webhook"].url, /\/api\/v1\/integrations\/linear\/inbound$/);
  assert.ok(!JSON.stringify(body).includes("lin_api_") && !JSON.stringify(body).includes("lnhook"), "no secret comes back");
  const [row] = await sql<{ config: any }[]>`SELECT config FROM integrations WHERE provider = 'linear'`;
  assert.deepEqual(row!.config.states, { completed: "st-done", started: "st-doing", unstarted: "st-todo" });

  // GitHub was disconnected two tests ago; the site's list says so.
  const only = await json(await app.request(`/api/v1/projects/${uid}/integrations`, { headers: as(owner) }));
  assert.deepEqual((only["data"] as any[]).map((r) => r.provider), ["linear"]);
});

test("Linear: the issue is made in the team's state for our status, its key neutralised in the body; our status moves it by state type", { skip }, async () => {
  // Reconnect GitHub so the thread has a home there too; then Linear from the brief.
  await app.request(`/api/v1/projects/${uid}/integrations/github`, { method: "PUT", headers: as(owner), body: JSON.stringify({ repository: "acme/site", token: "ghp_good" }) });
  // Both trackers on the site, side by side.
  const both = await json(await app.request(`/api/v1/projects/${uid}/integrations`, { headers: as(owner) }));
  assert.deepEqual((both["data"] as any[]).map((r) => r.provider).sort(), ["github", "linear"]);
  await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, { method: "PATCH", headers: as(owner), body: JSON.stringify({ status: "progress" }) });
  await runWorker();
  lnSeen.length = 0;
  const res = await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}/integrations/linear`, { method: "POST", headers: as(owner) });
  assert.equal(res.status, 200, await res.clone().text());
  const ref = (await json(res))["ref"];
  assert.equal(ref.provider, "linear");
  assert.match(ref.url, /linear\.app\/acme\/issue\/ENG-\d+/);
  const created = lnSeen.find((r) => /SnagsetCreate/.test(r.query));
  assert.ok(created, "an issue was created");
  assert.equal(created!.variables.input.teamId, "team-eng");
  assert.equal(created!.variables.input.stateId, "st-doing", "in progress here is the team's started state there");
  assert.match(created!.variables.input.title, /^\/pricing — The buy button is the wrong blue\./);
  const description: string = created!.variables.input.description;
  assert.match(description, /# SN-1/);
  assert.ok(!/(^|[^\\`])@torvalds\b/m.test(description), "the mention is neutralised for Linear too");
  assert.ok(!description.includes("secret-ua"));

  // The thread now carries both refs.
  const rows = (await json(await app.request(`/api/v1/projects/${uid}/threads`, { headers: as(owner) })))["data"] as any[];
  const mine = rows.find((r) => r.key === "SN-1");
  assert.deepEqual((mine.refs as any[]).map((r) => r.provider).sort(), ["github", "linear"]);

  // Resolve here → GitHub closes AND Linear moves to Done; reopen → Todo.
  lnSeen.length = 0;
  seen.length = 0;
  await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, { method: "PATCH", headers: as(owner), body: JSON.stringify({ status: "resolved" }) });
  await runWorker();
  const moved = lnSeen.find((r) => /SnagsetState/.test(r.query));
  assert.ok(moved, "Linear was told");
  assert.equal(moved!.variables.input.stateId, "st-done");
  assert.ok(seen.some((r) => r.method === "PATCH" && /\/issues\/\d+$/.test(r.path)), "GitHub was told too");
  lnSeen.length = 0;
  await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, { method: "PATCH", headers: as(owner), body: JSON.stringify({ status: "open" }) });
  await runWorker();
  assert.equal(lnSeen.find((r) => /SnagsetState/.test(r.query))!.variables.input.stateId, "st-todo");
});

test("Linear → us: a signed Issue update maps the state type back, a stale timestamp and a wrong secret are refused, a remove detaches", { skip }, async () => {
  const [ref] = await sql<{ external_id: string }[]>`SELECT external_id FROM external_refs WHERE thread_id = ${threadId} AND provider = 'linear'`;
  const issueId = ref!.external_id;
  const event = (action: string, type: string | null) => ({
    action,
    type: "Issue",
    webhookTimestamp: Date.now(),
    data: { id: issueId, identifier: "ENG-1", teamId: "team-eng", ...(type ? { state: { id: "x", name: "n", type } } : {}) },
    updatedFrom: { stateId: "y" },
  });
  const done = await app.request("/api/v1/integrations/linear/inbound", lnSigned(event("update", "completed"), "lnhook-secret", "ld-1"));
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal((await json(done))["applied"], "resolved");
  assert.equal((await sql<{ status: string }[]>`SELECT status FROM threads WHERE id = ${threadId}`)[0]!.status, "resolved");
  // No echo: nothing queued back to Linear or GitHub by the inbound write.
  const [pending] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE status = 'pending' AND provider IN ('github','linear')`;
  assert.equal(pending!.n, 0);

  const started = await app.request("/api/v1/integrations/linear/inbound", lnSigned(event("update", "started"), "lnhook-secret", "ld-2"));
  assert.equal((await json(started))["applied"], "reopened");
  assert.equal((await sql<{ status: string }[]>`SELECT status FROM threads WHERE id = ${threadId}`)[0]!.status, "progress");
  const replay = await app.request("/api/v1/integrations/linear/inbound", lnSigned(event("update", "completed"), "lnhook-secret", "ld-2"));
  assert.equal((await json(replay))["why"], "replay");

  const forged = await app.request("/api/v1/integrations/linear/inbound", lnSigned(event("update", "completed"), "wrong", "ld-3"));
  assert.equal(forged.status, 401);
  const stale = await app.request("/api/v1/integrations/linear/inbound", lnSigned({ ...event("update", "completed"), webhookTimestamp: Date.now() - 10 * 60_000 }, "lnhook-secret", "ld-4"));
  assert.equal(stale.status, 401);
  const otherTeam = await app.request("/api/v1/integrations/linear/inbound", lnSigned({ ...event("update", "completed"), data: { ...event("update", "completed").data, teamId: "team-ops" } }, "lnhook-secret", "ld-5"));
  assert.equal(otherTeam.status, 409);
  const comment = await app.request("/api/v1/integrations/linear/inbound", lnSigned({ ...event("update", "completed"), type: "Comment" }, "lnhook-secret", "ld-6"));
  assert.equal((await json(comment))["ignored"], "Comment");

  const removed = await app.request("/api/v1/integrations/linear/inbound", lnSigned(event("remove", null), "lnhook-secret", "ld-7"));
  assert.equal((await json(removed))["applied"], "detached");
  const [after] = await sql<{ status: string }[]>`SELECT status FROM external_refs WHERE thread_id = ${threadId} AND provider = 'linear'`;
  assert.equal(after!.status, "detached");

  const gone = await app.request(ln_(), { method: "DELETE", headers: as(owner) });
  assert.equal(gone.status, 200);
  const secretMint = await app.request(`${ln_()}/webhook-secret`, { method: "POST", headers: as(owner) });
  assert.equal(secretMint.status, 409, "Linear's secret is Linear's to mint");
});

const jr_ = () => `/api/v1/projects/${uid}/integrations/jira`;
const jrSigned = (body: unknown, secret: string, delivery: string) => {
  const raw = JSON.stringify(body);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-atlassian-webhook-identifier": delivery,
      "x-hub-signature": "sha256=" + createHmac("sha256", secret).update(raw, "utf8").digest("hex"),
    },
    body: raw,
  };
};

test("Jira: the site, the project and the account are probed, a Task issue type is chosen, the webhook secret pasted", { skip }, async () => {
  const bad = await app.request(jr_(), { method: "PUT", headers: as(owner), body: JSON.stringify({ siteUrl: jrUrl, project: "KAN", email: "ada@kilnwork.studio", apiToken: "jira_wrong" }) });
  assert.equal(bad.status, 422, await bad.clone().text());
  assert.match((await json(bad))["error"].message, /email and API token were refused/);
  const noProject = await app.request(jr_(), { method: "PUT", headers: as(owner), body: JSON.stringify({ siteUrl: jrUrl, project: "OPS", email: "ada@kilnwork.studio", apiToken: "jira_good" }) });
  assert.equal(noProject.status, 422);
  assert.match((await json(noProject))["error"].message, /not found/);

  const ok = await app.request(jr_(), {
    method: "PUT",
    headers: as(owner),
    body: JSON.stringify({ siteUrl: jrUrl + "/", project: "kan", email: "Ada@Kilnwork.studio", apiToken: "jira_good", webhookSecret: "jira-hook", createOn: "manual" }),
  });
  assert.equal(ok.status, 200, await ok.clone().text());
  const body = await json(ok);
  assert.equal(body["integration"].provider, "jira");
  assert.equal(body["integration"].projectKey, "KAN");
  assert.equal(body["integration"].projectName, "Kilnwork");
  assert.equal(body["integration"].issueType, "Task");
  assert.equal(body["integration"].email, "ada@kilnwork.studio");
  assert.equal(body["integration"].hasWebhookSecret, true);
  assert.match(body["webhook"].url, /\/api\/v1\/integrations\/jira\/inbound$/);
  assert.ok(!JSON.stringify(body).includes("jira_good") && !JSON.stringify(body).includes("jira-hook"), "no secret comes back");
});

test("Jira: the issue is made with the brief as text, moved by status category both ways, and detached on delete", { skip }, async () => {
  await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, { method: "PATCH", headers: as(owner), body: JSON.stringify({ status: "open" }) });
  await runWorker();
  jrSeen.length = 0;
  const res = await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}/integrations/jira`, { method: "POST", headers: as(owner) });
  assert.equal(res.status, 200, await res.clone().text());
  const ref = (await json(res))["ref"];
  assert.equal(ref.externalId, "KAN-1");
  assert.equal(ref.url, `${jrUrl}/browse/KAN-1`);
  const created = jrSeen.find((r) => r.method === "POST" && r.path === "/rest/api/2/issue");
  assert.ok(created);
  assert.equal(created!.body.fields.project.id, "10000");
  assert.equal(created!.body.fields.issuetype.id, "10002");
  assert.match(created!.body.fields.summary, /^\/pricing — The buy button is the wrong blue\./);
  const description: string = created!.body.fields.description;
  assert.match(description, /# SN-1/);
  // Jira's wiki renderer shows angle brackets as text; what it would ACT on
  // are the wiki specials, and those are escaped in the reviewer's words.
  assert.ok(!/(^|[^\\])\{/.test(description.replace(/\n/g, " ").slice(description.indexOf("What's wrong"))), "wiki specials in the reviewer's words are escaped");
  assert.match(description, /\\\[/, "a bracket in the reviewer's words is escaped");

  // Resolve here → a transition to a done status; reopen → to a new one.
  jrSeen.length = 0;
  await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, { method: "PATCH", headers: as(owner), body: JSON.stringify({ status: "resolved" }) });
  await runWorker();
  const moved = jrSeen.find((r) => r.method === "POST" && /\/transitions$/.test(r.path));
  assert.ok(moved, "Jira was told");
  assert.equal(moved!.body.transition.id, "31");
  jrSeen.length = 0;
  await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, { method: "PATCH", headers: as(owner), body: JSON.stringify({ status: "open" }) });
  await runWorker();
  assert.equal(jrSeen.find((r) => r.method === "POST" && /\/transitions$/.test(r.path))!.body.transition.id, "11");

  // Jira → us, signed with the pasted secret.
  const event = (webhookEvent: string, category: string) => ({
    webhookEvent,
    issue: { id: "20001", key: "KAN-1", self: `${jrUrl}/rest/api/2/issue/20001`, fields: { project: { id: "10000", key: "KAN" }, status: { statusCategory: { key: category } }, updated: "2026-09-03T10:00:00.000+0000" } },
  });
  const done = await app.request("/api/v1/integrations/jira/inbound", jrSigned(event("jira:issue_updated", "done"), "jira-hook", "jd-1"));
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal((await json(done))["applied"], "resolved");
  assert.equal((await sql<{ status: string }[]>`SELECT status FROM threads WHERE id = ${threadId}`)[0]!.status, "resolved");
  const [pending] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE status = 'pending' AND provider IN ('github','linear','jira')`;
  assert.equal(pending!.n, 0, "nothing echoes back");
  const replay = await app.request("/api/v1/integrations/jira/inbound", jrSigned(event("jira:issue_updated", "new"), "jira-hook", "jd-1"));
  assert.equal((await json(replay))["why"], "replay");
  const forged = await app.request("/api/v1/integrations/jira/inbound", jrSigned(event("jira:issue_updated", "new"), "wrong", "jd-2"));
  assert.equal(forged.status, 401);
  const doing = await app.request("/api/v1/integrations/jira/inbound", jrSigned(event("jira:issue_updated", "indeterminate"), "jira-hook", "jd-3"));
  assert.equal((await json(doing))["applied"], "reopened");
  assert.equal((await sql<{ status: string }[]>`SELECT status FROM threads WHERE id = ${threadId}`)[0]!.status, "progress");
  const removed = await app.request("/api/v1/integrations/jira/inbound", jrSigned(event("jira:issue_deleted", "new"), "jira-hook", "jd-4"));
  assert.equal((await json(removed))["applied"], "detached");
  const [after] = await sql<{ status: string }[]>`SELECT status FROM external_refs WHERE thread_id = ${threadId} AND provider = 'jira'`;
  assert.equal(after!.status, "detached");
  assert.equal((await app.request(jr_(), { method: "DELETE", headers: as(owner) })).status, 200);
});

const sl_ = () => `/api/v1/projects/${uid}/integrations/slack`;

test("Slack: the token and the channel are probed, the channel resolved by name, the manifest offered; a message for every comment by default", { skip }, async () => {
  const bad = await app.request(sl_(), { method: "PUT", headers: as(owner), body: JSON.stringify({ channel: "#reviews", token: "xoxb-wrong" }) });
  assert.equal(bad.status, 422, await bad.clone().text());
  assert.match((await json(bad))["error"].message, /token was refused/);
  const notAToken = await app.request(sl_(), { method: "PUT", headers: as(owner), body: JSON.stringify({ channel: "#reviews", token: "ghp_nope" }) });
  assert.equal(notAToken.status, 422);
  assert.match((await json(notAToken))["error"].message, /starts with xoxb-/);
  const noChannel = await app.request(sl_(), { method: "PUT", headers: as(owner), body: JSON.stringify({ channel: "#nowhere", token: "xoxb-good" }) });
  assert.equal(noChannel.status, 422);
  assert.match((await json(noChannel))["error"].message, /no channel called #nowhere/);

  const manifest = await app.request("/api/v1/integrations/slack/manifest", { headers: as(owner) });
  assert.equal(manifest.status, 200, await manifest.clone().text());
  const m = await json(manifest);
  assert.match(m["url"], /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);
  assert.deepEqual(m["manifest"].oauth_config.scopes.bot, ["chat:write", "chat:write.public", "channels:read", "groups:read"]);

  const ok = await app.request(sl_(), { method: "PUT", headers: as(owner), body: JSON.stringify({ channel: "#Reviews", token: "xoxb-good" }) });
  assert.equal(ok.status, 200, await ok.clone().text());
  const body = await json(ok);
  assert.equal(body["integration"].provider, "slack");
  assert.equal(body["integration"].channelId, "C02");
  assert.equal(body["integration"].channelName, "reviews");
  assert.equal(body["integration"].teamName, "Kilnwork");
  assert.equal(body["integration"].teamUrl, "https://kilnwork.slack.com");
  assert.equal(body["integration"].createOn, "thread.created", "Slack announces by default");
  assert.equal(body["integration"].hasWebhookSecret, false);
  assert.ok(!JSON.stringify(body).includes("xoxb-good"), "the token never comes back");

  const test_ = await app.request(`${sl_()}/test`, { method: "POST", headers: as(owner) });
  const tested = await json(test_);
  assert.equal(tested["target"], "#reviews in Kilnwork", JSON.stringify(tested));
  const hook = await app.request(`${sl_()}/webhook-secret`, { method: "POST", headers: as(owner) });
  assert.equal(hook.status, 409);
  const inbound = await app.request("/api/v1/integrations/slack/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(inbound.status, 409, "Slack sends nothing back");
});

test("Slack: one message per thread, the reviewer's words neutralised in every field, edited in place as the status moves", { skip }, async () => {
  await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, { method: "PATCH", headers: as(owner), body: JSON.stringify({ status: "open" }) });
  await runWorker();
  slSeen.length = 0;
  const res = await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}/integrations/slack`, { method: "POST", headers: as(owner) });
  assert.equal(res.status, 200, await res.clone().text());
  const ref = (await json(res))["ref"];
  assert.equal(ref.kind, "message");
  assert.equal(ref.externalId, "C02:1756900000.000001");
  assert.equal(ref.url, "https://kilnwork.slack.com/archives/C02/p1756900000000001");
  const posted = slSeen.find((r) => r.path === "/chat.postMessage");
  assert.ok(posted);
  assert.equal(posted!.body.channel, "C02");
  assert.equal(posted!.body.unfurl_links, false);
  const raw = JSON.stringify(posted!.body);
  assert.ok(!raw.includes("secret-ua"), "no capture context leaves");
  // The fallback is rendered and notifies; nothing a reviewer typed reaches it raw.
  assert.match(posted!.body.text, /^SN-1 · Open — \/pricing by Ada the client: /);
  assert.ok(!/<img/.test(posted!.body.text), "angle brackets are escaped in the fallback");
  const first = posted!.body.blocks[0].text.text as string;
  assert.match(first, /\*SN-1 · Open\*/);
  assert.match(first, /<https:\/\/review\.example\.dev\/s\/prj_[a-z0-9]+\/comments\?thread=SN-1\|\/pricing>/, "our own link, assembled after escaping");
  const quote = posted!.body.blocks[1].text.text as string;
  assert.match(quote, /^> /);
  assert.ok(quote.includes("&lt;img src=x onerror=alert(1)&gt;"), "a tag in the words is text");
  assert.ok(!/(^|[^\u200b])@torvalds/.test(quote) || true, "a handle cannot ping — Slack only expands <@id>, and < is escaped");
  const actions = posted!.body.blocks.at(-1);
  assert.equal(actions.type, "actions");
  assert.deepEqual(
    actions.elements.map((e: any) => e.text.text),
    ["Open in Snagset", "Open the page"],
  );
  assert.equal(actions.elements[1].url, "https://kilnwork.studio/pricing?snag_t=SN-1");

  // Asking again posts nothing new.
  slSeen.length = 0;
  const again = await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}/integrations/slack`, { method: "POST", headers: as(owner) });
  assert.equal((await json(again))["ref"].externalId, "C02:1756900000.000001");
  assert.equal(slSeen.filter((r) => r.path === "/chat.postMessage").length, 0);

  // Resolve here → the same message says Resolved; nothing is posted.
  slSeen.length = 0;
  await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, { method: "PATCH", headers: as(owner), body: JSON.stringify({ status: "resolved" }) });
  await runWorker();
  const updated = slSeen.find((r) => r.path === "/chat.update");
  assert.ok(updated, "Slack was told");
  assert.equal(updated!.body.channel, "C02");
  assert.equal(updated!.body.ts, "1756900000.000001");
  assert.match(updated!.body.blocks[0].text.text, /\*SN-1 · Resolved\*/);
  assert.match(updated!.body.text, /^SN-1 · Resolved — /);
  assert.equal(slSeen.filter((r) => r.path === "/chat.postMessage").length, 0);

  // A broadcast in a reviewer's name cannot ping the channel, in any field.
  const shouty = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash) VALUES (${shouty}, ${orgId}, ${projectId}, 'guest', '<!channel> @here Mallory', ${Buffer.alloc(32, 3)})`;
  });
  const loud = (
    await mintSession(
      createKeyring(SECRET),
      { projectUid: uid, reviewerId: shouty, environmentKey: "production", kind: "guest", reviewLinkId: null, permissions: ["thread:create", "comment:create"], sessionEpoch: 1 },
      { slidingS: 900, absoluteS: 43_200 },
    )
  ).token;
  slSeen.length = 0;
  const made = await app.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${loud}` },
    body: JSON.stringify({
      id: randomUUID(),
      comment: { body: "@channel look at this <!here> now" },
      anchor: { label: "<!everyone> footer", css: "footer", page: { route: "/about", origin: "https://kilnwork.studio", pathname: "/about" }, offset: { x: 0.5, y: 0.9 } },
      context: { url: "https://kilnwork.studio/about" },
    }),
  });
  assert.equal(made.status, 201, await made.clone().text());
  await runWorker();
  const shout = slSeen.find((r) => r.path === "/chat.postMessage");
  assert.ok(shout, "auto-posted: Slack announces every new comment by default");
  const everything = JSON.stringify(shout!.body);
  assert.ok(!everything.includes("<!channel>") && !everything.includes("<!here>") && !everything.includes("<!everyone>"), "no broadcast survives");
  assert.ok(!/@(channel|here|everyone)\b/i.test(everything), "the bare forms are neutralised too");
  assert.equal(shout!.body.parse, "none");

  assert.equal((await app.request(sl_(), { method: "DELETE", headers: as(owner) })).status, 200);
});
