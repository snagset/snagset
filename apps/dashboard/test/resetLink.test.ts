import { test } from "node:test";
import assert from "node:assert/strict";
import { resetProblem, linkToken, NEXT_LABEL } from "../src/lib/resetLink.ts";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"; // 43, base64url

test("a reset link's token is read from the fragment, as strictly as an invite's", () => {
  assert.equal(linkToken(`#${TOKEN}`), TOKEN);
  assert.equal(linkToken(`#${TOKEN.slice(0, 40)}`), null, "a paste that lost its tail is caught before a lookup is spent on it");
  assert.equal(linkToken(""), null);
});

test("a used link points at sign-in; an expired or unknown one points at where a new link is asked for", () => {
  assert.deepEqual(resetProblem("link_used"), { title: "This reset link has been used", next: "sign-in" });
  assert.deepEqual(resetProblem("link_expired"), { title: "This reset link has expired", next: "forgot" });
  assert.deepEqual(resetProblem("link_not_found"), { title: "This reset link does not work", next: "forgot" });
  assert.deepEqual(resetProblem(null), { title: "This reset link does not work", next: "forgot" });
  assert.equal(resetProblem("quota_exceeded").title, "Too many attempts");
});

test("every next step has words", () => {
  assert.deepEqual(Object.keys(NEXT_LABEL).sort(), ["forgot", "sign-in"]);
});
