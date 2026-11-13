import { test } from "node:test";
import assert from "node:assert/strict";
import { explain } from "../src/explain.ts";

/**
 * The bare-✗ regression.
 *
 * `postgres` throws an AggregateError whose `.message` is the EMPTY STRING and
 * whose only own property is `.code`. The CLI printed `✗ ${e.message}`, so a
 * server that could not reach its database printed one character and exited.
 *
 * That is the FIRST thing a self-hoster meets — and more so since the decision removed
 * the compose file that used to supply the database, which makes "bring your
 * own Postgres" step one and forgetting to start it the ordinary mistake.
 */

const connErr = (code: string): Error => Object.assign(new AggregateError([], ""), { code });

test("a refused connection names the address and what to do", () => {
  process.env["DATABASE_URL"] = "postgres://snagset:hunter2@localhost:5432/snagset";
  const out = explain(connErr("ECONNREFUSED"));
  assert.match(out, /no Postgres answered at localhost:5432/);
  assert.match(out, /Supabase or Neon/, "and says where to get one");
  assert.ok(!out.includes("hunter2"), "the password never reaches the terminal");
});

test("a bad hostname says so, and a timeout says why", () => {
  process.env["DATABASE_URL"] = "postgres://u:p@db.example:6543/x";
  assert.match(explain(connErr("ENOTFOUND")), /does not resolve at db\.example:6543/);
  assert.match(explain(connErr("ETIMEDOUT")), /did not answer in time/);
});

test("an error that HAS a message is passed through untouched", () => {
  assert.equal(explain(new Error("migrate: relation already exists")), "✗ migrate: relation already exists");
});

test("an empty error with no code still says something", () => {
  // The case that produced a lone ✗. It must never print nothing again, even
  // when there is nothing to go on.
  const out = explain(new AggregateError([], ""));
  assert.ok(out.length > 3, `expected a sentence, got ${JSON.stringify(out)}`);
  assert.match(out, /said nothing about why/);
});
