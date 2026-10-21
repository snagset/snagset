import { test } from "node:test";
import assert from "node:assert/strict";
import { can, invitable, withArticle, type StudioAct } from "../src/roles.ts";

/** The table, pinned: the server's routes and the dashboard both read it, so a change here is a change to both. */
const ACTS: StudioAct[] = ["review", "moderate", "settings", "invite", "tokens", "people", "studio"];
const holds = (role: string) => ACTS.filter((a) => can(role, a));

test("the four seats", () => {
  assert.deepEqual(holds("owner"), ACTS);
  assert.deepEqual(holds("admin"), ["review", "moderate", "settings", "invite", "tokens"]);
  assert.deepEqual(holds("member"), ["review"]);
  assert.deepEqual(holds("viewer"), []);
});

test("an unknown or missing role may do nothing", () => {
  for (const role of ["", "superuser", undefined, null]) assert.deepEqual(holds(role as string), []);
});

test("who may be invited as what", () => {
  assert.deepEqual(invitable("owner"), ["owner", "admin", "member"]);
  assert.deepEqual(invitable("admin"), ["member"]);
  assert.deepEqual(invitable("member"), []);
  assert.deepEqual(invitable("viewer"), []);
});

test("the article", () => {
  assert.deepEqual(["owner", "admin", "member"].map(withArticle), ["an owner", "an admin", "a member"]);
});
