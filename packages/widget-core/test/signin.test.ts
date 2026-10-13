import { test } from "node:test";
import assert from "node:assert/strict";
import { isSessionMessage, signInUrl, SIGNIN_MESSAGE } from "../src/panels/signin.ts";

/**
 * Which `message` events the widget believes.
 *
 * The listener is on the CLIENT'S page, where anything can post: an ad frame,
 * an extension, the host app's own messaging, a second dashboard window. A
 * session accepted from any of them makes the sender the author of the next
 * comment, so the filter is tested on its own, against every near miss.
 */

const SERVER = "https://snagset.studio.test";
const popup = { name: "the popup we opened" };
const session = {
  sessionToken: "a.b.c",
  expiresAt: "2026-10-12T12:15:00.000Z",
  refreshableUntil: "2026-10-13T00:00:00.000Z",
  reviewer: { id: "rev_1", name: "Olga" },
  permissions: ["thread:create"],
};
const good = { origin: SERVER, source: popup, data: { type: SIGNIN_MESSAGE, session } };

test("the dashboard's message, from the popup we opened, is accepted", () => {
  assert.equal(isSessionMessage(good, SERVER, popup), true);
});

test("the same message from any other origin is refused", () => {
  for (const origin of ["https://client.test", "https://snagset.studio.test.evil.test", "http://snagset.studio.test", "null", ""]) {
    assert.equal(isSessionMessage({ ...good, origin }, SERVER, popup), false, origin);
  }
});

test("the right origin from a window we did not open is refused", () => {
  assert.equal(isSessionMessage({ ...good, source: { name: "an iframe of the dashboard" } }, SERVER, popup), false);
  assert.equal(isSessionMessage({ ...good, source: null }, SERVER, popup), false);
  // No popup (blocked, or already resolved): nothing can match it.
  assert.equal(isSessionMessage({ ...good, source: null }, SERVER, null), false);
});

test("a message that is not a session is refused", () => {
  for (const data of [
    null,
    "snagset:session",
    { type: "snagset:other", session },
    { type: SIGNIN_MESSAGE },
    { type: SIGNIN_MESSAGE, session: { ...session, sessionToken: 42 } },
    { type: SIGNIN_MESSAGE, session: { ...session, reviewer: {} } },
  ]) {
    assert.equal(isSessionMessage({ ...good, data }, SERVER, popup), false, JSON.stringify(data));
  }
});

test("the popup URL is the dashboard's page on the server's origin, carrying the page's origin", () => {
  const u = new URL(signInUrl(`${SERVER}/some/base/`, "prj_abc", "https://client.test", "preview"));
  assert.equal(u.origin, SERVER);
  assert.equal(u.pathname, "/widget-signin");
  assert.equal(u.searchParams.get("project"), "prj_abc");
  assert.equal(u.searchParams.get("origin"), "https://client.test");
  assert.equal(u.searchParams.get("env"), "preview");
  assert.equal(new URL(signInUrl(SERVER, "prj_abc", "https://client.test")).searchParams.has("env"), false);
});
