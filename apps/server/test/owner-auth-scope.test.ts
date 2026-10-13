import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type postgres from "postgres";
import { ownerAuth } from "../src/routes/owner.ts";
import { DASHBOARD_SESSION_COOKIE } from "@snagset/types/names";
import { UNLIMITED } from "../src/plan.ts";

/**
 * The session lookup runs where the session can be USED, and nowhere else.
 *
 * `ownerAuth` was mounted on "*", so a browser holding a `snag_session`
 * cookie — stale or live — paid a `user_sessions` query on every request
 * including the HTML and every static asset. Measured in a clean Chromium:
 * sign-in at 97 ms without the cookie, 1.9 s with a stale one, each of the
 * four requests on the way costing ~550 ms against Neon. This test mounts the
 * middleware the way app.ts does and counts queries with a stub, so it runs
 * with no database and fails the moment the mount widens again.
 */
function build() {
  let queries = 0;
  const sql = ((...a: unknown[]) => {
    // The lookup runs under the maintenance claim (db/scope.ts), which is a
    // statement of its own on the same transaction; the count here is of
    // LOOKUPS, which is what the mount's width changes.
    const text = String((a[0] as readonly string[] | undefined)?.[0] ?? "");
    if (!/SET LOCAL|set_config\(/.test(text)) queries += 1;
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  const app = new Hono();
  const mw = ownerAuth({ sql, limits: async () => ({ ...UNLIMITED, source: "default" }), origin: "http://localhost", secure: false });
  app.use("/api/*", mw);
  app.use("/auth/*", mw);
  app.get("/assets/app.js", (c) => c.text("js"));
  app.get("/", (c) => c.text("html"));
  app.get("/api/v1/me", (c) => c.json({ owner: c.get("owner" as never) ?? null }));
  return { app, count: () => queries };
}

const STALE = { cookie: `${DASHBOARD_SESSION_COOKIE}=${"0".repeat(64)}` };

test("a static path never touches the database, cookie or no cookie", async () => {
  const { app, count } = build();
  await app.request("/assets/app.js", { headers: STALE });
  await app.request("/", { headers: STALE });
  assert.equal(count(), 0, "no user_sessions lookup for a file");
});

test("an API path looks the session up ONCE, and clears a cookie that names no session", async () => {
  const { app, count } = build();
  const res = await app.request("/api/v1/me", { headers: STALE });
  assert.equal(count(), 1, "one lookup for one API request");
  const cleared = res.headers.get("set-cookie") ?? "";
  assert.match(cleared, new RegExp(`${DASHBOARD_SESSION_COOKIE}=;.*Max-Age=0`), "the stale cookie is dropped");
});

test("no cookie, no query — the fast path is still fast", async () => {
  const { app, count } = build();
  await app.request("/api/v1/me");
  assert.equal(count(), 0);
});
