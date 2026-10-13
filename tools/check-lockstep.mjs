#!/usr/bin/env node
/**
 * `create-snagset` and `@snagset/server` must carry the SAME version.
 *
 * ── THE BUG THIS EXISTS FOR, WHICH HAPPENED ──
 *
 * `scaffold.ts` pins the server to the scaffolder's own version, deliberately:
 * *"Pinned to THIS scaffolder's version, so `create-snagset@1.4.2` produces a
 * repo on `@snagset/server@1.4.2`. A caret here would let a fresh scaffold
 * resolve to a server this template has never been run against."* Good rule.
 *
 * It also means the two versions are a single fact stored in two files, and on
 * 2026-08-27 they disagreed: `create-snagset@0.0.1` was published while the
 * server sat at `0.0.0`. Every scaffold that package produced asked npm for
 * `@snagset/server@0.0.1`, which did not exist — so `npm install` failed on a
 * brand-new project, at the very first command of the ten-minute story.
 *
 * Nothing caught it, because nothing could: both packages were internally
 * consistent, both built, both packed, both passed their tests. The mismatch
 * only exists BETWEEN them. It was found by running the stranger's path from
 * packed tarballs, which is the one place it is visible.
 *
 * So the check is here rather than in either package, it runs in `verify`, and
 * it costs nothing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(REPO, p), "utf8"));

const scaffolder = read("packages/create-snagset/package.json");
const server = read("apps/server/package.json");

if (scaffolder.version !== server.version) {
  process.stderr.write(
    `✗ create-snagset@${scaffolder.version} would scaffold @snagset/server@${scaffolder.version}, ` +
      `but that package is at ${server.version}.\n` +
      `  scaffold.ts pins the server to the scaffolder's own version, so publishing them\n` +
      `  at different versions produces projects whose first \`npm install\` fails.\n` +
      `  Set both to the same version before publishing either.\n`,
  );
  process.exit(1);
}

process.stdout.write(`✓ create-snagset and @snagset/server are both ${server.version}\n`);
