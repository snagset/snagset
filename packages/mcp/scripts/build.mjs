#!/usr/bin/env node
/**
 * Build `@snagset/mcp` — the same two problems the server's build script
 * solves, for the same reasons, and one of them was found the hard way.
 *
 *  1. **The package ships JavaScript**. `bin` cannot be a `.ts` file:
 *     npm's Windows `.cmd` shim runs `node <file>` and ignores the shebang, so
 *     a TypeScript bin fails there on any Node without default type stripping.
 *  2. **No workspace specifier may survive into `dist`.** `@snagset/adapters`
 *     and `@snagset/types` are `private: true` and export TypeScript source.
 *     Inside this repo pnpm's symlink resolves them and everything runs; on a
 *     real `npx @snagset/mcp` it is ERR_MODULE_NOT_FOUND before the first line.
 *     That exact bug shipped in `snagset` — see `apps/server/scripts/build.mjs`.
 *
 * The sanitiser is vendored rather than reimplemented. The design requires the MCP
 * server to use *"the same sanitiser, the same clamps and the same fixture
 * corpus as every provider"*; a copy here would be a second implementation of
 * the one thing exists to prevent.
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

const VENDOR = [
  { spec: "@snagset/types/names", dir: "types", src: "packages/types/src", entry: "names.js" },
  // The brief formatter the dashboard, the server and this package share.
  { spec: "@snagset/types/brief", dir: "types", src: "packages/types/src", entry: "brief.js" },
  {
    spec: "@snagset/adapters/outbound/sanitise",
    dir: "adapters",
    src: "packages/adapters/src",
    entry: "outbound/sanitise.js",
  },
  {
    spec: "@snagset/adapters/outbound/fence",
    dir: "adapters",
    src: "packages/adapters/src",
    entry: "outbound/fence.js",
  },
];

// Compiled once per DIRECTORY, not once per specifier — `adapters` appears
// twice above because two of its subpath exports are imported, and running tsc
// over the same sources twice would emit the same files twice.
for (const dir of [...new Set(VENDOR.map((v) => v.dir))]) {
  const v = VENDOR.find((x) => x.dir === dir);
  const out = join(DIST, "vendor", dir);
  const sources = readdirSync(join(REPO, v.src), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => join(REPO, v.src, f));
  if (!sources.length) throw new Error(`no .ts sources under ${v.src}`);
  run(
    "npx",
    [
      "tsc",
      ...sources,
      "--outDir", out,
      "--rootDir", join(REPO, v.src),
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--rewriteRelativeImportExtensions",
      "--skipLibCheck",
      "--noCheck",
    ],
    REPO,
  );
}

const jsFiles = (dir) =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(dir, f));

let rewrites = 0;
for (const file of jsFiles(DIST)) {
  let text = readFileSync(file, "utf8");
  const before = text;
  for (const v of VENDOR) {
    if (!text.includes(v.spec)) continue;
    let rel = relative(dirname(file), join(DIST, "vendor", v.dir, v.entry));
    if (!rel.startsWith(".")) rel = `./${rel}`;
    text = text.split(`"${v.spec}"`).join(`"${rel}"`).split(`'${v.spec}'`).join(`'${rel}'`);
  }
  if (text !== before) {
    writeFileSync(file, text);
    rewrites++;
  }
}

for (const file of jsFiles(DIST)) {
  const left = readFileSync(file, "utf8").match(/from ["']@snagset\/[^"']+["']/g);
  if (left) {
    throw new Error(
      `${relative(DIST, file)} still imports ${left.join(", ")} — add it to VENDOR. ` +
        `A workspace specifier resolves in this repo and nowhere else.`,
    );
  }
}

if (!existsSync(join(DIST, "bin.js"))) throw new Error("no dist/bin.js — the package has no entry point");

// stdout is the JSON-RPC channel. A stray `console.log` anywhere in this
// package corrupts the stream and the client reports a parse error with no clue
// where it came from — the single most common way an MCP server that passes its
// own tests fails in a real client. Caught at build, since the only safe place
// to write is `process.stderr`.
for (const file of jsFiles(DIST)) {
  if (file.includes(`${"vendor"}/`)) continue;
  // COMMENTS STRIPPED FIRST. The check fired on `bin.ts`'s own doc block, which
  // explains this rule and therefore contains the word it scans for — a lint
  // that cannot survive being documented. Crude (a `//` inside a string
  // literal takes the rest of that line with it), which costs a false negative
  // at worst and never a false positive.
  const text = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  if (/\bconsole\.(log|info|debug|warn)\b/.test(text) || /process\.stdout\.write/.test(text)) {
    throw new Error(
      `${relative(DIST, file)} writes to stdout. stdout IS the protocol channel for a stdio MCP ` +
        `server — use process.stderr.write.`,
    );
  }
}

console.log(`✓ @snagset/mcp: ${jsFiles(DIST).length} file(s) · ${rewrites} rewritten import(s)`);
