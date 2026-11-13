#!/usr/bin/env node
/**
 * The template is DATA, not TypeScript, so tsc does not see it — the same
 * reason the server's build copies its `.sql` migrations by hand. A tarball
 * without it installs cleanly and then scaffolds an empty directory.
 */
import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(PKG, "template");
const files = readdirSync(src);
if (!files.length) throw new Error("the template directory is empty — the scaffold would produce nothing");

// Copied INTO `dist/template`, because `files: ["dist"]` is what ships and a
// sibling `template/` would need its own entry there — the kind of thing that
// is forgotten exactly once, on the publish that matters.
const out = join(PKG, "dist", "template");
cpSync(src, out, { recursive: true });
for (const required of ["_package.json", "_gitignore", "_env.example", "vercel.json"]) {
  if (!existsSync(join(out, required))) throw new Error(`the template shipped without ${required}`);
}
console.log(`✓ create-snagset: ${files.length} template file(s)`);
