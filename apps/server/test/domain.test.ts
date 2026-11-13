import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseDomain, originMatchesDomain, isSharedSuffix, sameSite } from "../src/domain.ts";

/** The domain rule, as pure functions; the routes and CORS are tested in sites.test.ts. */

test("what the studio types becomes a domain: a host, a full address, upper case, www, a trailing dot", () => {
  for (const [input, want] of [
    ["acme.com", "acme.com"],
    ["  Staging.Acme.com ", "staging.acme.com"],
    ["https://www.acme.com/pricing?x=1", "acme.com"],
    ["http://preview.acme.com:3000", "preview.acme.com"],
    ["acme.com.", "acme.com"],
    ["www.acme.co.uk", "acme.co.uk"],
    ["acme.com/some/path", "acme.com"],
  ] as const) {
    assert.deepEqual(normaliseDomain(input), { domain: want }, input);
  }
});

test("what is refused says why: nothing, garbage, an IP, localhost, a bare TLD, a shared host", () => {
  for (const [input, why] of [
    ["", /Type the site's domain/],
    ["not a domain", /not a domain/],
    ["http://[::1]:3000", /localhost and IP addresses/],
    ["127.0.0.1", /localhost and IP addresses/],
    ["localhost:5173", /localhost and IP addresses/],
    ["com", /not a domain|shared/],
    ["vercel.app", /shared by everyone/],
    ["https://netlify.app", /shared by everyone/],
  ] as const) {
    const r = normaliseDomain(input);
    assert.ok("error" in r, `${JSON.stringify(input)} should be refused`);
    assert.match(r.error, why, input);
  }
  // A subdomain OF a shared host is somebody's own site, and fine.
  assert.deepEqual(normaliseDomain("kilnwork.vercel.app"), { domain: "kilnwork.vercel.app" });
  assert.equal(isSharedSuffix("kilnwork.vercel.app"), false);
});

test("an origin matches on the host with a dot boundary, whatever the scheme or port", () => {
  const d = "acme.com";
  for (const ok of [
    "https://acme.com",
    "http://acme.com",
    "https://www.acme.com",
    "https://staging.acme.com",
    "http://preview-42.staging.acme.com:3000",
    "HTTPS://ACME.COM",
  ]) {
    assert.equal(originMatchesDomain(d, ok), true, ok);
  }
  for (const no of ["https://notacme.com", "https://acme.com.evil.io", "https://acme.co", "https://evil.io/?acme.com", "garbage", ""]) {
    assert.equal(originMatchesDomain(d, no), false, no);
  }
  assert.equal(originMatchesDomain("", "https://acme.com"), false);
});

test("SameSite: two subdomains of one registrable domain are one site", () => {
  for (const [a, b] of [
    ["acme.example.dev", "snagset.example.dev"],
    ["example.dev", "snagset.example.dev"],
    ["a.b.studio.test", "snagset.studio.test"],
    ["Acme.Studio.Dev.", "snagset.studio.dev"],
    ["localhost", "localhost"],
    ["app.localhost", "localhost"],
    ["127.0.0.1", "localhost"],
    ["10.0.0.5", "10.0.0.5"],
  ] as const) {
    assert.equal(sameSite(a, b), true, `${a} ~ ${b}`);
  }
});

test("SameSite: everything else is cross-site — shared hosts, registries, localhost against a real host", () => {
  for (const [a, b] of [
    ["acme.com", "snagset.example.test"],
    ["notstudio.dev", "studio.dev"],
    // A shared hosting suffix is not one site: two customers' apps.
    ["client.vercel.app", "snagset.vercel.app"],
    ["a.netlify.app", "b.netlify.app"],
    ["a.github.io", "b.github.io"],
    ["a.pages.dev", "b.pages.dev"],
    ["a.herokuapp.com", "b.herokuapp.com"],
    ["a.onrender.com", "b.onrender.com"],
    ["a.fly.dev", "b.fly.dev"],
    // A registry, not a site: refused rather than guessed at.
    ["acme.co.uk", "snagset.acme.co.uk"],
    ["acme.com.au", "evil.com.au"],
    ["acme.co.jp", "snagset.acme.co.jp"],
    // The developer's machine is its own site and nobody else's.
    ["localhost", "snagset.example.test"],
    ["snagset.example.test", "127.0.0.1"],
    ["10.0.0.5", "10.0.0.6"],
    ["com", "com"],
    ["", "studio.dev"],
  ] as const) {
    assert.equal(sameSite(a, b), false, `${a} !~ ${b}`);
  }
});
