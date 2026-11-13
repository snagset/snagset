import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyring } from "../src/keys.ts";
import { mintSession, verifySession, withinRefreshWindow, type MintInput, type Ttls } from "../src/session.ts";

/**
 * The bearer session.
 *
 * The centrepiece is the refresh loop below. The `refreshableUntil` is
 * `min(…, iat + ABSOLUTE_TTL)`, and read with a fresh `iat` on every refresh
 * that expression re-bases every fifteen minutes — the 12-hour cap never
 * arrives and one exchange authenticates a reviewer forever. Nothing errors,
 * nothing logs, and no test that checks a single mint would notice. So the
 * test drives thirteen simulated hours.
 */

const KEYS = createKeyring("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ");
const TTLS: Ttls = { slidingS: 900, absoluteS: 43_200 }; // The defaults
const UID = "prj_htqkaeb76pp3";

const base = (over: Partial<MintInput> = {}): MintInput => ({
  projectUid: UID,
  reviewerId: "6f1b0a3e-0000-7000-8000-000000000001",
  environmentKey: "preview",
  kind: "link",
  reviewLinkId: "11111111-0000-7000-8000-000000000001",
  permissions: ["thread:create", "comment:create", "thread:resolve"],
  sessionEpoch: 7,
  ...over,
});

/** A clock the test owns. */
const at = (s: number) => () => new Date(s * 1000);
const T0 = 1_800_000_000;

test("the claim set is EXACTLY the, and nothing extra rides along", async () => {
  const s = await mintSession(KEYS, base(), TTLS, at(T0));
  assert.deepEqual(Object.keys(s.claims).sort(), [
    "aud", "env", "epo", "exp", "iat", "iss", "jti", "kind", "lnk", "nbf", "perm", "sid", "sub",
  ]);
  assert.equal(s.claims.aud, UID, "audience is the project — a token is not portable between projects");
  assert.equal(s.claims.epo, 7);
  assert.equal(s.claims.exp - T0, 900, "15 minutes");
});

test("`iex` appears only for a verified session", async () => {
  const withIex = await mintSession(KEYS, base({ kind: "verified", iex: T0 + 300 }), TTLS, at(T0));
  assert.equal(withIex.claims.iex, T0 + 300);
  assert.equal("iex" in (await mintSession(KEYS, base(), TTLS, at(T0))).claims, false);
});

test("THE TRAP: 47 refreshes across 13 hours, and `iat` never moves", async () => {
  // The design says refresh is silent inside the window and user-visible only at the
  // 12-hour cap. That is only true if `iat` means "the session began".
  let s = await mintSession(KEYS, base(), TTLS, at(T0));
  const originalIat = s.claims.iat;
  const originalSid = s.claims.sid;
  const jtis = new Set([s.claims.jti]);

  let t = T0;
  let refreshes = 0;
  for (let i = 0; i < 200; i++) {
    t += 900;
    if (!withinRefreshWindow(s.claims, TTLS, undefined, at(t))) break;
    s = await mintSession(
      KEYS,
      base({ sid: s.claims.sid, iat: s.claims.iat }),
      TTLS,
      at(t),
    );
    jtis.add(s.claims.jti);
    refreshes++;
  }

  assert.equal(s.claims.iat, originalIat, "iat is the SESSION's start, carried forward");
  assert.equal(s.claims.sid, originalSid, "one session, one sid");
  assert.equal(jtis.size, refreshes + 1, "every token has its own jti");

  // 43200 / 900 = exactly 48 sliding windows. The loop is allowed 200, so
  // stopping at 47 is the cap arriving rather than the loop running out —
  // which is the whole assertion, and the first version of this test got it
  // wrong by looping exactly 47 times and proving nothing.
  assert.ok(refreshes < 200, "the loop was not what stopped it");
  assert.equal(refreshes, 47, "the 12-hour cap arrives after 48 windows and does not slide");
  assert.equal(
    withinRefreshWindow(s.claims, TTLS, undefined, at(T0 + 43_200 + 1)),
    false,
    "past 12 hours from the ORIGINAL iat, refusal",
  );
});

