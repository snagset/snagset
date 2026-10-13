import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PRODUCT,
  NPM_PACKAGE,
  NPM_SCOPE,
  SCHEMA_VERSION,
  scriptAttr,
  hostAttr,
  widgetAttr,
  cssClass,
  param,
  RESERVED_URL_PARAMS,
  storageKey,
  COOKIE,
  ARTIFACT,
  GLOBALS,
  env,
  pgType,
  metric,
  header,
} from "../src/names.ts";

// This file tests the GENERATED MODULE as consumers see it — rename.test.ts
// tests the derivation function. Both are needed: a pure property test can pass
// while the generator emits something else entirely.
//
// Expectations are COMPOSED FROM THE BRAND, never hardcoded. An earlier version
// asserted ~32 literals and duly broke on the Snagsheet→Snagset rename while the
// property tests rode through untouched — which is the whole argument for this
// style, demonstrated at our own expense.
const HERE = dirname(fileURLToPath(import.meta.url));
const reg = JSON.parse(readFileSync(join(HERE, "..", "registry.json"), "utf8"));
const { long, short, pkg } = reg.brand;

test("core identity comes from the brand block", () => {
  assert.equal(PRODUCT, long);
  assert.equal(NPM_PACKAGE, pkg);
  assert.equal(NPM_SCOPE, `@${pkg}`);
  assert.equal(SCHEMA_VERSION, reg.frozen.schemaVersion);
});

test("attribute builders compose data-<short>-* tokens", () => {
  assert.equal(scriptAttr("site"), `data-${short}-site`);
  assert.equal(scriptAttr("assetBase"), `data-${short}-asset-base`, "camel key → kebab token");
  assert.equal(hostAttr("anchor"), `data-${short}-anchor`);
  assert.equal(widgetAttr("root"), `data-${short}-root`);
  assert.equal(cssClass("block"), `${short}-block`);
});

test("the review-link secret is a fragment param, never query", () => {
  assert.equal(param("k"), `${short}_k`);
  assert.ok(RESERVED_URL_PARAMS.fragment.includes(`${short}_k` as never));
  assert.ok(!RESERVED_URL_PARAMS.query.includes(`${short}_k` as never));
});

test("storage keys interpolate in registry order under the <short>: prefix", () => {
  assert.equal(storageKey.identity, `${short}:identity`);
  assert.equal(storageKey.session("p7"), `${short}:session:p7`);
  assert.equal(storageKey.threads("p7", "staging"), `${short}:threads:p7:staging`);
  assert.equal(storageKey.disclosure, `${short}:disclosure:v1`);
});

test("cookies, artifacts, globals and server builders", () => {
  assert.equal(COOKIE.off, `${short}_off`);
  assert.equal(ARTIFACT.stub, `${short}.js`);
  assert.equal(ARTIFACT.panels, `${short}.panels.js`);
  assert.equal(GLOBALS.api, long);
  assert.equal(GLOBALS.config, `${long}Config`);
  assert.equal(GLOBALS.disabled, `__${pkg.toUpperCase()}_DISABLED__`);
  assert.equal(env("SESSION_TTL_S"), `${pkg.toUpperCase()}_SESSION_TTL_S`);
  assert.equal(pgType("attachment_kind"), `${short}_attachment_kind`);
  assert.equal(metric("http_requests_total"), `${pkg}_http_requests_total`);
  assert.equal(header("idempotency-key"), `x-${pkg}-idempotency-key`);
});

test("the short prefix is what a client's page carries, and it is terse", () => {
  // Everything injected into someone else's DOM uses <short>, not the full
  // product word: a client's markup should not carry a long brand name.
  assert.ok(short.length <= 6, `short prefix "${short}" is too long for host DOM`);
  for (const token of [scriptAttr("site"), widgetAttr("root"), storageKey.identity, ARTIFACT.stub]) {
    assert.ok(
      !token.toLowerCase().includes(pkg.toLowerCase()) || pkg === short,
      `${token} should carry the short prefix, not the full package word`,
    );
  }
});

test("no dead-era token survives in any exported string", () => {
  const all = JSON.stringify([
    PRODUCT, SCHEMA_VERSION, GLOBALS, COOKIE, ARTIFACT, RESERVED_URL_PARAMS,
    scriptAttr("site"), hostAttr("anchor"), storageKey.identity, env("X"), pgType("y"),
  ]).toLowerCase();
  for (const dead of ["cedilla", "data-cd-", "clickreview", "data-cr-"]) {
    assert.ok(!all.includes(dead), `dead token "${dead}" leaked into names`);
  }
});
