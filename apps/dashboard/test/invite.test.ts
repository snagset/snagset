import { test } from "node:test";
import assert from "node:assert/strict";
import { asRole, inviteProblem, inviteToken } from "../src/lib/invite.ts";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"; // 43, base64url

test("the token is read from the fragment, strictly", () => {
  assert.equal(TOKEN.length, 43);
  assert.equal(inviteToken(`#${TOKEN}`), TOKEN);
  assert.equal(inviteToken(TOKEN), TOKEN, "with or without the hash sign");
  assert.equal(inviteToken(`#token=${TOKEN}`), TOKEN, "a token= spelling is tolerated");
  // A paste that lost its tail is caught here, not by a rate-limited lookup.
  assert.equal(inviteToken(`#${TOKEN.slice(0, 40)}`), null);
  assert.equal(inviteToken(`#${TOKEN}=`), null, "padding is not the server's shape");
  assert.equal(inviteToken("#a b"), null);
  assert.equal(inviteToken(""), null);
});

test("each way a link stops working has its own heading", () => {
  const titles = ["invite_used", "invite_expired", "invite_revoked", "invite_not_found"].map((c) => inviteProblem(c).title);
  assert.equal(new Set(titles).size, 4, "expired, used, withdrawn and unknown read differently");
  assert.equal(inviteProblem("invite_used").signIn, true, "a used link points at sign-in — it may have been you");
  assert.equal(inviteProblem("invite_expired").signIn, false);
  assert.equal(inviteProblem(null).title, "This invite link does not work");
});

test("the article follows the role", () => {
  assert.equal(asRole("owner"), "an owner");
  assert.equal(asRole("admin"), "an admin");
});
