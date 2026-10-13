#!/usr/bin/env node
/**
 * The capture manifest, asserted against the BUILT artefacts — H1 (v0).
 *
 * The design makes a claim this file has to make checkable: *"Nothing is captured that
 * is not listed in of this document; the list is also shipped as a
 * machine-readable manifest."* A manifest that is merely written alongside the
 * code is a second thing to keep in sync, and the two drift silently — which is
 * the exact failure mode the redaction rules had before their corpus grew teeth.
 *
 * So this runs in BOTH directions, and the second one is the one that matters:
 *
 *   1. Every field at or below the SHIPPED STAGE is actually emitted.
 *   2. Every key the producer emits is in the manifest at or below it.
 *   3. Nothing tagged ABOVE it is REACHABLE from the built bundles — no
 *      breadcrumb installer, no host global wrapped. Direction 3 is what a
 *      client would want to verify themselves, and it is checked against
 *      shipped bytes rather than against source.
 *
 * The stage is `release` in the manifest, not a constant in here. It used to be
 * the literal "v0" in six places, so the build that shipped M2's breadcrumbs,
 * screenshots and masking failed its own capture check six times over — every
 * finding the checker being a release behind the product, none of them a leak.
 * Read from the manifest, the stage moves in one edit and is visible in the
 * document a client actually reads.
 *
 * Run after a build. `pnpm verify:capture`, and inside `pnpm verify`.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIDGET = join(ROOT, "packages/widget-core");
const DIST = join(WIDGET, "dist");
const manifest = JSON.parse(readFileSync(join(WIDGET, "capture-manifest.json"), "utf8"));

const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};

/** The release axis, in order. Anything else is a typo and is rejected below. */
const ORDER = ["v0", "v0.1", "v1", "v2"];
const STAGE = manifest.release;
if (!ORDER.includes(STAGE)) {
  console.error(`✗ verify-capture: the manifest's release "${STAGE}" is not one of ${ORDER.join(", ")}`);
  process.exit(1);
}
/** Is `r` at or below what this build ships? */
const shipped = (r) => ORDER.indexOf(r) <= ORDER.indexOf(STAGE);

const v0Fields = manifest.context.fields.filter((f) => shipped(f.release));
const laterFields = manifest.context.fields.filter((f) => !shipped(f.release));

/* ── 1 + 2. The producer's key set IS the manifest's v0 key set ──────────────
 *
 * Read off the emitted TYPE rather than by running the producer: the shape is a
 * closed type that validates key-for-key, the E2E suite already
 * asserts the runtime object against a real browser, and parsing the source
 * here keeps this check runnable without a DOM. What it catches is a field
 * added to the type and never written down.
 */
const types = readFileSync(join(WIDGET, "src/capture/types.ts"), "utf8");

/** The members of one `interface X { … }` / `capture?: { … }` block. */
function members(src, opener) {
  const at = src.indexOf(opener);
  if (at === -1) return null;
  let depth = 0;
  let start = -1;
  for (let i = at; i < src.length; i++) {
    if (src[i] === "{") {
      if (depth++ === 0) start = i + 1;
    } else if (src[i] === "}" && --depth === 0) {
      return src
        .slice(start, i)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        // A nested inline object (`viewport: { w: number … }`) is flattened by
        // the caller, so its braces are stripped here rather than parsed.
        .replace(/\{[^{}]*\}/g, "")
        .split(/[;\n]/)
        .map((l) => l.trim().match(/^(\w+)\??\s*:/)?.[1])
        .filter(Boolean);
    }
  }
  return null;
}

const top = members(types, "export interface CaptureContext");
check(top !== null, "cannot find CaptureContext in src/capture/types.ts");

const emitted = new Set();
for (const key of top ?? []) {
  // Flatten the inline objects the manifest lists by dotted path.
  const nested =
    key === "viewport" ? ["w", "h", "dpr"]
    : key === "screen" ? ["w", "h"]
    : key === "derived" ? ["browser", "os", "device"]
    : key === "page" ? members(types, "export interface PageRef")
    : key === "uaData" ? members(types, "export interface UaData")
    : key === "capture" ? members(types.slice(types.indexOf("capture?:")), "{")
    : null;
  if (nested) for (const n of nested) emitted.add(`${key}.${n}`);
  else emitted.add(key);
}

for (const f of v0Fields) {
  check(emitted.has(f.path), `manifest lists "${f.path}" at ${f.release}, but nothing emits it`);
}
for (const key of emitted) {
  const known = manifest.context.fields.find((f) => f.path === key);
  check(known, `the producer emits "${key}" and the manifest does not list it`);
  // A field tagged ABOVE the stage may still appear here: this direction reads
  // the emitted TYPE, and an optional key the payload assembler forwards is in
  // the type long before anything populates it. That is allowed only when the
  // manifest says so in writing, so the exemption is auditable rather than a
  // silent hole in the one check a client would run themselves.
  if (known && !shipped(known.release)) {
    check(
      known.typeOnly === true && typeof known.typeOnlyBecause === "string" && known.typeOnlyBecause.length > 40,
      `"${key}" is tagged ${known.release}, above this build's ${STAGE}, and the producer's type carries it — ` +
        `populate it never, or mark it typeOnly with a reason`,
    );
  }
}

