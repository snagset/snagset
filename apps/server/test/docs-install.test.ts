import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every install snippet on the docs site must be one that WORKS.
 *
 * The quickstart shipped a tag with no `data-snag-site` and the sentence
 * "there are no required attributes". That tag runs in local demo mode:
 * the toolbar appears, comments are written, and nothing reaches the server.
 * A reader following the first page of the documentation would have concluded
 * the product was broken, and been right about what they saw.
 *
 * It survived because it was true once, when the widget was a demo and there
 * was no server to reach. Documentation does not fail loudly when the product
 * moves underneath it, so this is the thing that does.
 */

const DOCS = join(import.meta.dirname, "..", "..", "..", "docs");
const pages = readdirSync(DOCS).filter((f) => f.endsWith(".md"));

/** Every fenced `html` block containing a snag.js script tag. */
function installTags(page: string): string[] {
  const body = readFileSync(join(DOCS, page), "utf8");
  return [...body.matchAll(/```html\n([\s\S]*?)```/g)]
    .map((m) => m[1]!)
    .filter((block) => block.includes("snag.js"));
}

test("the quickstart's headline snippet is a WORKING install", () => {
  // Marked in the source so this reads the one a newcomer copies, not an
  // example further down the page about something else.
  const page = readFileSync(join(DOCS, "quickstart.md"), "utf8");
  const marked = /<!-- snagset:quickstart -->\n```html\n([\s\S]*?)```/.exec(page);
  assert.ok(marked, "the headline snippet is marked in the source");
  const tag = marked[1]!;
  assert.match(tag, /data-snag-site=/, "without this a comment belongs to no site");
  assert.match(tag, /\bdefer\b/, "must not block parsing of somebody else's page");
  assert.match(tag, /src="https?:\/\/[^"]+\/snag\.js"/, "the src is the instance");
});

test("no page tells a reader there are no required attributes", () => {
  for (const page of pages) {
    const body = readFileSync(join(DOCS, page), "utf8");
    assert.ok(
      !/no required attributes/i.test(body),
      `${page} says there are no required attributes — true in local demo mode, and ` +
        `misleading everywhere a reader is actually going`,
    );
  }
});

test("every install tag either identifies a site or is labelled demo mode", () => {
  const wrong: string[] = [];
  for (const page of pages) {
    for (const tag of installTags(page)) {
      if (tag.includes("data-snag-site")) continue;
      // A tag with no site is legitimate ONLY where the page says what it does.
      const body = readFileSync(join(DOCS, page), "utf8");
      if (!/local demo mode|demo mode/i.test(body)) wrong.push(`${page}: ${tag.trim()}`);
    }
  }
  assert.deepEqual(wrong, [], "these snippets connect to nothing and do not say so");
});
