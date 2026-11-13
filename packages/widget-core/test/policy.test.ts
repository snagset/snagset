import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedReason, type Env } from "../src/loader/policy.ts";
import { GLOBALS, scriptAttr, param, COOKIE } from "@snagset/types/names";

// The activation policy is a pure function of a captured environment, so every
// kill switch is provable here rather than by arranging a browser. That matters:
// navigator.webdriver is FALSE in the dev preview browser, so the automation
// refusal cannot be demonstrated there at all — it would have shipped untested.

const env = (over: Partial<Env> = {}): Env => ({
  config: {},
  search: "",
  cookie: "",
  webdriver: false,
  globals: {},
  ...over,
});

test("a plain reviewer visit proceeds", () => {
  assert.equal(blockedReason(env()), null);
});

test("data-snag-disabled is presence-means-off", () => {
  assert.equal(blockedReason(env({ config: { disabled: "" } }))?.token, scriptAttr("disabled"));
  // …even when the author writes ="false", which is the footgun the polarity avoids
  assert.equal(blockedReason(env({ config: { disabled: "false" } }))?.token, scriptAttr("disabled"));
});

test("snag_off works as a query flag and as a cookie", () => {
  assert.equal(blockedReason(env({ search: "?snag_off=1" }))?.token, param("off"));
  assert.equal(blockedReason(env({ cookie: `${COOKIE.off}=1` }))?.token, COOKIE.off);
  // and must not be confused by an unrelated key that merely contains it
  assert.equal(blockedReason(env({ cookie: "not_snag_off=1" })), null);
});

test("the E2E kill switch blocks", () => {
  assert.equal(blockedReason(env({ globals: { [GLOBALS.disabled]: true } }))?.token, GLOBALS.disabled);
});

test("automation is refused unless explicitly allowed", () => {
  assert.equal(blockedReason(env({ webdriver: true }))?.gate, "automation");
  assert.equal(blockedReason(env({ webdriver: true, config: { allowAutomation: "" } })), null);
});

test("mode: off always blocks; auto declines on production only", () => {
  assert.equal(blockedReason(env({ config: { mode: "off" } }))?.gate, "mode-off");
  assert.equal(blockedReason(env({ config: { env: "production" } }))?.gate, "no-review-token");
  assert.equal(blockedReason(env({ config: { mode: "on", env: "production" } })), null);
  assert.equal(blockedReason(env({ config: { env: "staging" } })), null);
});

test("every gate is named as the design names it, and explains its own fix", () => {
  // The <gate> token. The registered switch NAME goes in `token` and the
  // spec's gate token in `gate`, because one gate can have two triggers —
  // `off-switch` is both `?snag_off=1` and the cookie — and the console line is
  // supposed to name the GATE while the fix names the thing to actually change.
  const gates = [
    blockedReason(env({ globals: { [GLOBALS.disabled]: true } })),
    blockedReason(env({ config: { disabled: "" } })),
    blockedReason(env({ search: "?snag_off=1" })),
    blockedReason(env({ webdriver: true })),
    blockedReason(env({ config: { mode: "off" } })),
    blockedReason(env({ config: { env: "production" } })),
  ];
  assert.deepEqual(
    gates.map((g) => g?.gate),
    ["disabled-global", "disabled-attr", "off-switch", "automation", "mode-off", "no-review-token"],
  );
  for (const g of gates) {
    assert.ok(g?.fix && g.fix.length > 0, `${g?.gate} must say what to change`);
    assert.doesNotMatch(g!.fix, /\n/, "one line, never a paragraph");
  }
});

test("the two gates that must stay SILENT are the two the spec names", () => {
  // `automation`, because a client's own suite asserting an empty
  // console must not be broken by us; and `no-review-token`, because it is the
  // steady state of every production install and would log on every page view.
  assert.equal(blockedReason(env({ webdriver: true }))?.silent, true);
  assert.equal(blockedReason(env({ config: { env: "production" } }))?.silent, true);
  assert.notEqual(blockedReason(env({ search: "?snag_off=1" }))?.silent, true);
  assert.notEqual(blockedReason(env({ config: { disabled: "" } }))?.silent, true);
});

test("both off-switch triggers report one gate, and the FIX says which fired", () => {
  const q = blockedReason(env({ search: "?snag_off=1" }));
  const c = blockedReason(env({ cookie: `${COOKIE.off}=1` }));
  assert.equal(q?.gate, c?.gate, "The design gives the pair a single gate name");

  // The registered token is deliberately the same string for both — `param("off")`
  // and `COOKIE.off` both derive to `snag_off`, which is the whole point of one
  // registry. So the token cannot be what distinguishes them: the FIX is, and it
  // is the half a reader actually needs, because clearing a cookie and editing a
  // URL are different actions.
  assert.equal(q?.token, c?.token);
  assert.match(q!.fix, /URL/);
  assert.match(c!.fix, /cookie/);
});

test("first match wins — a page tripping two gates explains itself once", () => {
  const both = blockedReason(env({ config: { disabled: "" }, search: "?snag_off=1" }));
  assert.equal(both?.gate, "disabled-attr", "The ladder order decides");
});

