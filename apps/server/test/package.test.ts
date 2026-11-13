import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The published tarball's shape.
 *
 * ── WHY THIS FILE EXISTS ──
 *
 * `dist/bin.js` shipped `import … from "@snagset/types/names"`, a package that
 * is `private: true`, exports TypeScript source and is never published. Inside
 * this repo pnpm's symlink resolves it, so `node dist/bin.js` ran, the
 * checks passed, and it was committed as done. On `npm install snagset` it is
 * `ERR_MODULE_NOT_FOUND` before the program's first line — found by packing the
 * tarball and installing it into an empty directory.
 *
 * The same shape as the `/widget/*` bug: verified in the one environment that
 * hides the failure. So this suite asserts against `dist` ON DISK, never
 * against an import — an import would resolve through the workspace and report
 * green for exactly the broken thing.
 *
 * Skipped when there is no build, because `pnpm test` must not require one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const skip = existsSync(join(DIST, "bin.js")) ? false : "no dist — run `pnpm --filter snagset build` first";

const jsFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(dir, f));

test("no workspace specifier survives into dist", { skip }, () => {
  const offenders: string[] = [];
  for (const file of jsFiles(DIST)) {
    const found = readFileSync(file, "utf8").match(/from ["']@snagset\/[^"']+["']/g);
    if (found) offenders.push(`${file.slice(DIST.length + 1)} → ${found.join(", ")}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "a `@snagset/…` import in dist resolves in this repo and nowhere else — vendor it in scripts/build.mjs",
  );
});

test("every relative import in dist points at a file that is actually there", { skip }, () => {
  // The vendoring step rewrites specifiers by string replacement, and a
  // rewrite computed from the wrong base directory produces a path that is
  // still perfectly valid syntax. Resolved here rather than trusted.
  const missing: string[] = [];
  for (const file of jsFiles(DIST)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/from ["'](\.[^"']+)["']/g)) {
      const target = join(dirname(file), m[1]!);
      if (!existsSync(target)) missing.push(`${file.slice(DIST.length + 1)} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("dist ships no TypeScript", { skip }, () => {
  const ts = readdirSync(DIST, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
  // The bin is JavaScript because npm's Windows `.cmd` shim runs
  // `node <file>` and ignores the shebang, so a `.ts` bin cannot start there.
  assert.deepEqual(ts, []);
});

test("the migrations are beside the compiled migrate.js, not left in src", { skip }, () => {
  const dir = join(DIST, "db", "migrations");
  assert.ok(existsSync(dir), "migrate.js reads its .sql files from a directory beside itself");
  const sql = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  assert.ok(sql.length >= 3, `expected the migrations, found ${sql.length}`);
});

test("package.json's files list covers everything dist needs", { skip }, () => {
  const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")) as {
    files: string[];
    bin: Record<string, string>;
  };
  assert.ok(pkg.files.includes("dist"));
  assert.ok(pkg.files.includes("static"), "the widget and dashboard are served from static/");
  assert.ok(existsSync(join(HERE, "..", pkg.bin["snagset"]!.replace("./", ""))), "bin points at a real file");
});
