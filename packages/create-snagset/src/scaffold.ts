import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

/**
 * `npx create-snagset` — the self-host, the `create-next-app` model.
 *
 * ── WHY A SCAFFOLDER AND NOT `git clone` ──
 *
 * FasterFixes ships `git clone` + `pnpm install` + a build, and it is the
 * weakest part of their docs: it makes the operator your build engineer. They
 * own the Node version, the lockfile and the build step, and every upgrade is
 * a pull, a reinstall and a rebuild against a tree that has moved underneath
 * them. Sixteen environment variables and four mandatory external services
 * before the first run.
 *
 * What this writes instead is a small repository the operator OWNS — their
 * `.env`, their compose file, their deploy config — that depends on
 * `@snagset/server` like any other package. Upgrading is `npm update`. There
 * is no build. Our source is not in their tree unless they want it, and when
 * they do, it is AGPL and the repository is public.
 *
 * ── WHY NOT `npm install @snagset/server` INTO A DIRECTORY THEY INVENTED ──
 *
 * Because the interesting files are not the dependency. A working self-host is
 * a compose file with Postgres in it, a `.env` with the one required variable
 * already spelled, a Vercel config, a serverless entry point, and a README
 * that says which of those matter. `npm install` gives you a `node_modules`
 * and a blank page; measured on a cold room, the install is 5 seconds and the
 * remaining friction is entirely "what do I write, and where".
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `dist/template` beside the compiled entry (see scripts/copy-template.mjs),
 * falling back to `../template` so the package runs from source in this repo.
 *
 * The fallback is the honest version of "it works on my machine": without it
 * every local run and every test would read a directory that only exists after
 * a build, and the first person to try `node src/index.ts` would get an empty
 * scaffold with no error.
 */
const TEMPLATE = existsSync(join(HERE, "template"))
  ? join(HERE, "template")
  : join(HERE, "..", "template");

/**
 * `_package.json` on disk, `package.json` when written.
 *
 * npm STRIPS a `.gitignore` from a published tarball and rewrites a nested
 * `package.json`, which is why these two ship under other names. The `_`
 * prefix is the convention `create-next-app` and `create-vite` both use, for
 * exactly this reason, and a template that ships without its `.gitignore`
 * produces a scaffold whose first `git add .` commits `node_modules` and a
 * `.env` holding a database password.
 */
export const RENAME: Record<string, string> = {
  "_package.json": "package.json",
  _gitignore: ".gitignore",
  "_env.example": ".env.example",
  "api_index.js": "api/index.js",
};

/**
 * Scaffold into `dir`. Pure enough to test: it takes and returns paths, throws
 * a sentence rather than calling `process.exit`, and writes nothing outside
 * the directory it was given.
 *
 * Split from the bin for one specific reason — the first version guarded
 * `main()` with `if (/create-snagset/.test(process.argv[1]))` so a test could
 * import it, and the test file's own path contains `create-snagset`, so
 * importing it would have scaffolded into the test runner's working directory.
 * A module with side effects at import time cannot be tested; the fix is not a
 * cleverer guard.
 */
/**
 * What may already be in the directory. `create-snagset .` runs in a folder
 * somebody made first, and by then it usually holds a `.git` from `git init`
 * or a `.DS_Store` from Finder — refusing those would make `.` useless. None of
 * these is a file the template writes, so nothing here can be overwritten.
 * The list `create-next-app` keeps, minus the files we would write over.
 */
export const HARMLESS = new Set([".git", ".DS_Store", "Thumbs.db", ".idea", ".vscode", "LICENSE"]);

/**
 * The directory's own name, made a valid npm package name. `.` has to resolve
 * first — `create-snagset .` once meant `"name": "."` — and a folder is often
 * called something npm refuses, like `Client Review`.
 */
export function packageName(dir: string): string {
  return (
    basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[._-]+|-+$/g, "") || "snagset"
  );
}

export function scaffold(target: string, cwd = process.cwd()): string {
  const dir = resolve(cwd, target);
  // A non-empty directory is refused rather than merged into. Merging is how a
  // scaffolder overwrites somebody's `.env`, and there is no undo for that.
  const clutter = existsSync(dir) ? readdirSync(dir).filter((f) => !HARMLESS.has(f)) : [];
  if (clutter.length > 0) {
    throw new Error(
      `${target} already exists and is not empty (${clutter.slice(0, 3).join(", ")}${clutter.length > 3 ? ", …" : ""}).`,
    );
  }
  mkdirSync(join(dir, "api"), { recursive: true });

  const name = packageName(dir);
  // Pinned to THIS scaffolder's version, so `create-snagset@1.4.2` produces a
  // repo on `@snagset/server@1.4.2`. A caret here would let a fresh scaffold
  // resolve to a server this template has never been run against.
  const version = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version as string;

  for (const entry of readdirSync(TEMPLATE)) {
    const out = RENAME[entry] ?? entry;
    const body = readFileSync(join(TEMPLATE, entry), "utf8")
      .replaceAll("__NAME__", name)
      .replaceAll("__VERSION__", version);
    writeFileSync(join(dir, out), body);
  }

  /**
   * `.env` is written, not just `.env.example`, and with a REAL signing key.
   *
   * The alternative — ship an example and tell them to copy it — adds a step
   * between the scaffold and the first run, which is the step where an install
   * stalls. And generating the key here rather than letting the server do it
   * on first boot matters for the deploy case: The generate-to-disk is
   * bin-only, so an operator who scaffolds locally and deploys to a platform
   * would otherwise discover on the far side that they had no key to set.
   */
  const env = readFileSync(join(dir, ".env.example"), "utf8").replace(
    "# SNAGSET_SECRET_KEY=",
    `SNAGSET_SECRET_KEY=${randomBytes(32).toString("base64url")}`,
  );
  // Nothing to quote here yet — the placeholder URL has no `&`. The QUOTED
  // form is in the example itself, because a real connection string usually
  // does: `?sslmode=require&channel_binding=require` ends a shell command at
  // the `&` and runs the rest in the background, so `. .env` breaks on exactly
  // the URL a Neon or Supabase branch hands you. Reported from a deploy trial,
  // 2026-09-01.
  writeFileSync(join(dir, ".env"), env);

  return dir;
}