/* ──, and the third half of row 8 ─────────────────────────
 *
 * The gate had six rungs where v0 asks for nine, and the three that were
 * missing are the three a host reaches for when they cannot template the tag:
 * `window.SnagsetConfig`. It was a registered name with zero
 * consumers — which is the strongest tell there is that something was written
 * down and never built.
 */

test("row 4 — SnagsetConfig.disabled === true blocks, and nothing weaker does", () => {
  assert.equal(blockedReason(env({ configGlobal: { disabled: true } }))?.gate, "disabled-config");
  // `=== true`, not truthy. A host with `disabled: 0` or `disabled: ""` means
  // "not disabled", and reading those as off silently uninstalls the widget for
  // somebody who was trying to keep it.
  assert.equal(blockedReason(env({ configGlobal: { disabled: false } })), null);
  assert.equal(blockedReason(env({ configGlobal: { disabled: 0 } })), null);
  assert.equal(blockedReason(env({ configGlobal: { disabled: "" } })), null);
});

test("row 9 — config.enabled === false blocks, and a predicate is asked", () => {
  assert.equal(blockedReason(env({ configGlobal: { enabled: false } }))?.gate, "config-disabled");
  assert.equal(blockedReason(env({ configGlobal: { enabled: () => false } }))?.gate, "config-disabled");
  assert.equal(blockedReason(env({ configGlobal: { enabled: true } })), null);
  assert.equal(blockedReason(env({ configGlobal: { enabled: () => true } })), null);
});

test("row 9 — a predicate that THROWS is no opinion, not a refusal", () => {
  // It is host code on our stack and the design forbids us to throw into the page.
  // Treating a throw as `false` would mean a widget that disappears because
  // somebody's feature-flag service was down, which is the more surprising of
  // the two failures.
  const boom = () => {
    throw new Error("flag service down");
  };
  assert.equal(blockedReason(env({ configGlobal: { enabled: boom } })), null);
});

test("row 10 — allowedOrigins scopes one shared template to one environment", () => {
  const origin = "https://staging.acme.com";
  const allowed = { allowedOrigins: [origin] };
  assert.equal(blockedReason(env({ configGlobal: allowed, origin })), null);
  assert.equal(
    blockedReason(env({ configGlobal: allowed, origin: "https://www.acme.com" }))?.gate,
    "origin-not-allowed",
  );
  // An EMPTY array means nowhere, and is honoured as written.
  assert.equal(
    blockedReason(env({ configGlobal: { allowedOrigins: [] }, origin }))?.gate,
    "origin-not-allowed",
  );
  // A non-array is ignored rather than obeyed: a host who typed a string meant
  // to ALLOW that origin, and refusing to run is the opposite of the ask.
  assert.equal(blockedReason(env({ configGlobal: { allowedOrigins: origin }, origin })), null);
});

test("row 8 — Cypress is detected, and it sets no webdriver flag", () => {
  // Prints three checks and we had one. Cypress runs the app inside an
  // iframe in its own runner and exposes `window.Cypress`; `navigator.webdriver`
  // stays false. So a client running their own Cypress suite against the staging
  // deployment that carries data-snag-mode="on" — the documented staging
  // configuration — had a live review widget intercepting their clicks.
  const g = blockedReason(env({ globals: { Cypress: {} } }));
  assert.equal(g?.gate, "automation");
  assert.equal(g?.token, "window.Cypress");
  assert.equal(g?.silent, true);
  // Seen from a window the runner opened.
  assert.equal(blockedReason(env({ globals: { opener: { Cypress: {} } } }))?.gate, "automation");
  // And the opt-out still works, because it is how we test ourselves.
  assert.equal(
    blockedReason(env({ globals: { Cypress: {} }, config: { allowAutomation: "" } })),
    null,
  );
});

test("a cross-origin opener that throws on access does not take the gate down", () => {
  // A real cross-origin `window.opener` is a Window proxy that throws
  // SecurityError on the `in` check itself — not on a getter, which `in` never
  // invokes. A Proxy with a throwing `has` trap is the only faithful stand-in,
  // and the first version of this test used a throwing getter and therefore
  // proved nothing at all.
  const hostile = new Proxy(
    {},
    {
      has() {
        throw new Error("SecurityError: cross-origin");
      },
    },
  );
  assert.doesNotThrow(() => blockedReason(env({ globals: { opener: hostile } })));
  assert.equal(blockedReason(env({ globals: { opener: hostile } })), null);
});

test("a visitor IN REVIEW passes the production gate — its name finally true", () => {
  /**
   * The gate has been called `no-review-token` since it was written, and it
   * never checked for one: a client opening their review link on a production
   * install got an inert page. `inReview` is set by the loader when the URL
   * carried a token OR a holder identity for this project is stored — someone
   * who has reviewed here before, which on a link-required site means someone
   * who once held a link.
   */
  assert.equal(blockedReason(env({ config: { env: "production" }, inReview: true })), null);
  // …and it lifts ONLY this gate. The owner's off switches still win, in the
  // order the kill-switch page documents: ?snag_off with a review link is an
  // inert page, because the off switch is the stronger statement.
  assert.equal(
    blockedReason(env({ config: { env: "production", disabled: "" }, inReview: true }))?.gate,
    "disabled-attr",
  );
  assert.equal(
    blockedReason(env({ config: { env: "production", mode: "off" }, inReview: true }))?.gate,
    "mode-off",
  );
});
