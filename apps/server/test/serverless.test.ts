import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { connect } from "../src/db/connect.ts";
import { migrate } from "../src/db/migrate.ts";
import { invalidateLimits } from "../src/plan.ts";

/**
 * The serverless entry.
 *
 * The cron route is the interesting half and the reason this file exists. It is
 * a PUBLIC URL on the deployment that opens transactions, takes advisory locks
 * and sends mail. Left unauthenticated it is a denial-of-service and a
 * mail-amplification surface behind one GET, so the tests below are about who
 * is allowed to call it, not about what it returns.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the serverless tests";

let sql: postgres.Sql;
const SECRET = "cron-secret-value";
const KEY = randomBytes(32).toString("base64url");

/** A fresh module instance per case: the entry caches its app in module scope,
 *  which is the behaviour under test in one case and interference in the rest. */
async function load(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  // The harness's own variable must not reach `loadConfig`. The design
  // makes an unknown SNAGSET_* FATAL — which is the rule that catches
  // SNAGSET_MAIL_FORM before it costs somebody an afternoon — and
  // SNAGSET_TEST_DATABASE_URL is deliberately not in the operator registry,
  // because it belongs to this repo's test suite and not to an install. Every
  // other suite passes `loadConfig` an explicit object and never meets this;
  // the serverless entry reads the real `process.env`, so it does.
  delete process.env["SNAGSET_TEST_DATABASE_URL"];

  // ASSIGNED, then DELETED where the value is undefined. `process.env.X =
  // undefined` stores the STRING "undefined", which is truthy — so the two
  // cases below that test a MISSING variable were, in their first version,
  // testing a variable set to the word "undefined" and passing the emptiness
  // check every time.
  const wanted: Record<string, string | undefined> = {
    DATABASE_URL: URL_,
    SNAGSET_BASE_URL: "http://localhost:8080",
    SNAGSET_SECRET_KEY: KEY,
    ...env,
  };
  for (const [k, v] of Object.entries(wanted)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // A query string busts Node's module cache, so each case gets its own
  // module-scope `cached`.
  const mod = (await import(`../src/serverless.ts?case=${Math.random()}`)) as {
    default: { fetch(r: Request): Promise<Response> };
    closeForTests(): Promise<void>;
    createServerlessHandler(o?: { planResolver?: (org: { id: string; plan: string }) => Partial<{ projects: number | null }> }): { fetch(r: Request): Promise<Response>; closeForTests(): Promise<void> };
  };
  return {
    mod,
    restore: async () => {
      // Each case gets its own module instance and therefore its own pool.
      // Without this the runner hangs on handles nothing will close.
      await mod.closeForTests().catch(() => {});
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    },
  };
}

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) {
    throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  }
  sql = connect(URL_!, { max: 2 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
});

after(async () => {
  if (!skip) {
    // The factory test signs a studio up, which claims the instance; the
    // setup suite runs next and refuses a claimed database (its own guard).
    // Every suite that makes an org leaves the schema empty behind it.
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await sql.end();
  }
});

test("with no CRON_SECRET the jobs route refuses EVERYTHING", { skip }, async () => {
  // Visibly broken beats quietly open. An operator who has not set the secret
  // gets a cron that fails loudly in the platform's log, rather than an
  // endpoint the internet can drive.
  const { mod, restore } = await load({ CRON_SECRET: undefined });
  try {
    const res = await mod.default.fetch(new Request("http://x/api/jobs/run"));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, "cron_not_configured");
    assert.match(body.message, /send mail on demand/, "and it says why this matters");
  } finally {
    await restore();
  }
});

test("a wrong or missing token is refused", { skip }, async () => {
  const { mod, restore } = await load({ CRON_SECRET: SECRET });
  try {
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: SECRET.slice(0, -1) }]) {
      const res = await mod.default.fetch(new Request("http://x/api/jobs/run", { headers }));
      assert.equal(res.status, 401, `refused for ${JSON.stringify(headers)}`);
    }
  } finally {
    await restore();
  }
});

