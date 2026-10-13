#!/usr/bin/env node
/**
 * Strip `devDependencies` out of a package's manifest for the duration of a
 * pack, and put them back afterwards.
 *
 * ── WHY THIS EXISTS ──
 *
 * Every publishable package in this repo devDepends on private workspace
 * packages — `@snagset/types`, `@snagset/tsconfig`, `@snagset/adapters`,
 * `@snagset/widget` — with pnpm's `workspace:*` protocol. `npm pack` copies
 * the manifest VERBATIM, so those lines end up in the published tarball:
 *
 *     "devDependencies": { "@snagset/types": "workspace:*", … }
 *
 * Two things wrong with that, and only the second one is obvious. `workspace:`
 * is a pnpm/yarn-berry protocol that npm cannot parse — so anyone who extracts
 * the tarball and runs `npm install` inside it gets an error rather than a
 * package. And the specifiers point at packages that are `private: true` and
 * will therefore never exist on any registry, so even a tool that understands
 * the protocol resolves them to nothing.
 *
 * It does not break `npm install snagset` — a dependency's devDependencies are
 * never installed — which is exactly why it would have shipped unnoticed and
 * then been unfixable: npm unpublish is closed after 72 hours, so a first
 * release carries its manifest forever.
 *
 * ── WHY REMOVE RATHER THAN REWRITE ──
 *
 * `pnpm publish` rewrites `workspace:*` to the linked package's version, which
 * for a private package means `"@snagset/types": "0.0.0"` — a public-registry
 * reference to something that does not exist. Trading an unparseable
 * specifier for a dangling one is not a fix.
 *
 * devDependencies serve NO purpose in a published tarball. Nothing installs
 * them, nothing reads them, and every one of ours is a build-time fact about
 * this monorepo. Removing the field is the honest answer.
 *
 * ── THE BACKUP IS DELIBERATELY A FILE ON DISK ──
 *
 * `npm publish` runs `prepack` → pack → `postpack`. If the upload fails
 * between them, `postpack` may not run and the working tree is left stripped.
 * The backup file makes that recoverable without git, `strip` refuses to
 * overwrite an existing one (so a double-strip cannot destroy the original),
 * and `restore` is a no-op when there is nothing to restore — which is what
 * makes it safe to wire into `postpack` unconditionally.
 *
 * Usage, from the package's own directory:
 *   node ../../tools/publish-manifest.mjs strip
 *   node ../../tools/publish-manifest.mjs restore
 */
import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const [, , command, dir = process.cwd()] = process.argv;
const manifest = join(dir, "package.json");
const backup = join(dir, "package.json.prepack-backup");

if (!["strip", "restore"].includes(command ?? "")) {
  process.stderr.write("usage: publish-manifest.mjs strip|restore [package-dir]\n");
  process.exit(2);
}

if (command === "restore") {
  // A no-op when there is nothing to restore, so `postpack` can run it
  // unconditionally — including after a `pack` that never stripped.
  if (existsSync(backup)) {
    renameSync(backup, manifest);
    process.stdout.write("✓ package.json restored\n");
  }
  process.exit(0);
}

if (existsSync(backup)) {
  // A previous run was interrupted between prepack and postpack. The backup is
  // the ORIGINAL; the manifest on disk is already stripped. Overwriting the
  // backup here would destroy the only copy of the devDependencies.
  process.stderr.write(
    `✗ ${backup} already exists — a previous pack did not finish.\n` +
      `  Run \`node tools/publish-manifest.mjs restore\` first.\n`,
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(manifest, "utf8"));
if (!pkg.devDependencies && !pkg.publishExports) {
  process.stdout.write("· nothing to strip\n");
  process.exit(0);
}

copyFileSync(manifest, backup);
const removed = Object.keys(pkg.devDependencies ?? {});
delete pkg.devDependencies;
// `publishExports`: a package the workspace consumes as TypeScript
// source — the server imports `@snagset/mcp` and runs on strip-types — but
// npm must resolve to the built JavaScript. The swap happens here, at pack
// time, and `restore` puts the workspace shape back.
if (pkg.publishExports) {
  pkg.exports = pkg.publishExports;
  delete pkg.publishExports;
  process.stdout.write("✓ exports swapped to the published shape\n");
}
writeFileSync(manifest, JSON.stringify(pkg, null, 2) + "\n");
if (removed.length) process.stdout.write(`✓ stripped ${removed.length} devDependencies (${removed.join(", ")})\n`);
