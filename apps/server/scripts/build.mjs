#!/usr/bin/env node
/**
 * Build the publishable package — /.
 *
 * The npm tarball has to contain four things the repo keeps in four places:
 * compiled server JS, the migrations, the dashboard statics, and the widget
 * chunks. Three of them are not TypeScript, so `tsc` alone produces a package
 * that installs and then fails at runtime.
 *
 * ── WHY THE PACKAGE SHIPS JAVASCRIPT ──
 *
 * `bin` pointed at `src/bin.ts`, which works only where Node strips types by
 * default — 23.6 and later. The engines field says `>=22`, so on Node 22 the
 * published binary would not start.
 *
 * Raising the floor was the cheaper fix and is the wrong one, because of
 * WINDOWS: npm's `.cmd` shim ignores the shebang and runs `node <file>`, so a
 * `.ts` bin fails there on any Node without default stripping, and no shebang
 * trick reaches it. Shipping JS also removes the per-start strip cost from
 * `npx snagset`, which is the first thing anybody times.
 *
 * So: `tsc` emits with `rewriteRelativeImportExtensions`, which turns the
 * repo's `./db/connect.ts` specifiers into `./db/connect.js` on the way out.
 * The source keeps its extensions and Node keeps running it directly in dev.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..");
const REPO = join(SERVER, "..", "..");
const DIST = join(SERVER, "dist");

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

rmSync(DIST, { recursive: true, force: true });

// 1. The server itself.
run("npx", ["tsc", "-p", "tsconfig.build.json"], SERVER);

/**
 * 1b. THE WORKSPACE PACKAGES, compiled in beside the server.
 *
 * ── THE BUG THIS EXISTS FOR ──
 *
 * `dist/bin.js` carried `import { ID_PREFIX } from "@snagset/types/names"` and
 * the package declares no such dependency — `@snagset/types`, `@snagset/widget`
 * and `@snagset/adapters` are all `private: true` workspace packages that
 * export TypeScript source and are never published. Inside this repo the import
 * resolves through pnpm's symlink, so `node dist/bin.js` runs and every local
 * check passes. On a real `npm install snagset` it is `ERR_MODULE_NOT_FOUND`
 * before the first line of the program.
 *
 * Which is the same shape as the `/widget/*` bug three commits ago: verified in
 * the one environment that hides the failure. Found by packing the tarball and
 * installing it into an empty directory, which is now what proves this step —
 * `test/package.test.ts` refuses to let a bare `@snagset/` specifier survive
 * into `dist`.
 *
 * ── WHY VENDOR RATHER THAN PUBLISH THEM ──
 *
 * Publishing four packages to install one is four version numbers to keep in
 * step and four chances for a user to end up on a mismatched pair. These three
 * are OURS, tiny, and have no dependencies of their own: `names` is generated
 * constants, `redact/predicates` is pure functions, `adapters` is the outbound
 * sanitiser. Compiling them in keeps the tarball self-contained, which is what
 * `npx snagset` promises.
 */
const VENDOR = [
  { spec: "@snagset/types/names", dir: "types", src: "packages/types/src", entry: "names.js" },
  // The brief formatter the dashboard, the MCP server and this package share.
  { spec: "@snagset/types/brief", dir: "types", src: "packages/types/src", entry: "brief.js" },
  { spec: "@snagset/adapters", dir: "adapters", src: "packages/adapters/src", entry: "index.js" },
  // The MCP server's view imports the sanitiser and the fence by subpath.
  // Same sources, same vendored directory, two more specifiers to rewrite.
  { spec: "@snagset/adapters/outbound/sanitise", dir: "adapters", src: "packages/adapters/src", entry: "outbound/sanitise.js" },
  { spec: "@snagset/adapters/outbound/fence", dir: "adapters", src: "packages/adapters/src", entry: "outbound/fence.js" },
  {
    spec: "@snagset/widget/redact",
    dir: "widget",
    src: "packages/widget-core/src/redact",
    entry: "predicates.js",
  },
  // The MCP server itself, for the HTTP transport at POST /mcp. Its own
  // dependencies (the SDK, zod) are the server's runtime dependencies.
  { spec: "@snagset/mcp", dir: "mcp", src: "packages/mcp/src", entry: "server.js" },
];

