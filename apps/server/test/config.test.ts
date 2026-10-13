import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ConfigError, loadConfig } from "../src/config.ts";
import { DELETED, REGISTRY } from "../src/config.generated.ts";

/**
 * The rules. The LIST is generated from the spec and checked for drift
 * below; these are the RULES applied to it, which is the half that can be
 * wrong in a way a diff cannot see.
 */

const DB = "postgres://localhost:5432/snagset";

/** node's `assert.throws` returns void, so the error is caught to be read. */
function refused(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected a ConfigError, got ${String(e)}`);
    return e;
  }
  throw new Error("expected a ConfigError, nothing was thrown");
}

test("DATABASE_URL is the only required variable — the whole promise", () => {
  const cfg = loadConfig({ DATABASE_URL: DB });
  assert.equal(cfg.required("DATABASE_URL"), DB);
  assert.equal(REGISTRY.filter((r) => r.required).length, 1);
  // …and everything else came from a default that makes one machine work.
  assert.equal(cfg.int("SNAGSET_PORT"), 8080);
  assert.equal(cfg.get("SNAGSET_BASE_URL"), "http://localhost:8080");
  assert.equal(cfg.get("SNAGSET_LOG_LEVEL"), "info");
});

test("a missing DATABASE_URL names the variable and says what to do", () => {
  const e = refused(() => loadConfig({}));
  assert.match(e.message, /DATABASE_URL is required/);
  assert.match(e.fix, /Postgres connection string/);
});

test("an unknown SNAGSET_* is FATAL, and suggests the closest real name", () => {
  // "with the offending name, the closest registered name by
  // edit distance, and a link to this section". A transposed letter in a
  // retention variable is a data-loss bug found at restore time.
  const e = refused(() => loadConfig({ DATABASE_URL: DB, SNAGSET_PROT: "8080" }));
  assert.match(e.message, /unknown environment variable SNAGSET_PROT/);
  assert.match(e.fix, /did you mean SNAGSET_PORT/);
  // Rule 2 says "a link to this section", and the pointer used to be
  // That file is not in the npm tarball, so for
  // the operator this error was written for it was a dead end. `snagset env`
  // prints the same registry from the binary they already have.
  assert.match(e.fix, /snagset env/);
});

test("a RETIRED name is told what it became — the whole purpose", () => {
  // "an operator upgrading from an early build needs to be told what happened
  // to a variable, and a name that merely disappears comes back."
  const e = refused(() => loadConfig({ DATABASE_URL: DB, SNAGSET_PUBLIC_URL: "https://x.test" }));
  assert.match(e.message, /no longer a Snagset variable/);
  assert.match(e.fix, /renamed — set SNAGSET_BASE_URL/);
  assert.ok(DELETED.length > 20, "The whole table is parsed, not a sample");
});

test("customer-owned variables are NOT ours to reject", () => {
  // These are set on the CUSTOMER's build and documented. "The
  // server never reads them and must not reject them, because it never sees
  // them" — but a shared shell is exactly where it would see them.
  const cfg = loadConfig({
    DATABASE_URL: DB,
    NEXT_PUBLIC_SNAGSET_ENABLED: "true",
    SNAGSET_PRODUCTION_TOKEN_MODE: "strict",
    PATH: "/usr/bin",
    CI: "true",
  });
  assert.equal(cfg.required("DATABASE_URL"), DB);
});

test("closed sets, ints and bools are all refused rather than coerced", () => {
  assert.match(
    refused(() => loadConfig({ DATABASE_URL: DB, SNAGSET_DATABASE_SSL: "maybe" })).message,
    /auto \| require \| disable/,
  );
  // Rule 8: byte counts are integers, never "5MB" — a value the operator
  // believes is 5 MB and the program reads as NaN is the worst of both.
  assert.match(
    refused(() => loadConfig({ DATABASE_URL: DB, SNAGSET_MAX_BODY_BYTES: "5MB" })).message,
    /whole number/,
  );
  assert.match(
    refused(() => loadConfig({ DATABASE_URL: DB, SNAGSET_READ_ONLY: "yes" })).message,
    /true, false, 1 or 0/,
  );
});

test("bools accept the four spellings, case-insensitively (rule 8)", () => {
  for (const [raw, want] of [["true", true], ["TRUE", true], ["1", true], ["false", false], ["0", false]] as const) {
    assert.equal(loadConfig({ DATABASE_URL: DB, SNAGSET_READ_ONLY: raw }).bool("SNAGSET_READ_ONLY"), want, raw);
  }
});

test("telemetry is registered ONLY so it can be refused", () => {
  // "Registered so the boot validator can reject an attempt to turn it on,
  // and so the 'no phone-home, ever' is mechanically true rather than a
  // promise in prose."
  const row = REGISTRY.find((r) => r.name === "SNAGSET_TELEMETRY");
  assert.ok(row, "the row exists");
  assert.equal(loadConfig({ DATABASE_URL: DB }).get("SNAGSET_TELEMETRY"), "off");
});

test("describe() reports every value's source, and marks the secrets", () => {
  // `snagset doctor` prints this table and redacts the secrets.
  const rows = loadConfig({ DATABASE_URL: DB, SNAGSET_PORT: "9000" }).describe();
  assert.equal(rows.find((r) => r.name === "SNAGSET_PORT")?.source, "env");
  assert.equal(rows.find((r) => r.name === "SNAGSET_LOG_LEVEL")?.source, "default");
  assert.ok(
    rows.some((r) => r.secret),
    "at least the signing key is marked secret",
  );
});

// ── the first five minutes ───────────────────────────────────────────────

test("a dropped name segment is suggested — plain edit distance was not enough", () => {
  // Measured on a cold install: `SNAGSET_OWNER_EMAIL` is 10 edits from
  // `SNAGSET_BOOTSTRAP_OWNER_EMAIL`, over any sane threshold, so the error
  // suggested NOTHING while the right answer was the same name with one word
  // inserted. That is the mistake a first-time operator actually makes.
  const e = refused(() => loadConfig({ DATABASE_URL: DB, SNAGSET_OWNER_EMAIL: "a@b.test" }));
  assert.match(e.fix, /did you mean SNAGSET_BOOTSTRAP_OWNER_EMAIL/);
});

test("a genuine typo still resolves by edit distance", () => {
  const e = refused(() => loadConfig({ DATABASE_URL: DB, SNAGSET_PORTT: "8080" }));
  assert.match(e.fix, /did you mean SNAGSET_PORT/);
});

test("the unknown-variable error points at something the operator HAS", () => {
  const e = refused(() => loadConfig({ DATABASE_URL: DB, SNAGSET_NONSENSE_XYZZY: "1" }));
  // Is not in the npm tarball. An operator who
  // installed the package cannot open it, so it was a dead end.
  assert.ok(!/specs\//.test(e.fix), `still points at the repo: ${e.fix}`);
  assert.match(e.fix, /snagset env/);
});
