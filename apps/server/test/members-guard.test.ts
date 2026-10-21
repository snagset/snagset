import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type postgres from "postgres";
import { memberRoutes } from "../src/routes/members.ts";
import { inviteRoutes } from "../src/routes/invites.ts";
import type { OwnerClaims } from "../src/routes/owner.ts";
import { UNLIMITED } from "../src/plan.ts";

/**
 * Who may change the list is decided by `role` on the claims, and this pins
 * it with no database: a stub sql that answers empty, an app that stamps a
 * claims object the way ownerAuth would, and the members router beneath it.
 */
function build(role: OwnerClaims["role"]) {
  const sql = Object.assign(
    (..._a: unknown[]) => Promise.resolve([]),
    { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn((..._a: unknown[]) => Promise.resolve([])) },
  ) as unknown as postgres.Sql;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("requestId" as never, "r1" as never);
    c.set("owner" as never, { userId: "u1", orgId: "o1", email: "me@studio.test", name: "Me", sessionId: "s1", role } as never);
    await next();
  });
  app.route(
    "/",
    inviteRoutes({
      sql,
      limits: async () => ({ ...UNLIMITED, source: "default" }),
      address: async () => "http://localhost:8080",
      mailer: async () => ({ kind: "none", reason: "" }),
      origin: "http://localhost:8080",
      secure: false,
    }),
  );
  app.route("/", memberRoutes({ sql }));
  return app;
}
const json = { "content-type": "application/json" };

test("an admin can read the list, invite members, and change nobody", async () => {
  const app = build("admin");
  assert.equal((await app.request("/api/v1/members")).status, 200);
  assert.equal((await app.request("/api/v1/members/invites")).status, 200, "admins see the pending invites too");
  const invite = await app.request("/api/v1/members/invites", { method: "POST", headers: json, body: JSON.stringify({ role: "admin" }) });
  assert.equal(invite.status, 403, "only an owner invites an admin");
  const owner = await app.request("/api/v1/members/invites", { method: "POST", headers: json, body: JSON.stringify({ role: "owner" }) });
  assert.equal(owner.status, 403, "or an owner");
  // A member invite gets past the role check (the stub database then mints it).
  const member = await app.request("/api/v1/members/invites", { method: "POST", headers: json, body: JSON.stringify({ role: "member" }) });
  assert.equal(member.status, 201, "an admin invites members");
  assert.equal((await app.request("/api/v1/members/x%40y.co", { method: "PATCH", headers: json, body: JSON.stringify({ role: "owner" }) })).status, 403);
  assert.equal((await app.request("/api/v1/members/x%40y.co", { method: "PATCH", headers: json, body: JSON.stringify({ role: "member" }) })).status, 403, "role changes stay an owner's");
  assert.equal((await app.request("/api/v1/members/x%40y.co", { method: "DELETE" })).status, 403);
});

test("a member reads the list and nothing else", async () => {
  const app = build("member");
  assert.equal((await app.request("/api/v1/members")).status, 200);
  assert.equal((await app.request("/api/v1/members/invites")).status, 403);
  assert.equal((await app.request("/api/v1/members/invites", { method: "POST", headers: json, body: JSON.stringify({ role: "member" }) })).status, 403);
  assert.equal((await app.request("/api/v1/members/invites/00000000-0000-4000-8000-000000000000", { method: "DELETE" })).status, 403);
  assert.equal((await app.request("/api/v1/members/x%40y.co", { method: "PATCH", headers: json, body: JSON.stringify({ role: "member" }) })).status, 403);
  assert.equal((await app.request("/api/v1/members/x%40y.co", { method: "DELETE" })).status, 403);
});

test("viewer is refused with a sentence, not accepted and ignored", async () => {
  const app = build("owner");
  const res = await app.request("/api/v1/members/invites", { method: "POST", headers: json, body: JSON.stringify({ role: "viewer" }) });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, /not available yet/);
});

test("an owner cannot remove themself", async () => {
  const app = build("owner");
  const res = await app.request("/api/v1/members/me%40studio.test", { method: "DELETE" });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "self");
});

test("The initial-password door is gone, and says where the new one is", async () => {
  const app = build("owner");
  const res = await app.request("/api/v1/members", { method: "POST", headers: json, body: JSON.stringify({ email: "a@b.co", role: "admin", password: "twelve characters long" }) });
  assert.equal(res.status, 404);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, /\/api\/v1\/members\/invites/);
});
