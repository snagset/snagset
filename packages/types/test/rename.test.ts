import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-expect-error — plain-JS derivation module, deliberately not TS (it is the
// gate the TS toolchain bootstraps from).
import { derive, allTokens } from "../scripts/registry-derive.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const reg = JSON.parse(readFileSync(join(HERE, "..", "registry.json"), "utf8"));

// ─────────────────────────────────────────────────────────────────────────────
// THE PROPERTY THIS FILE EXISTS FOR (DoD c and e).
//
// Claims renaming the product is "a task measured in minutes"
// because every name derives from one place. A test that asserts hardcoded
// literals ("data-snag-site") pins TODAY'S BRAND and proves nothing about that
// claim — it passes just as happily when the claim is false. It was false: an
// audit flipped the brand and found 64 survivors.
//
// So: assert the property, not the strings.
// ─────────────────────────────────────────────────────────────────────────────

test("RENAME PROOF: flipping the brand leaves no trace of the old one", () => {
  const before = allTokens(derive(reg)) as string[];
  const after = allTokens(
    derive(reg, { long: "Gasket", short: "gsk", pkg: "gasket" }),
  ) as string[];

  const { long, short, pkg } = reg.brand;
  const survivors = after.filter(
    (t) =>
      t.toLowerCase().includes(short.toLowerCase()) ||
      t.toLowerCase().includes(pkg.toLowerCase()) ||
      t.includes(long),
  );

  // SCHEMA_VERSION is the one deliberate literal: it is stamped into exported
  // records and must survive a rename unchanged (registry.frozen).
  const expected = [reg.frozen.schemaVersion];
  assert.deepEqual(
    survivors,
    expected,
    `only the frozen schemaVersion may survive a rename; found: ${survivors.join(", ")}`,
  );

  // And the new brand must actually have taken everywhere else.
  assert.ok(before.length === after.length, "derivation must produce the same token count");
  assert.ok(
    after.filter((t) => t.includes("gsk") || t.includes("gasket") || t.includes("Gasket")).length >
      after.length * 0.7,
    "the overwhelming majority of tokens must carry the new brand",
  );
});

test("RENAME PROOF: the frozen token is the ONLY literal brand string in the registry", () => {
  // Any brand-shaped string in registry.json outside `brand` and `frozen` is a
  // hardcoded token that a rename would silently miss.
  const { brand, frozen, ...rest } = reg;
  const json = JSON.stringify(rest);
  const stripped = json.replace(/"\$comment":\s*"(?:[^"\\]|\\.)*"/g, "");
  for (const needle of [brand.short, brand.pkg, brand.long]) {
    assert.ok(
      !stripped.toLowerCase().includes(needle.toLowerCase()),
      `registry.json hardcodes "${needle}" outside the brand block — a rename would miss it`,
    );
  }
  assert.equal(frozen.schemaVersion, `${brand.pkg}.v1`, "sanity: frozen version tracks today's brand");
});

test("derivation shape: prefixes compose from brand, not from literals", () => {
  const g = derive(reg, { long: "Zed", short: "zd", pkg: "zed" });
  assert.equal(g.core.PRODUCT, "Zed");
  assert.equal(g.core.NPM_SCOPE, "@zed");
  assert.equal(g.core.CSS_VAR_PREFIX, "--zd-");
  assert.equal(g.core.HTTP_HEADER_PREFIX, "x-zed-");
  assert.equal(g.core.ENV_PREFIX, "ZED_");
  assert.equal(g.core.PG_TYPE_PREFIX, "zd_");
  assert.equal(g.core.METRIC_PREFIX, "zed_");
  assert.equal(g.globals.api, "Zed");
  assert.equal(g.globals.disabled, "__ZED_DISABLED__");
  assert.equal(g.scriptAttr.site, "data-zd-site");
  assert.equal(g.scriptAttr.assetBase, "data-zd-asset-base"); // camel key → kebab token
  assert.equal(g.widgetAttr.root, "data-zd-root");
  assert.equal(g.cssClass.mask, "zd-mask");
  assert.equal(g.storage.threads, "zd:threads:{uid}:{env}");
  assert.equal(g.cookies.off, "zd_off");
  assert.equal(g.artifacts.stub, "zd.js");
  assert.equal(g.artifacts.runtime, "zd.runtime.js");
  assert.equal(g.artifacts.anchorExt, "zd.anchor-ext.js");
  assert.equal(g.domEvents.ready, "zed:ready");
  assert.equal(g.symbols.original, "zed.original");
});

test("the deliberate non-derived tokens stay put across a rename", () => {
  const g = derive(reg, { long: "Zed", short: "zd", pkg: "zed" });
  // Entity id prefixes are abbreviations, not brand.
  assert.equal(g.identifiers.project, "prj_");
  assert.equal(g.identifiers.thread, "thr_");
  // The reserved custom-key prefix is intentionally name-independent, so
  // a host that avoids it today keeps working after any future rebrand.
  assert.equal(g.core.RESERVED_CUSTOM_PREFIX, "cr.");
});

test("the review-link secret is a fragment param, never query", () => {
  const d = derive(reg);
  assert.ok(d.params.fragment.length > 0 && d.params.query.length > 0, "both halves must be non-empty");
  assert.deepEqual(d.params.fragment, [`${reg.brand.short}_k`], "exactly one fragment param: the secret");
  assert.ok(
    !d.params.query.some((p: string) => p.endsWith("_k")),
    "the secret must never appear as a query param — it would land in CDN logs and Referer",
  );
});