// One compile per vendored DIRECTORY: several specifiers can point into the
// same sources, and compiling them once per specifier is the same output
// three times over.
const compiled = new Set();
for (const v of VENDOR) {
  const out = join(DIST, "vendor", v.dir);
  if (compiled.has(v.dir)) {
    if (!existsSync(join(out, v.entry))) throw new Error(`vendoring ${v.spec} produced no ${v.entry} in ${out}`);
    continue;
  }
  compiled.add(v.dir);
  // `execFileSync` does not run a shell, so a `*.ts` argument reaches tsc as a
  // literal path and it reports the star as a missing file. Expanded here, and
  // recursively, because `adapters` keeps its sanitiser in `src/outbound/`.
  const sources = readdirSync(join(REPO, v.src), { recursive: true })
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
      // Types are checked by each package's own `typecheck` script. Here the
      // job is emit: a type error in a package that already type-checks would
      // stop the build for no new information.
      "--noCheck",
    ],
    REPO,
  );
  if (!existsSync(join(out, v.entry))) {
    throw new Error(`vendoring ${v.spec} produced no ${v.entry} in ${out}`);
  }
}

/**
 * Rewrite every bare `@snagset/…` specifier to the vendored file, relative to
 * the importing file.
 *
 * Applied to the vendor output too, because these packages import each other:
 * `adapters` and `redact/predicates` both read `@snagset/types/names`.
 */
const jsFiles = (dir) =>
  readdirSync(dir, { recursive: true })
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

// A bare specifier that survived is a package that installs and then does not
// start. Fail the BUILD rather than let it reach a tarball.
for (const file of jsFiles(DIST)) {
  const left = readFileSync(file, "utf8").match(/from ["']@snagset\/[^"']+["']/g);
  if (left) {
    throw new Error(
      `${relative(DIST, file)} still imports ${left.join(", ")} — add it to VENDOR in this script. ` +
        `A workspace specifier in dist resolves in this repo and nowhere else.`,
    );
  }
}

/**
 * 2. The migrations, which are `.sql` and therefore invisible to tsc.
 *
 * `migrate.ts` reads them from a directory beside itself, so they have to land
 * beside the COMPILED file. Missing, the package installs cleanly, boots
 * cleanly, applies zero migrations and then fails on the first query against a
 * table that was never created — which is a worse failure than not starting.
 */
const migrations = join(SERVER, "src", "db", "migrations");
const migrationsOut = join(DIST, "db", "migrations");
mkdirSync(migrationsOut, { recursive: true });
const sql = readdirSync(migrations).filter((f) => f.endsWith(".sql"));
if (!sql.length) throw new Error("no .sql migrations found — the package would ship an empty schema");
for (const file of sql) cpSync(join(migrations, file), join(migrationsOut, file));

/**
 * 3. The widget chunks, served from our own origin.
 *
 * Copied rather than referenced: the published package cannot reach into a
 * sibling workspace. Source maps are deliberately EXCLUDED — they are a
 * meaningful fraction of the tarball and they publish our source to every
 * client site that loads the widget.
 */
const widgetSrc = join(REPO, "packages", "widget-core", "dist");
const widgetOut = join(SERVER, "static", "widget");
rmSync(widgetOut, { recursive: true, force: true });
mkdirSync(widgetOut, { recursive: true });
if (!existsSync(widgetSrc)) {
  throw new Error(`no widget build at ${widgetSrc} — run \`pnpm build:widget\` first`);
}
const chunks = readdirSync(widgetSrc).filter((f) => f.endsWith(".js"));
if (!chunks.some((f) => f === "snag.js")) {
  throw new Error("the widget build has no snag.js — the stub is the one file every install loads");
}
for (const file of chunks) cpSync(join(widgetSrc, file), join(widgetOut, file));

// 4. The dashboard, built into `static/dashboard` by its own Vite build.
const dashboard = join(SERVER, "static", "dashboard");
if (!existsSync(join(dashboard, "index.html"))) {
  throw new Error(`no dashboard at ${dashboard} — run \`pnpm --filter @snagset/dashboard build\` first`);
}

const count = (dir) =>
  readdirSync(dir, { recursive: true }).filter((f) => statSync(join(dir, f)).isFile()).length;

console.log(
  `✓ package: ${count(DIST)} file(s) · ${VENDOR.length} vendored package(s), ` +
    `${rewrites} rewritten import(s) · ${sql.length} migration(s) · ` +
    `${chunks.length} widget chunk(s) · dashboard present`,
);
