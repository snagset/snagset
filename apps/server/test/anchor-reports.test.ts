import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { mintSession } from "../src/session.ts";
import { createKeyring } from "../src/keys.ts";
import { createProject } from "../src/projects.ts";

/**
 * Anchor outcome reporting, end to end through the real routes.
 *
 * Every thread here is created by POSTing to `/threads` and every report by
 * POSTing to `/anchor-reports`; nothing is seeded straight into the tables.
 * That is deliberate and it is a lesson rather than a preference — a suite
 * that seeds its own fixtures went green twice over a completely broken write
 * path, because it never asked the route to do anything.
 *
 * The property under test is the one 03 rejected `PATCH` to protect: a
 * reviewer on a phone whose cascade fails must not orphan a pin for the whole
 * team, and a report that lowers the state must be RECORDED and not APPLIED.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the anchor-report tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let uid: string;
let projectId: string;
let orgId: string;
let bearer: string;

const SECRET = Buffer.alloc(32, 13).toString("base64url");
const PASSWORD = "correct horse battery staple";

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) {
    throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  }
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});

  orgId = randomUUID();
  const userId = randomUUID();
  const reviewerId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`
      INSERT INTO users (id, org_id, email, password_hash)
      VALUES (${userId}, ${orgId}, 'o@e.test', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    const p = await createProject(tx, {
      orgId,
      name: "Anchors",
      createdBy: userId,
      origins: ["https://anchor.test"],
      graceHours: 24,
    });
    projectId = p.id;
    uid = p.uid;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
      VALUES (${reviewerId}, ${orgId}, ${projectId}, 'guest', 'Ada', ${Buffer.alloc(32, 2)})`;
  });

  app = createApp({
    sql,
    cfg: loadConfig({ DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
  });

  bearer = (
    await mintSession(
      createKeyring(SECRET),
      {
        projectUid: uid,
        reviewerId,
        environmentKey: "production",
        kind: "guest",
        reviewLinkId: null,
        permissions: ["thread:create", "comment:create", "thread:resolve"],
        sessionEpoch: 1,
      },
      { slidingS: 900, absoluteS: 43_200 },
    )
  ).token;
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

const asReviewer = () => ({
  "content-type": "application/json",
  authorization: `Bearer ${bearer}`,
  origin: "https://anchor.test",
});

/** A thread, through the real route. */
async function makeThread(body: string): Promise<string> {
  const res = await app.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: asReviewer(),
    body: JSON.stringify({
      comment: { body },
      anchor: {
        offset: { x: 0.5, y: 0.5 },
        page: { route: "/", pathname: "/", origin: "https://anchor.test" },
      },
      context: { url: "https://anchor.test/" },
    }),
  });
  const t = (await res.json()) as { id: string };
  assert.equal(res.status, 201, JSON.stringify(t));
  return t.id;
}

const report = (reports: unknown[]) =>
  app.request(`/api/v1/projects/${uid}/anchor-reports`, {
    method: "POST",
    headers: asReviewer(),
    body: JSON.stringify({ reports }),
  });

const stateOf = async (id: string) =>
  (
    await sql<{ anchor_state: string; version: number; anchor_state_build: string | null }[]>`
      SELECT anchor_state, version, anchor_state_build FROM threads WHERE id = ${id.replace(/^thr_/, "")}
    `
  )[0]!;

const eventsFor = async (id: string) =>
  await sql<{ state: string; applied: boolean; strategy: string; ms: number | null }[]>`
    SELECT state, applied, strategy, ms FROM anchor_events
    WHERE thread_id = ${id.replace(/^thr_/, "")} ORDER BY at
  `;

// ── the merge ────────────────────────────────────────────────────────────

test("a LOWERING report is recorded and not applied — the phone does not orphan the pin", { skip }, async () => {
  const id = await makeThread("still here");
  const before_ = await stateOf(id);
  assert.equal(before_.anchor_state, "anchored", "a fresh pin starts anchored");

  const res = await report([
    { threadId: id, state: "orphaned", confidence: 0.2, strategy: "none", ms: 12 },
  ]);
  assert.equal(res.status, 204, "always 204 — a reviewer never sees an error over a pin");

  const after_ = await stateOf(id);
  assert.equal(after_.anchor_state, "anchored", "the whole team's pin survives one failing client");
  assert.equal(after_.version, before_.version, "telemetry does not bump version, so no client is woken");

  const [ev] = await eventsFor(id);
  assert.equal(ev?.state, "orphaned", "the disagreement IS recorded — that is the telemetry");
  assert.equal(ev?.applied, false, "…flagged as not applied, which is what makes the merge auditable");
  assert.equal(ev?.ms, 12);
});

test("a NEW BUILD is allowed to make a pin worse — monotonic, not a ratchet", { skip }, async () => {
  const id = await makeThread("moved in the rebuild");
  await report([{ threadId: id, state: "anchored", confidence: 1, strategy: "testid", build: "aaa" }]);
  assert.equal((await stateOf(id)).anchor_state, "anchored");

  await report([{ threadId: id, state: "orphaned", confidence: 0.1, strategy: "none", build: "bbb" }]);
  const after_ = await stateOf(id);
  assert.equal(after_.anchor_state, "orphaned", "a rebuild is exactly when a regression is real");
  assert.equal(after_.anchor_state_build, "bbb");
});