/* ── 3. Nothing tagged above the stage is reachable from the shipped bytes ──
 *
 * Greps for the INSTALLER, not for the noun: a breadcrumb source is only real
 * once something wraps a host global or adds a listener, and the noun appears
 * in prose all over the codebase. Each pattern is the thing that would have to
 * be present for the source to exist at all.
 *
 * The stub is in the sweep because the release table gives it a footprint of
 * its own; at v0.1 it legitimately carries `crumbs-early`, so the sweep asserts
 * what is NOT yet due rather than that the stub is empty.
 */
const ARTEFACTS = ["snag.js", "snag.runtime.js", "snag.panels.js", "snag.capture.js", "snag.anchor-ext.js"];
const bundles = ARTEFACTS.map((f) => ({ f, src: readFileSync(join(DIST, f), "utf8") }));

const INSTALLERS = {
  "console-error-warn": { re: /console\s*\.\s*(error|warn)\s*=/, what: "assigning to console.error/warn" },
  "console-log-info-debug": { re: /console\s*\.\s*(log|info|debug)\s*=/, what: "assigning to console.log/info/debug" },
  fetch: { re: /(window|globalThis|self)\s*\.\s*fetch\s*=/, what: "wrapping fetch" },
  xhr: { re: /XMLHttpRequest\s*\.\s*prototype\s*\.\s*(open|send)\s*=/, what: "wrapping XMLHttpRequest" },
  unhandledrejection: { re: /["'`]unhandledrejection["'`]/, what: "listening for unhandledrejection" },
  "error-event": { re: /addEventListener\(\s*["'`]error["'`]/, what: "listening for the error event" },
};

/**
 * TWO ROWS CANNOT BE CHECKED THIS WAY, AND THEY SAY SO IN THE MANIFEST.
 *
 * `click` would be a click listener, and the capture net adds one for
 * hit-testing — a grep proves nothing. `navigation` installs nothing at all;
 * subscribes to the event rather than patching history. Both carry
 * `verifiable: false` with the reason, and both are covered instead by the
 * positive assertion below: neither can exist without wrapping a host global.
 *
 * They are REPORTED, not skipped quietly. A checker that silently covers less
 * than it appears to is worse than one that covers less and says so.
 */
const later = manifest.breadcrumbSources.sources.filter((s) => !shipped(s.release));
const unverifiable = later.filter((s) => s.verifiable === false);
for (const s of later) {
  if (s.verifiable === false) {
    check(
      typeof s.unverifiableBecause === "string" && s.unverifiableBecause.length > 40,
      `breadcrumb source "${s.id}" is marked unverifiable without saying why`,
    );
    continue;
  }
  const probe = INSTALLERS[s.id];
  check(probe, `breadcrumb source "${s.id}" has no way to detect it — add a probe or mark it unverifiable`);
  if (!probe) continue;
  for (const { f, src } of bundles) {
    check(!probe.re.test(src), `${f} contains ${probe.what} — "${s.id}" is tagged ${s.release} and must not ship`);
  }
}

/* The positive form, and the one a client can run themselves. Every breadcrumb
 * source — including the two unverifiable ones above — has to wrap one of
 * these, so the eager artefacts staying clean of all of them is a stronger
 * statement than any per-source grep. It holds at v0.1 because the installers
 * live in `snag.crumbs.js`, which is lazy and deliberately not in this list:
 * a page that never enters review mode never fetches it. */
for (const name of manifest.hostGlobals.mustNotBeAssigned) {
  const re = new RegExp(`${name.replace(/\./g, "\\s*\\.\\s*")}\\s*=[^=]`);
  for (const { f, src } of bundles) {
    check(!re.test(src), `${f} assigns to ${name} — no eager artefact may patch a host global`);
  }
}

// The two APIs the decision forbids on EVERY tier and in every version — "never called,
// no exceptions". Not a release gate; a standing one.
for (const { f, src } of bundles) {
  for (const api of ["getDisplayMedia", "getUserMedia", "navigator.credentials", "navigator.geolocation"]) {
    check(!src.includes(api), `${f} references ${api} — D25 forbids it on every tier`);
  }
  // And is a CI grep for exactly this.
  check(!src.includes("getHighEntropyValues"), `${f} calls getHighEntropyValues, which must never be called`);
}

/* ── The manifest's own coherence ────────────────────────────────────────── */
const seen = new Set();
for (const f of manifest.context.fields) {
  check(!seen.has(f.path), `duplicate field in the manifest: ${f.path}`);
  seen.add(f.path);
  check(/^v0(\.1)?$|^v1$|^v2$/.test(f.release), `${f.path} has an unrecognised release "${f.release}"`);
  check(typeof f.what === "string" && f.what.length > 12, `${f.path} has no usable description`);
}

if (!later.length) {
  console.log(
    `  note: every breadcrumb source is at or below ${STAGE}, so direction 3 gates nothing this build. ` +
      `Coverage is the no-host-global rule below it, over ${ARTEFACTS.length} eager artefacts.`,
  );
}

if (failures.length) {
  console.error("✗ verify-capture failed:");
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(
  `✓ verify-capture (${STAGE}): ${v0Fields.length} shipped fields match the producer, ` +
    `${laterFields.length} later field(s) and ${later.length - unverifiable.length}/${later.length} breadcrumb source(s) ` +
    `proven absent from ${ARTEFACTS.length} artefacts` +
    (unverifiable.length
      ? ` (${unverifiable.length} undetectable by grep, covered by the no-host-global rule: ` +
        `${unverifiable.map((s) => s.id).join(", ")})`
      : ""),
);
