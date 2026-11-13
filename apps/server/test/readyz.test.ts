import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { createApp, unreachableReason } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

/**
 * `/readyz` answers anybody, so what it says when the database is away is
 * said to strangers. It printed the driver's own message, and on a deployment
 * whose database sits on a private network that message is the private host
 * name (seen 2026-11-12, on the hosted service, during a drill).
 *
 * No test database here on purpose: the failure is the subject. A real driver
 * is pointed at a host that cannot resolve and at a port nothing listens on,
 * and the real route is asked.
 */
const SECRET = Buffer.alloc(32, 7).toString("base64url");

async function readyzAgainst(url: string) {
  const sql = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  const app = createApp({ sql, cfg: loadConfig({ DATABASE_URL: url, SNAGSET_BASE_URL: "http://localhost:8080" }), secretKey: SECRET, state: "READY", version: "0.0.0-test", commit: "test", sourceUrl: "", modified: false });
  const said: string[] = [];
  const real = console.error;
  console.error = (...a: unknown[]) => void said.push(a.map(String).join(" "));
  try {
    const res = await app.request("/readyz");
    return { status: res.status, text: await res.text(), said: said.join("\n") };
  } finally {
    console.error = real;
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

test("a database whose host does not resolve: 503, the kind of failure, and not the host", async () => {
  const host = "private-db-7f3k9.invalid";
  const { status, text, said } = await readyzAgainst(`postgres://app:hunter2secret@${host}:5432/snagset`);
  assert.equal(status, 503);
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(body, { ok: false, state: "READY", database: "unreachable", reason: "host_not_found" });
  for (const never of [host, "private-db", "hunter2secret", "5432", "getaddrinfo"]) {
    assert.ok(!text.includes(never), `${never} was said to a stranger`);
  }
  // The operator still gets the whole of it, where the operator reads.
  assert.match(said, /readyz: the database did not answer/);
  assert.ok(said.includes(host), "the log names the host");
  assert.ok(!said.includes("hunter2secret"), "and never the password");
});

test("a port nothing listens on is `refused`, with no address in the answer", async () => {
  const { status, text } = await readyzAgainst("postgres://app:pw@127.0.0.1:1/snagset");
  assert.equal(status, 503);
  assert.deepEqual(JSON.parse(text), { ok: false, state: "READY", database: "unreachable", reason: "refused" });
  assert.ok(!text.includes("127.0.0.1"));
});

test("the six words, and anything unknown is only `error`", () => {
  const coded = (code: string) => Object.assign(new Error("connect to db-host.internal failed"), { code });
  assert.equal(unreachableReason(coded("EAI_AGAIN")), "host_not_found");
  assert.equal(unreachableReason(coded("ENOTFOUND")), "host_not_found");
  assert.equal(unreachableReason(coded("ECONNREFUSED")), "refused");
  assert.equal(unreachableReason(coded("CONNECT_TIMEOUT")), "timeout");
  assert.equal(unreachableReason(coded("28P01")), "auth_failed");
  assert.equal(unreachableReason(coded("3D000")), "no_such_database");
  assert.equal(unreachableReason(coded("XX000")), "error");
  assert.equal(unreachableReason(new Error("db-host.internal")), "error");
  assert.equal(unreachableReason("db-host.internal"), "error");
});