test("a link's own expiry is a ceiling below the 12-hour cap", async () => {
  // The table: min(review_link.expires_at, iat + ABSOLUTE_TTL). A link with
  // two minutes left does not hand out a twelve-hour session.
  const s = await mintSession(KEYS, base({ linkExpiresAt: T0 + 120 }), TTLS, at(T0));
  assert.equal(s.refreshableUntil.getTime() / 1000, T0 + 120);
  // …and the token itself is clamped, or the last token issued outlives the
  // window it was issued within.
  assert.equal(s.claims.exp, T0 + 120);
});

test("`iex` is a hard ceiling for a verified session — not discarded at exchange", async () => {
  // Draft 1 checked the envelope's expiry once and threw it away, so a
  // 5-minute envelope still bought an 8-hour credential that refreshed forever.
  const s = await mintSession(KEYS, base({ kind: "verified", iex: T0 + 300 }), TTLS, at(T0));
  assert.equal(s.refreshableUntil.getTime() / 1000, T0 + 300);
  assert.equal(withinRefreshWindow(s.claims, TTLS, undefined, at(T0 + 301)), false);
});

test("a valid token verifies; a tampered one does not", async () => {
  const s = await mintSession(KEYS, base(), TTLS, at(T0));
  const ok = await verifySession(KEYS, s.token, { projectUid: UID, expectedEpoch: 7, now: at(T0 + 60) });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.claims.sub, base().reviewerId);

  const [h, p, sig] = s.token.split(".");
  const forged = `${h}.${p}.${sig!.slice(0, -3)}AAA`;
  const bad = await verifySession(KEYS, forged, { projectUid: UID, expectedEpoch: 7, now: at(T0 + 60) });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.reason, "bad_signature");
});

test("REVOCATION: a bumped epoch invalidates a live, unexpired token", async () => {
  // The zero-query half. The token is perfectly valid; the project
  // signed everyone out.
  const s = await mintSession(KEYS, base({ sessionEpoch: 7 }), TTLS, at(T0));
  const r = await verifySession(KEYS, s.token, { projectUid: UID, expectedEpoch: 8, now: at(T0 + 60) });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "session_revoked", "not 'expired' — different event, different copy");
});

test("a token for another project is refused, however valid its signature", async () => {
  const s = await mintSession(KEYS, base(), TTLS, at(T0));
  const r = await verifySession(KEYS, s.token, {
    projectUid: "prj_aaaaaaaaaaaa",
    expectedEpoch: 7,
    now: at(T0 + 60),
  });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "wrong_project");
});

test("an expired token is refused normally, and readable on the refresh path", async () => {
  const s = await mintSession(KEYS, base(), TTLS, at(T0));
  const late = at(T0 + 1000); // past exp, inside the refresh window

  const strict = await verifySession(KEYS, s.token, { projectUid: UID, expectedEpoch: 7, now: late });
  assert.equal(!strict.ok && strict.reason, "expired");

  // The design allows refreshing "an expiring or recently expired token". Refusing
  // one that lapsed while a laptop was shut is the four-re-auths-an-afternoon
  // behaviour the design calls a bug.
  const refresh = await verifySession(KEYS, s.token, {
    projectUid: UID,
    expectedEpoch: 7,
    allowExpired: true,
    now: late,
  });
  assert.equal(refresh.ok, true);
  assert.equal(refresh.ok && refresh.claims.iat, T0, "and the original iat comes back for the cap check");
});

test("a token signed under an UNKNOWN key is refused, not retried against every key", async () => {
  const other = createKeyring("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ");
  const s = await mintSession(other, base(), TTLS, at(T0));
  const r = await verifySession(KEYS, s.token, { projectUid: UID, expectedEpoch: 7, now: at(T0 + 60) });
  assert.equal(!r.ok && r.reason, "unknown_key");
});

test("during rotation, a token signed under the PREVIOUS key still verifies", async () => {
  const oldRing = createKeyring("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ");
  const rotating = createKeyring(
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ",
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ",
  );
  const s = await mintSession(oldRing, base(), TTLS, at(T0));
  const r = await verifySession(rotating, s.token, { projectUid: UID, expectedEpoch: 7, now: at(T0 + 60) });
  assert.equal(r.ok, true, "the 24-hour overlap is what makes a deploy-then-remove rotation safe");
});

test("garbage in the Authorization header is `malformed`, never a crash", async () => {
  for (const junk of ["", "not-a-jwt", "a.b", "....", "Bearer x"]) {
    const r = await verifySession(KEYS, junk, { projectUid: UID, expectedEpoch: 7 });
    assert.equal(r.ok, false, junk);
  }
});
