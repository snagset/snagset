import { DELETED, REGISTRY, type VarRow } from "./config.generated.ts";

/**
 * The boot validator, and the ONLY module in the server that may read
 * `process.env`.
 *
 * And the scaffold's import lint make that mechanical rather than
 * conventional: a route handler that reaches for `process.env` fails the
 * lint. Every handler takes its config from `createApp(deps)`, which is what
 * lets a test construct one instead of mutating the process.
 *
 * The REGISTRY is generated — see `scripts/gen-config.mjs` and the
 * rule it quotes. Nothing here is hand-maintained; this file is the rules,
 * not the list.
 *
 * The rules, as implemented:
 *
 *  1. `DATABASE_URL` is the one required variable, in the platform's own
 *     spelling — the deliberate exception to the `SNAGSET_*` shape, because
 *     the Vercel marketplace mints it in the deploy click and Railway/Render
 *     inject it. The promise stands: one deployable unit, one required
 *     datastore, and everything else defaults to something that works.
 *  2. An unknown `SNAGSET_*` is FATAL at boot, "with the offending name, the
 *     closest registered name by edit distance, and a link to this section" —
 *     because a transposed letter in a retention variable that silently
 *     reverts to its default is a data-loss bug discovered at restore time.
 *  7. Customer-owned variables are not ours: `*_SNAGSET_ENABLED` and
 *     `SNAGSET_PRODUCTION_TOKEN_MODE` are set on the CUSTOMER's build
 *     and the server "never reads them and must not reject them,
 *     because it never sees them" — so the prefix test is anchored.
 *  8. Booleans are `true|false|1|0` case-insensitively; anything else fatal.
 */

export class ConfigError extends Error {
  /** What the operator should do about it — printed under the message. */
  readonly fix: string;
  constructor(message: string, fix: string) {
    super(message);
    this.name = "ConfigError";
    this.fix = fix;
  }
}

/** The carve-out: names a customer sets on THEIR build. */
const NOT_OURS = /^.+_SNAGSET_ENABLED$|^SNAGSET_PRODUCTION_TOKEN_MODE$/;

/** Levenshtein, for rule 2's "closest registered name". */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * The near-miss suggestion, and it is TOKEN-AWARE for a measured reason.
 *
 * Plain edit distance failed the exact mistake a first-time operator makes.
 * `SNAGSET_OWNER_EMAIL` → `SNAGSET_BOOTSTRAP_OWNER_EMAIL` is 10 edits away —
 * over any sane threshold — so the error said "unknown variable" and suggested
 * nothing, while the right answer was the same name with one word inserted.
 * Caught by mistyping it on a cold install and getting a dead end.
 *
 * So: if the typed name's underscore-separated words appear IN ORDER inside a
 * registered name, that is a dropped or added segment rather than a typo, and
 * it is a far stronger signal than character distance. Edit distance stays as
 * the fallback for genuine typos (`SNAGSET_PROT`).
 */
function closest(name: string): string | null {
  const words = name.toUpperCase().split("_").filter(Boolean);

  // Subsequence match first, shortest winner — `SNAGSET_OWNER_EMAIL` should
  // reach `SNAGSET_BOOTSTRAP_OWNER_EMAIL` rather than some longer name that
  // also happens to contain those words.
  let bySegment: string | null = null;
  for (const row of REGISTRY) {
    const target = row.name.split("_");
    let i = 0;
    for (const part of target) if (i < words.length && part === words[i]) i++;
    if (i === words.length && (bySegment === null || row.name.length < bySegment.length)) {
      bySegment = row.name;
    }
  }
  if (bySegment) return bySegment;

  let best: string | null = null;
  let score = Infinity;
  for (const row of REGISTRY) {
    const n = distance(name, row.name);
    if (n < score) {
      score = n;
      best = row.name;
    }
  }
  // Beyond a few edits it is not a typo, it is a different idea — and a
  // confident wrong suggestion is worse than none.
  return score <= 6 ? best : null;
}

/** The parsed, validated environment. Indexed by name; typed accessors below. */
export interface Config {
  readonly get: (name: string) => string | undefined;
  readonly int: (name: string) => number;
  readonly bool: (name: string) => boolean;
  readonly required: (name: string) => string;
  /** Every value with where it came from — `snagset doctor` prints
   *  this and redacts anything registered as a secret. */
  readonly describe: () => { name: string; value: string | null; source: "default" | "env"; secret: boolean }[];
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const rows = new Map(REGISTRY.map((r) => [r.name, r]));
  const retired = new Map(DELETED.map((d) => [d.name, d.to]));

