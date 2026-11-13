#!/usr/bin/env node
/**
 * Build `snagset` — the MIT widget package.
 *
 * Same two rules as the other publishable packages: ship JavaScript, and let no
 * workspace specifier survive into `dist` (`@snagset/types` is private and
 * exports TypeScript source, so a bare import resolves in this repo and nowhere
 * else — the bug that shipped in the server tarball).
 *
 * One rule this package has that the others do not: **nothing AGPL may end up
 * here.** the licence split used to be a table, the decision made it a lint, and
 * the decision made it a fact about distribution — the server is not an npm package a
 * client site can install. This build is where that stops being a promise: a
 * `@snagset/server` import, or anything reaching into `apps/`, fails it.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const REPO = join(PKG, "..", "..");
const DIST = join(PKG, "dist");

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

rmSync(DIST, { recursive: true, force: true });
run("npx", ["tsc", "-p", "tsconfig.build.json"], PKG);

// `@snagset/types/names` is the ONLY workspace import, and only for the
// attribute-name mapping — which is exactly the thing that must not be
// hand-copied into a second place.
const VENDOR = [{ spec: "@snagset/types/names", dir: "types", src: "packages/types/src", entry: "names.js" }];

for (const v of VENDOR) {
  const out = join(DIST, "vendor", v.dir);
  const sources = readdirSync(join(REPO, v.src), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => join(REPO, v.src, f));
  run(
    "npx",
    ["tsc", ...sources, "--outDir", out, "--rootDir", join(REPO, v.src),
     "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler",
     "--declaration", "--rewriteRelativeImportExtensions", "--skipLibCheck", "--noCheck"],
    REPO,
  );
  if (!existsSync(join(out, v.entry))) throw new Error(`vendoring ${v.spec} produced no ${v.entry}`);
}

const files = (ext) =>
  readdirSync(DIST, { recursive: true }).map(String).filter((f) => f.endsWith(ext)).map((f) => join(DIST, f));

let rewrites = 0;
// `.d.ts` too, not only `.js` — a bare specifier left in a declaration file is
// a red squiggle in the consumer's editor rather than a runtime failure, which
// is quieter and therefore worse.
for (const file of [...files(".js"), ...files(".d.ts")]) {
  let text = readFileSync(file, "utf8");
  const before = text;
  for (const v of VENDOR) {
    if (!text.includes(v.spec)) continue;
    let rel = relative(dirname(file), join(DIST, "vendor", v.dir, v.entry));
    if (!rel.startsWith(".")) rel = `./${rel}`;
    const target = file.endsWith(".d.ts") ? rel.replace(/\.js$/, "") : rel;
    text = text.split(`"${v.spec}"`).join(`"${target}"`).split(`'${v.spec}'`).join(`'${target}'`);
  }
  if (text !== before) {
    writeFileSync(file, text);
    rewrites++;
  }
}

for (const file of [...files(".js"), ...files(".d.ts")]) {
  const text = readFileSync(file, "utf8");
  const left = text.match(/from ["']@snagset\/[^"']+["']/g);
  if (left) throw new Error(`${relative(DIST, file)} still imports ${left.join(", ")} — add it to VENDOR.`);
  // The licence boundary, as a build-time assertion.
  if (/@snagset\/server|apps\/server|["']hono["']|["']postgres["']/.test(text)) {
    throw new Error(
      `${relative(DIST, file)} reaches into the AGPL server. This package is MIT and is installed ` +
        `into other people's frontends; nothing from apps/server may enter it.`,
    );
  }
}

for (const entry of ["index.js", "react.js", "vue.js", "astro.js", "next.js", "vite.js"]) {
  if (!existsSync(join(DIST, entry))) throw new Error(`package.json exports ${entry} and the build produced none`);
}

console.log(`✓ snagset: ${files(".js").length} js · ${files(".d.ts").length} d.ts · ${rewrites} rewritten import(s)`);
