import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type postgres from "postgres";
import { accountRoutes } from "../src/routes/account.ts";
import type { OwnerClaims } from "../src/routes/owner.ts";

/** Who may do what, decided by the claims — no database. */
function build(role: OwnerClaims["role"]) {
  const sql = Object.assign((..._a: unknown[]) => Promise.resolve([]), { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn((..._a: unknown[]) => Promise.resolve([])) }) as unknown as postgres.Sql;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("requestId" as never, "r1" as never);
    c.set("owner" as never, { userId: "u1", orgId: "o1", email: "me@studio.test", name: "Me", sessionId: "s1", role } as never);
    await next();
  });
  app.route("/", accountRoutes({ sql }));
  return app;
}
const json = { "content-type": "application/json" };

test("an admin cannot rename the studio; an owner can", async () => {
  assert.equal((await build("admin").request("/api/v1/org", { method: "PATCH", headers: json, body: JSON.stringify({ name: "X" }) })).status, 403);
  assert.equal((await build("owner").request("/api/v1/org", { method: "PATCH", headers: json, body: JSON.stringify({ name: "X" }) })).status, 200);
});

test("a studio needs a name, and not a novel", async () => {
  const app = build("owner");
  assert.equal((await app.request("/api/v1/org", { method: "PATCH", headers: json, body: JSON.stringify({ name: "  " }) })).status, 400);
  assert.equal((await app.request("/api/v1/org", { method: "PATCH", headers: json, body: JSON.stringify({ name: "x".repeat(121) }) })).status, 400);
});

test("a short new password is refused before the current one is even checked", async () => {
  const res = await build("admin").request("/api/v1/me/password", { method: "POST", headers: json, body: JSON.stringify({ current: "whatever", next: "short" }) });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, /12 characters/);
});
