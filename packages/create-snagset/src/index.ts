#!/usr/bin/env node
import { relative } from "node:path";
import { packageName, scaffold } from "./scaffold.ts";

/**
 * The bin. Argument handling and exit codes only — everything that touches the
 * filesystem is in `scaffold.ts`, which has no side effects at import time and
 * is therefore testable.
 */
const target = process.argv[2];
if (!target || target.startsWith("-")) {
  process.stderr.write(
    "usage: create-snagset <directory>\n\n" +
      "  pnpm create snagset my-review\n" +
      "  pnpm create snagset .          (into the directory you are in)\n" +
      "  cd my-review && pnpm install && pnpm start\n",
  );
  process.exit(2);
}

let dir: string;
try {
  dir = scaffold(target);
} catch (e) {
  process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}

// No `cd .` when it was scaffolded where we stand.
const into = relative(process.cwd(), dir);
process.stdout.write(
  `\n  ✓ ${packageName(dir)}\n\n` +
    `  1. Put a Postgres URL in .env as DATABASE_URL.\n` +
    `     A free Supabase or Neon project works, so does a local install;\n` +
    `     .env says which Supabase string goes where.\n\n` +
    (into ? `  cd ${into}\n` : "") +
    `  pnpm install && pnpm start\n\n` +
    `  (npm, yarn and bun work the same way.)\n\n` +
    `  Then open http://localhost:8080 and create the first owner.\n` +
    `  An instance nobody has claimed shows a setup screen rather than a\n` +
    `  sign-in form, and the FIRST person to fill it in becomes the owner —\n` +
    `  so do that before you share the address.\n\n` +
    `  A signing key was generated into .env. Back it up — without it every\n` +
    `  session and stored credential is unrecoverable.\n\n`,
);