  // Rule 2, FIRST — before any value is read. An operator who typo'd a flag
  // wants to hear about the typo, not about the consequence of it being
  // unset: they turned something off, it stayed on, and nothing said so.
  for (const name of Object.keys(env)) {
    if (!name.startsWith("SNAGSET_") || rows.has(name) || NOT_OURS.test(name)) continue;

    // Exists precisely so an upgrade says what a name BECAME.
    if (retired.has(name)) {
      const to = retired.get(name);
      throw new ConfigError(
        `${name} is no longer a Snagset variable`,
        to ? `it was renamed — set ${to} instead` : `it was deleted`,
      );
    }
    const near = closest(name);
    throw new ConfigError(
      `unknown environment variable ${name}`,
      // Is the registry and is NOT in the npm
      // tarball — an operator who installed the package has no
      // directory, so the one pointer this error gave was to a file they could
      // not open. `snagset env` is the same registry, printed by the binary
      // they already have in front of them.
      `${near ? `did you mean ${near}? ` : ""}run \`snagset env\` for the full list`,
    );
  }

  const resolved = new Map<string, { value: string | null; source: "default" | "env" }>();
  for (const row of REGISTRY) {
    const raw = env[row.name];
    if (raw !== undefined && raw !== "") {
      validate(row, raw);
      resolved.set(row.name, { value: raw, source: "env" });
    } else if (row.required) {
      throw new ConfigError(
        `${row.name} is required`,
        `set ${row.name} — a Postgres connection string`,
      );
    } else {
      resolved.set(row.name, { value: row.default, source: "default" });
    }
  }

  const get = (name: string): string | undefined => resolved.get(name)?.value ?? undefined;
  return {
    get,
    int: (name) => Number(get(name)),
    bool: (name) => /^(true|1)$/i.test(get(name) ?? ""),
    required: (name) => {
      const v = get(name);
      if (v === undefined) throw new ConfigError(`${name} has no value`, `set ${name}`);
      return v;
    },
    describe: () =>
      REGISTRY.map((r) => ({
        name: r.name,
        value: resolved.get(r.name)!.value,
        source: resolved.get(r.name)!.source,
        secret: r.secret,
      })),
  };
}

function validate(row: VarRow, raw: string): void {
  const bad = (why: string, fix: string): never => {
    throw new ConfigError(`${row.name} ${why}`, fix);
  };
  if (row.oneOf && !row.oneOf.includes(raw)) {
    bad(`must be one of ${row.oneOf.join(" | ")}, got ${JSON.stringify(raw)}`, `set ${row.name} to one of: ${row.oneOf.join(", ")}`);
  }
  // Rule 8: byte counts are integers, never "5MB" strings — a value the
  // operator believes is 5 MB and the program reads as NaN is the worst of
  // both, so it is refused rather than coerced.
  if (row.type === "int" && !/^\d+$/.test(raw)) {
    bad(`must be a whole number, got ${JSON.stringify(raw)}`, `set ${row.name} to digits only (durations are seconds/days by their suffix; byte counts are bytes)`);
  }
  if (row.type === "bool" && !/^(true|false|1|0)$/i.test(raw)) {
    bad(`must be true, false, 1 or 0 — got ${JSON.stringify(raw)}`, `set ${row.name} to true or false`);
  }
  // The `url` type covers three families and the allowlist has to name all of
  // them: http(s) for base URLs and webhooks, postgres(ql) for DATABASE_URL,
  // and smtp(s) for the mail transport. Found live: a correct
  // `smtp://host:2525` was refused by a validator that only knew the first
  // two, so the SMTP adapter could not be configured at all — a boot failure
  // for a variable whose entire purpose is to hold an SMTP URL.
  if (row.type === "url" && !/^(https?|postgres(ql)?|smtps?):\/\//.test(raw)) {
    bad(
      `must be a URL, got ${JSON.stringify(raw)}`,
      `set ${row.name} to a full URL including the scheme (http://, https://, postgres://, smtp:// or smtps://)`,
    );
  }
}