test("within one build the MAXIMUM wins, whichever order it arrives in", { skip }, async () => {
  const id = await makeThread("two clients disagree");
  await report([{ threadId: id, state: "orphaned", confidence: 0.1, strategy: "none", build: "ccc" }]);
  assert.equal((await stateOf(id)).anchor_state, "orphaned", "new build resets, so it lands");

  await report([
    { threadId: id, state: "approximate", confidence: 0.6, strategy: "path-rect", build: "ccc" },
  ]);
  assert.equal((await stateOf(id)).anchor_state, "approximate", "better beats worse…");

  await report([{ threadId: id, state: "orphaned", confidence: 0.1, strategy: "css", build: "ccc" }]);
  assert.equal((await stateOf(id)).anchor_state, "approximate", "…and worse never beats better");
});

// ── the guards ───────────────────────────────────────────────────────────

test("the same (thread, build, strategy) twice inside a minute is ONE observation", { skip }, async () => {
  const id = await makeThread("a re-rendering SPA");
  const body = { threadId: id, state: "approximate", confidence: 0.5, strategy: "path-rect", build: "ddd" };
  await report([body]);
  await report([body]);
  await report([body]);
  assert.equal(
    (await eventsFor(id)).length,
    1,
    "four resolutions of one pin in a second are one observation seen four times",
  );
});

test("an unknown strategy is 422 — a table that accepts anything measures nothing", { skip }, async () => {
  const id = await makeThread("bad telemetry");
  const res = await report([
    { threadId: id, state: "anchored", confidence: 1, strategy: "vibes" },
  ]);
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "validation_failed");
  assert.equal((await eventsFor(id)).length, 0, "and nothing was written");
});

test("'pending' is not an outcome", { skip }, async () => {
  const id = await makeThread("not finished yet");
  const res = await report([{ threadId: id, state: "pending", confidence: 0.5, strategy: "css" }]);
  assert.equal(res.status, 400);
  assert.equal((await eventsFor(id)).length, 0);
});

test("a HALF-VALID batch writes none of itself", { skip }, async () => {
  const good = await makeThread("valid half");
  const res = await report([
    { threadId: good, state: "anchored", confidence: 1, strategy: "testid" },
    { threadId: good, state: "anchored", confidence: 1, strategy: "nonsense" },
  ]);
  assert.equal(res.status, 422);
  assert.equal(
    (await eventsFor(good)).length,
    0,
    "the client learns nothing from a 204, so half a batch is unreadable state",
  );
});

test("another project's thread is skipped, never written across the boundary", { skip }, async () => {
  const stranger = randomUUID();
  const res = await report([
    { threadId: `thr_${stranger}`, state: "orphaned", confidence: 0, strategy: "none" },
  ]);
  assert.equal(res.status, 204, "still 204 — telemetry never raises its voice");
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM anchor_events WHERE thread_id = ${stranger}
  `;
  assert.equal(row?.n, 0);
});

test("a batch must be 1..50", { skip }, async () => {
  assert.equal((await report([])).status, 400);
  const id = await makeThread("too many");
  const many = Array.from({ length: 51 }, () => ({
    threadId: id,
    state: "anchored",
    confidence: 1,
    strategy: "testid",
  }));
  assert.equal((await report(many)).status, 400);
});

// ── the body cap ────────────────────────────────────────────────────

test("an oversized JSON body is 413 before it is ever read", { skip }, async () => {
  // SNAGSET_MAX_BODY_BYTES had been in the config registry, cited
  // by name in two specs and printed by `snagset env` — and read by no code at
  // all. Every JSON route would read whatever it was sent, and the only thing
  // between an instance and an OOM was a proxy a self-hoster may not have.
  // `content-length` is set EXPLICITLY, and that is not a cheat. A real HTTP
  // client always sends it (or chunks, which the platform bounds); Hono's
  // in-process `app.request` builds a `Request` that does not, so without this
  // the test would be asserting the limiter's pass-through branch rather than
  // its limit. The middleware documents that an absent length falls through by
  // design — the header check is the cheap 99%, not the security boundary.
  const huge = "x".repeat(300 * 1024);
  const body = JSON.stringify({ comment: { body: huge } });
  const res = await app.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: { ...asReviewer(), "content-length": String(Buffer.byteLength(body)) },
    body,
  });
  assert.equal(res.status, 413);
  const j = (await res.json()) as { error: { code: string; requestId: string } };
  assert.equal(j.error.code, "body_too_large");
  assert.ok(j.error.requestId, "a rejected body still gets an id an operator can grep for");
});

test("the cap is 256 KB for JSON regardless of the operator's binary setting", { skip }, async () => {
  // The design says the JSON cap is not operator-tunable, and it is a different
  // limit from the binary one for a different reason: it protects the parser,
  // and every JSON body this API accepts is small by construction.
  const ok = "x".repeat(100 * 1024);
  const res = await app.request(`/api/v1/projects/${uid}/anchor-reports`, {
    method: "POST",
    headers: asReviewer(),
    body: JSON.stringify({ reports: [], pad: ok }),
  });
  assert.notEqual(res.status, 413, "100 KB is well under the cap and must pass the limiter");
});

test("a GET is never body-capped", { skip }, async () => {
  const res = await app.request(`/api/v1/projects/${uid}/threads`, { headers: asReviewer() });
  assert.equal(res.status, 200);
});
