#!/usr/bin/env node
/**
 * A backtick inside a `--` comment inside a tagged template literal ENDS the
 * template.
 *
 * This has now cost four separate build breaks in one project — attachments.ts,
 * toolbar.ts, and twice in threads.ts — every one of them from writing prose
 * the way prose is written everywhere else in this codebase, where identifiers
 * go in backticks. Inside a `sql` template the same habit produces a syntax
 * error thirty lines further down, at a line that is fine, and the real cause
 * is invisible because the editor's own highlighting has already given up.
 *
 * It is not a style rule. The comment convention in this repo is dense and
 * deliberate — the fix is not "write fewer comments in SQL", it is "spell the
 * identifier without the quotes there", which costs nothing and reads the same.
 *
 * Scans for a line inside a template literal that contains a SQL line comment
 * with a backtick after it. Deliberately simple: a real parser would catch
 * cases this misses, and this catches the case that has actually happened four
 * times.
 *
 * ── A GENERAL VERSION WAS ATTEMPTED AND ABANDONED (2026-08-24) ──
 *
 * The same mistake also lands in `//` and `/* … *\/` comments inside CSS
 * templates — three times in one session — so a linter for the whole class was
 * written and then deleted. Recorded here so nobody spends the afternoon
 * again:
 *
 *   · A hand-rolled scanner needs to track strings, escapes, comments, REGEX
 *     LITERALS (this repo matches backticked identifiers with them) and, in
 *     .tsx, the whole of JSX. Thirty false positives, then five, then three —
 *     every one an ordinary comment in ordinary code.
 *   · Rebuilt on the TypeScript parser, which handles all of that, the obvious
 *     check never fires: by parse time the stray backtick has ALREADY ended
 *     the template, so the offending line is no longer inside it.
 *   · Detecting the real signature instead — a template whose text runs out
 *     while inside a comment — fires on legitimate code, because SQL and CSS
 *     templates routinely END on a comment line. Including in this repo.
 *
 * What makes the SQL case tractable is the narrowness of `-- ` inside a
 * template. The general case needs to know the file does not compile, and by
 * then the build has already said so with a line number. The cost is a minute,
 * not a shipped bug — which is why this file still exists and the general one
 * does not.
 */

import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["apps/server/src", "packages/widget-core/src", "apps/dashboard/src"];
const findings = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx|mjs)$/.test(full)) check(full);
  }
}

function check(file) {
  const text = readFileSync(file, "utf8");
  // Every tagged/plain template literal in the file, with its start offset.
  // Backtick-delimited, allowing escaped backticks inside.
  const re = /`(?:[^`\\]|\\.)*`/gs;
  for (const m of text.matchAll(re)) {
    const body = m[0];
    if (!/^\s*--|--\s/m.test(body)) continue;
    for (const line of body.split("\n")) {
      const comment = /--[ \t](.*)$/.exec(line);
      // ``` rather than a literal, for the obvious reason.
      if (comment && comment[1].includes("`")) {
        const before = text.slice(0, m.index);
        const lineNo = before.split("\n").length + body.slice(0, body.indexOf(line)).split("\n").length - 1;
        findings.push({ file: relative(process.cwd(), file), line: lineNo, text: line.trim() });
      }
    }
  }
}

for (const root of ROOTS) {
  try {
    walk(root);
  } catch {
    // A tree that does not exist yet is not a failure — the dashboard was
    // absent for most of this project's life.
  }
}

if (findings.length) {
  console.error("\n✗ lint-sql-comments: a backtick inside a SQL comment ENDS the template literal.\n");
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.text.slice(0, 100)}`);
  }
  console.error("\n  Write the identifier without backticks there. It reads the same and it builds.\n");
  process.exit(1);
}
console.log(`✓ lint-sql-comments: no backticks inside SQL comments`);