test("the platform's own bearer token is accepted and the jobs run", { skip }, async () => {
  const { mod, restore } = await load({ CRON_SECRET: SECRET });
  try {
    const res = await mod.default.fetch(
      new Request("http://x/api/jobs/run", { headers: { authorization: `Bearer ${SECRET}` } }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ms: number; ran: { name: string }[]; failed: unknown[] };
    assert.ok(Array.isArray(body.ran));
    assert.deepEqual(body.failed, [], "a clean instance has nothing to fail on");
    // The reaper jobs are registered even with no bucket and no mailer.
    assert.ok(body.ran.some((r) => r.name === "write-mode-downgrade"));
  } finally {
    await restore();
  }
});

test("a bare token without the Bearer prefix also works", { skip }, async () => {
  // Platforms differ on whether they prefix. Accepting both costs nothing and
  // saves an operator an hour on a 401 with no body.
  const { mod, restore } = await load({ CRON_SECRET: SECRET });
  try {
    const res = await mod.default.fetch(
      new Request("http://x/api/jobs/run", { headers: { authorization: SECRET } }),
    );
    assert.equal(res.status, 200);
  } finally {
    await restore();
  }
});

test("SNAGSET_SECRET_KEY is REQUIRED, and the RESPONSE explains why", { skip }, async () => {
  // The generate-to-disk is bin-only: the filesystem here is ephemeral, so
  // each instance would invent a different key and anything one encrypted
  // would fail to decrypt on the next.
  //
  // ── THIS ASSERTED A SYNCHRONOUS THROW UNTIL 2026-09-01 ──
  //
  // The reasoning was: "a cold start that cannot work should fail on the way
  // up, in the platform's deploy log, rather than resolve a 500 per request
  // forever." The intent was right. The mechanism does not exist — **there is
  // no deploy-time invocation on Vercel.** The deploy succeeds, the function
  // is first called by a real visitor, and the throw renders
  //
  //     This Serverless Function has crashed.
  //     500: INTERNAL_SERVER_ERROR / FUNCTION_INVOCATION_FAILED
  //
  // with the message filed in function logs the operator may not know exist.
  // Measured on a live QA deploy rather than reasoned about: every route —
  // `/`, `/snag.js`, `/api/v1/setup` — returned that page and nothing else.
  //
  // So it answers instead. `503`, because the instance is not broken, it is
  // not configured, and that is a state a proxy may retry. Nothing is cached
  // on the failing path, so setting the variable recovers the instance with no
  // redeploy — which is the half the old design genuinely bought, and this
  // keeps it.
  const { mod, restore } = await load({ SNAGSET_SECRET_KEY: undefined, CRON_SECRET: SECRET });
  try {
    const res: Response = await mod.default.fetch(new Request("http://x/healthz"));
    assert.equal(res.status, 503, "not configured is not the same as broken");
    const body = await res.text();
    assert.match(body, /not configured/i);
    assert.match(body, /SNAGSET_SECRET_KEY is required on serverless/, "the rule");
    assert.match(body, /ephemeral/, "and the reason, not just the rule");
    assert.ok(
      !/password|secret=|postgres:\/\//i.test(body),
      "names only, never values — this response is public and the operator is mid-paste",
    );
  } finally {
    await restore();
  }
});

test("the widget is served on the serverless path too", { skip }, async () => {
  // Same createApp, so the routes added are there — asserted because the
  // whole point of two entry points on one factory is that they cannot differ.
  const { mod, restore } = await load({ CRON_SECRET: SECRET });
  try {
    const res = await mod.default.fetch(new Request("http://x/widget/manifest.json"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { assets: unknown[] };
    assert.ok(Array.isArray(body.assets));
  } finally {
    await restore();
  }
});

test("the private caller's factory: one call with a plan resolver, and its numbers reach /me", { skip }, async () => {
  const { mod, restore } = await load({ CRON_SECRET: SECRET, SNAGSET_SIGNUP_OPEN: "true" });
  const cloud = mod.createServerlessHandler({ planResolver: () => ({ projects: 1 }) });
  try {
    const json = { "content-type": "application/json" };
    const res = await cloud.fetch(new Request("http://x/auth/register", { method: "POST", headers: json, body: JSON.stringify({ email: "cloud@studio.test", password: "correct horse battery staple", orgName: "Cloud studio" }) }));
    assert.equal(res.status, 201, await res.clone().text());
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const me = (await (await cloud.fetch(new Request("http://x/api/v1/me", { headers: { Cookie: cookie } }))).json()) as { limits: { projects: { limit: number | null }; source: string } };
    assert.equal(me.limits.projects.limit, 1);
    assert.equal(me.limits.source, "resolver");
    // The standard export is a different instance with no resolver: unlimited, the self-host's answer.
    // (One process, one org-keyed limits cache: cleared, or it would answer the cloud's number.)
    invalidateLimits();
    const plain = (await (await mod.default.fetch(new Request("http://x/api/v1/me", { headers: { Cookie: cookie } }))).json()) as { limits: { projects: { limit: number | null } } };
    assert.equal(plain.limits.projects.limit, null);
  } finally {
    await cloud.closeForTests();
    await restore();
  }
});

test("the version is the package's own, not 0.0.0", { skip }, async () => {
  // A scaffolded deploy sets no SNAGSET_VERSION, and Studio showed 0.0.0 on
  // every Vercel instance — found on the first one, a production instance.
  const { mod, restore } = await load({ CRON_SECRET: SECRET, SNAGSET_VERSION: undefined });
  try {
    const meta = (await (await mod.default.fetch(new Request("http://x/api/v1/meta"))).json()) as { version: string };
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(meta.version, pkg.version);
    assert.notEqual(meta.version, "0.0.0");
  } finally {
    await restore();
  }
});
