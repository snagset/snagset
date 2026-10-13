import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The JavaScript API docs page describes the API that EXISTS — asserted, in
 * both directions.
 *
 * This test is here because the alternative was nearly shipped. The
 * surface is a TypeScript declaration covering v0 through v1, and lifting it
 * onto the docs site the way the attribute and parameter tables are lifted
 * would have advertised `identify()`, `getThreads()` and `mount()` — none of
 * which exist. A reader would have written code against them and found nothing
 * there. That is the same failure as the install snippet that omitted
 * `data-snag-host`: documentation that describes a product we do not have.
 *
 * So the page is written by hand against the shipped surface, and this keeps
 * it that way:
 *
 *   · Every method documented must exist on `SnagsetApi`.
 *   · Every method on `SnagsetApi` must be documented, or listed as absent.
 *
 * The second direction is the one that rots silently: adding a method and
 * forgetting the docs is invisible until somebody asks why it is not written
 * down.
 */

const HERE = import.meta.dirname;
const API_SRC = readFileSync(join(HERE, "..", "src", "api.ts"), "utf8");
const PAGE = readFileSync(join(HERE, "..", "..", "..", "docs", "js-api.md"), "utf8");

/** The members of `SnagsetApi`, read from the interface the runtime implements. */
function shippedMembers(): { methods: string[]; props: string[] } {
  const start = API_SRC.indexOf("interface SnagsetApi");
  assert.notEqual(start, -1, "SnagsetApi is where the shipped surface is declared");
  // To the closing brace at column 0 — the interface is top-level.
  const end = API_SRC.indexOf("\n}", start);
  const body = API_SRC.slice(start, end);

  const methods: string[] = [];
  const props: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^\s{2}(?:readonly\s+)?([a-zA-Z_][\w]*)\s*(\(|\??:)/.exec(line);
    if (!m) continue;
    (m[2] === "(" ? methods : props).push(m[1]!);
  }
  return { methods, props };
}

/** Names the page presents as real API, from its prose and its table. */
function documented(): Set<string> {
  const out = new Set<string>();
  // **`activate(opts?)`** — a method heading.
  for (const m of PAGE.matchAll(/\*\*`([a-zA-Z_][\w]*)\(/g)) out.add(m[1]!);
  // | `version` | — a property row.
  for (const m of PAGE.matchAll(/^\|\s*`([a-zA-Z_][\w]*)`\s*\|/gm)) out.add(m[1]!);
  return out;
}

/** Names the page explicitly says are NOT implemented. */
function declaredAbsent(): Set<string> {
  const tail = PAGE.slice(PAGE.indexOf("## What is not here yet"));
  return new Set([...tail.matchAll(/`([a-zA-Z_][\w]*)\(\)`/g)].map((m) => m[1]!));
}

test("every method the docs describe actually exists", () => {
  const { methods, props } = shippedMembers();
  const real = new Set([...methods, ...props]);
  const absent = declaredAbsent();

  for (const name of documented()) {
    if (absent.has(name)) continue;
    assert.ok(
      real.has(name),
      `docs/js-api.md documents \`${name}\`, which is not on SnagsetApi. A reader ` +
        `would write code against it and find nothing there.`,
    );
  }
});

test("every method that exists is documented, or named as not shipped", () => {
  const { methods } = shippedMembers();
  const docs = documented();
  const absent = declaredAbsent();

  // `__duplicates` and friends are diagnostics, not API — marks them
  // @internal and they are deliberately undocumented.
  const internal = (name: string) => name.startsWith("__");

  const missing = methods.filter((m) => !docs.has(m) && !absent.has(m) && !internal(m));
  assert.deepEqual(
    missing,
    [],
    "these are on SnagsetApi and absent from docs/js-api.md — the direction that " +
      "rots silently, because nobody notices an undocumented method until they need it",
  );
});

test("the page does not describe the v1 surface the spec also carries", () => {
  // The specific mistake this suite exists to prevent: declares these
  // and the runtime does not implement them.
  for (const unbuilt of ["identify", "getThreads", "refresh", "setMetadata", "mount"]) {
    const shipped = shippedMembers().methods.includes(unbuilt);
    if (shipped) continue; // it landed — then it may be documented
    const pattern = new RegExp(`\\*\\*\`${unbuilt}\\(`);
    assert.ok(
      !pattern.test(PAGE),
      `docs/js-api.md presents \`${unbuilt}()\` as available, and it is not implemented`,
    );
  }
});
