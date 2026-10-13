#!/usr/bin/env node
// Generator for src/names.ts and widget-core/.size-limit.json — the Name Registry
// made into typed code. Every token comes from derive() (registry-derive.mjs), so
// the product name exists in exactly one place: registry.json's `brand` block.
//
//   node gen-names.mjs           write the generated files
//   node gen-names.mjs --check   regenerate in memory, diff against what is
//                                committed, exit 1 on drift (the CI gate)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { derive } from "./registry-derive.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, "..", "registry.json");
const OUT = join(HERE, "..", "src", "names.ts");
const SIZE_LIMIT = join(HERE, "..", "..", "widget-core", ".size-limit.json");

const reg = JSON.parse(readFileSync(REGISTRY, "utf8"));
const d = derive(reg);

const q = (s) => JSON.stringify(s);
const union = (arr) => arr.map(q).join(" | ");
const placeholders = (tpl) => [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

function constMap(name, obj, doc) {
  const L = [];
  if (doc) L.push(`/** ${doc} */`);
  L.push(`export const ${name} = {`);
  for (const [k, v] of Object.entries(obj)) L.push(`  ${k}: ${q(v)},`);
  L.push(`} as const;`, "");
  return L;
}

function builder(typeName, fnName, map, doc) {
  const keys = Object.keys(map);
  return [
    `/** ${doc} */`,
    `export type ${typeName} = ${union(keys)};`,
    `const ${fnName}Token: Record<${typeName}, string> = {`,
    ...keys.map((k) => `  ${k}: ${q(map[k])},`),
    `};`,
    `export const ${fnName} = (name: ${typeName}): string => ${fnName}Token[name];`,
    "",
  ];
}

function build() {
  const L = [
    "// ─────────────────────────────────────────────────────────────────────────────",
    "// GENERATED FILE — DO NOT EDIT BY HAND.",
    "// Source of truth: packages/types/registry.json",
    "// Regenerate:      pnpm gen:names      (CI runs `pnpm gen:names:check`)",
    "//",
    "// The Name Registry made executable. Every token",
    "// below is DERIVED from registry.json's `brand` block — the product name lives",
    "// in exactly one place. test/rename.test.ts proves it: flip the brand, and no",
    "// token of the old one survives. SCHEMA_VERSION is the one deliberate literal.",
    "// ─────────────────────────────────────────────────────────────────────────────",
    "",
    ...constMap("BRAND", d.brand, "The one place the product name exists. Everything else derives from this."),
  ];

  for (const [k, v] of Object.entries(d.core)) {
    if (k === "SCHEMA_VERSION") {
      L.push("/** Frozen once v1 stores real data — stamped into exports, issue bodies and the MCP contract, so it must survive a rename (registry.frozen). */");
    }
    L.push(`export const ${k} = ${q(v)} as const;`);
  }
  L.push(
    "",
    "/** @returns e.g. `x-snagset-idempotency-key` */",
    "export const header = (name: string): string => HTTP_HEADER_PREFIX + name;",
    "/** @returns e.g. `SNAGSET_SESSION_TTL_S` */",
    "export const env = (name: string): string => ENV_PREFIX + name;",
    "/** @returns e.g. `snag_attachment_kind` */",
    "export const pgType = (name: string): string => PG_TYPE_PREFIX + name;",
    "/** @returns e.g. `snagset_http_requests_total` */",
    "export const metric = (name: string): string => METRIC_PREFIX + name;",
    "",
    ...constMap("GLOBALS", d.globals, "window.* names. Dunders are internal/test affordances, not public API."),
    ...builder("ScriptAttr", "scriptAttr", d.scriptAttr, "data-*-attributes on the host <script> tag."),
    ...builder("WidgetAttr", "widgetAttr", d.widgetAttr, "DOM the widget authors on itself."),
    ...builder("HostAttr", "hostAttr", d.hostAttr, "Attributes the host application may author."),
    ...builder("CssClass", "cssClass", d.cssClass, "Class-form masking hooks."),
    ...constMap(
      "CSS_VAR",
      d.cssVar,
      "Custom properties (the prefix, enumerated). The design makes every one of these public SemVer surface, so they are registered rather than minted at the point of use. Values are NOT here — the registry governs names, never design.",
    ),
    "/** Which tokens belong to which role — the dark block must override theme members only. */",
    "export const CSS_VAR_GROUPS = {",
    ...Object.entries(d.cssVarGroups).map(
      ([g, names]) => `  ${g}: [${names.map(q).join(", ")}],`,
    ),
    "} as const;",
    "",
    "export type CssVar = keyof typeof CSS_VAR;",
    "/** @returns e.g. `--snag-bg` */",
    "export const cssVar = (name: CssVar): string => CSS_VAR[name];",
    "/** @returns e.g. `var(--snag-bg)` — what stylesheets actually interpolate. */",
    "export const cssRef = (name: CssVar): string => `var(${CSS_VAR[name]})`;",
    "",
    `export type QueryParam = ${union(d.params.queryNames)};`,
    `export type FragmentParam = ${union(d.params.fragmentNames)};`,
    "/** @returns e.g. `snag_t`. The review-link secret is a FRAGMENT param. */",
    `export const param = (name: QueryParam | FragmentParam): string => ${q(d.params.prefix)} + name;`,
    "export const RESERVED_URL_PARAMS = {",
    `  query: [${d.params.query.map(q).join(", ")}],`,
    `  fragment: [${d.params.fragment.map(q).join(", ")}],`,
    "} as const;",
    "",
    "/** Point consts for hot paths: a chunk needing ONE key imports it and",
    " *  drops the whole table — object properties cannot tree-shake, and the",
    " *  panels chunk was carrying ten keys to read two. */",
    `export const DISCLOSURE_KEY = ${q(d.storage.disclosure)};`,
    `export const IDENTITY_KEY = ${q(d.storage.identity)};`,
    `export const THEME_ATTR = ${q(d.scriptAttr.theme)};`,
    "",
    "/** Web-storage keys. Parameterised keys are functions. */",
    "export const storageKey = {",
  );

  for (const [name, full] of Object.entries(d.storage)) {
    const args = placeholders(full);
    if (name === "disclosure" || name === "identity") {
      L.push(`  ${name}: ${name === "disclosure" ? "DISCLOSURE_KEY" : "IDENTITY_KEY"},`);
    } else if (args.length === 0) {
      L.push(`  ${name}: ${q(full)},`);
    } else {
      const sig = args.map((a) => `${a}: string`).join(", ");
      L.push(`  ${name}: (${sig}): string => \`${full.replace(/\{(\w+)\}/g, "${$1}")}\`,`);
    }
  }
  L.push("} as const;", "");

  L.push(
    "/** The v0.1 IndexedDB blob store \u2014 one database, one",
    " *  object store, shared by screenshots, reviewer images and the v2 outbox. */",
    "export const IDB = {",
    `  database: ${q(d.idb.database)},`,
    `  store: ${q(d.idb.store)},`,
    "} as const;",
    "",
  );

  // "no storage key outside the registry". A diff needs PATTERNS, since
  // half the keys are parameterised — and deriving them here means the check
  // cannot drift from the table it is checking against.
  L.push(
    "/** Anchored regex sources matching every registered key — the storage diff. */",
    "export const STORAGE_KEY_PATTERNS = [",
    ...Object.values(d.storage).map(
      (full) =>
        `  ${q("^" + full.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{\w+\\\}/g, ".+") + "$")},`,
    ),
    "] as const;",
    "",
  );

  L.push(
    ...constMap("COOKIE", d.cookies, "The WIDGET's two. Neither carries a credential, and no cookie authenticates the widget API — it runs on somebody else's origin."),
    ...constMap("DASHBOARD_COOKIE", d.dashboardCookies, "The dashboard's session + CSRF pair — first-party, on the server's own origin, owner audience."),
    '/** The design names these two constants directly; both spellings resolve to the same string. */',
    `export const DASHBOARD_SESSION_COOKIE = DASHBOARD_COOKIE.session;`,
    `export const DASHBOARD_CSRF_COOKIE = DASHBOARD_COOKIE.csrf;`,
    "",
    ...constMap("ARTIFACT", d.artifacts, "Built widget chunks. Preact lives only in `panels`."),
    ...constMap("ID_PREFIX", d.identifiers, "Wire-form entity id prefixes. Not brand-derived."),
    ...constMap(
      "CREDENTIAL_PREFIX",
      d.credentials,
      "Credential literals. Brand-DERIVED, and deliberately not the three-letter row shape: the literal is what gets registered with secret scanning, so a token pasted into a public repo is reported.",
    ),
    ...constMap("DOM_EVENT", d.domEvents, "CustomEvents dispatched on document."),
    ...constMap("HTTP_HEADER", d.httpHeaders, "Request/response header names inside the prefix."),
    ...constMap("META_NAME", d.metaNames, "Host-authored `<meta name>` keys we READ and never mint .: `route` is the only one."),
    ...constMap("SYMBOL_KEY", d.symbols, "Keys for Symbol.for() patch bookkeeping."),
  );

  return L.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

// size-limit config, generated from budgets so a filename or a budget can only
// change in registry.json. Only artifacts marked `built` are emitted (size-limit
// errors on a missing file).
//
// TWO SUM ROWS, and which files go in which is the whole point.
//
// The design gives the envelope as `snag.runtime.js + snag.panels.js` — it does NOT
// include the stub, which has its own 8 KB row directly above it in the same
// table. This generator used to sum every non-lazy artefact, which swept the
// stub in and charged it twice. The `envelope: false` flag is how an eager
// artefact says "budgeted separately"; the total row then exists so that
// correcting the first one leaves no byte unwatched.
function buildSizeLimit() {
  const rows = [];
  const envelope = [];
  const eager = [];
  for (const [id, b] of Object.entries(d.budgets.artifacts)) {
    if (!b.built) continue;
    const file = `dist/${d.artifacts[id]}`;
    // `enforced:false` reports a size without gating on it — the two
    // `— of which` sub-rows are a DECOMPOSITION of the 40 KB envelope, not
    // independent budgets, and the spec's own table leaves their Enforced-by
    // cell empty. size-limit prints a row with no `limit` and passes it.
    rows.push({
      name: `${d.artifacts[id]}${b.lazy ? " (lazy)" : ""}${b.enforced === false ? ` — reported, ${b.budgetKb} KB estimated` : ""}`,
      path: file,
      ...(b.enforced === false ? {} : { limit: `${b.budgetKb} KB` }),
      gzip: true,
      brotli: false,
    });
    if (b.lazy) continue;
    eager.push(file);
    if (b.envelope !== false) envelope.push(file);
  }
  if (envelope.length > 1) {
    rows.push({
      name: `runtime envelope (${envelope.length} chunks), verbatim`,
      path: envelope,
      limit: `${d.budgets.activationEnvelopeKb} KB`,
      gzip: true,
      brotli: false,
    });
  }
  if (eager.length > envelope.length) {
    const total = eager.reduce((n, f) => {
      const id = Object.keys(d.artifacts).find((k) => `dist/${d.artifacts[k]}` === f);
      return n + d.budgets.artifacts[id].budgetKb;
    }, 0);
    rows.push({
      name: `total activation cost (${eager.length} eager chunks) — the rows summed`,
      path: eager,
      limit: `${total} KB`,
      gzip: true,
      brotli: false,
    });
  }
  return JSON.stringify(rows, null, 2) + "\n";
}

const targets = [
  { path: OUT, next: build(), label: "names.ts" },
  { path: SIZE_LIMIT, next: buildSizeLimit(), label: "widget-core/.size-limit.json" },
];

if (process.argv.includes("--check")) {
  for (const t of targets) {
    let current = "";
    try {
      current = readFileSync(t.path, "utf8");
    } catch {
      console.error(`✗ ${t.label} is missing — run \`pnpm gen:names\`.`);
      process.exit(1);
    }
    if (current !== t.next) {
      console.error(`✗ ${t.label} is stale — registry.json changed. Run \`pnpm gen:names\` and commit.`);
      process.exit(1);
    }
  }
  console.log("✓ names.ts and .size-limit.json match registry.json");
} else {
  for (const t of targets) {
    writeFileSync(t.path, t.next);
    console.log(`✓ wrote ${t.path}`);
  }
}
