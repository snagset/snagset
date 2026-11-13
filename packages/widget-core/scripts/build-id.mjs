/**
 * The build's own name — the `?cv=`, made to mean something.
 *
 * ── THE BUG THIS EXISTS FOR ──
 *
 * `cv` was the literal `"0.0.0"` in three files, so the cache-buster on every
 * chunk URL was the same string in every release. The version path was
 * correct, the alias was correct, and a reviewer still ran last week's
 * widget: `snag.runtime.js?cv=0.0.0` was the URL before the deploy and the
 * URL after it, so the browser's copy — and the edge's — was still fresh.
 *
 * ── WHAT IT IS NOW ──
 *
 * `<release version>+<content hash>`, one value for the whole build, written
 * into the stub, the runtime and the chunk loader. SemVer build metadata, so
 * `Snagset.version` is still a semver and still compares as the release; the
 * hash is what changes whenever any byte of any artefact does.
 *
 * ONE hash for the build, not one per chunk, and that is a budget decision:
 * per-chunk hashes would put eight of them in the eager runtime (it names
 * every lazy chunk), against an activation total with 21 bytes spare. A
 * release that touches one chunk re-downloads all of them once; releases are
 * rare and reviewers are few, and the total-activation row is not negotiable.
 *
 * ── HOW, WITHOUT A CIRCLE ──
 *
 * The hash must cover the bytes, and the bytes contain the hash. So the Vite
 * passes compile in a placeholder of exactly the hash's length (`SLOT`), this
 * script hashes the artefacts AS BUILT — placeholder and all — and then writes
 * the real value over the placeholder. Same length, so every source-map column
 * stays where it was and `tools/module-map.mjs` keeps attributing bytes
 * correctly. Deterministic: the same sources build the same id.
 *
 * It also writes `dist/build.json`, which is how the SERVER knows which `cv`
 * is current (apps/server/src/routes/widget.ts): only a request carrying this
 * build's id is cached immutable. Anything else is served `no-store`, so an old
 * id can never be pinned to new bytes, at the edge or in a browser.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/**
 * Hex digits of sha256 kept. Six, because the release version is part of the
 * id too: the hash only has to tell apart two BUILDS OF ONE VERSION, where a
 * 24-bit collision is a one-in-sixteen-million event. Every digit is a gzipped
 * byte in the stub and another in the runtime, against an activation total
 * that had 21 bytes spare — 8 digits cost 16 of them, 6 cost 13.
 */
export const HASH_LENGTH = 6;

/** The placeholder the Vite passes compile in. Exactly HASH_LENGTH characters,
 *  and not hex, so an unstamped build can never look like a stamped one. */
export const SLOT = "~".repeat(HASH_LENGTH);

/**
 * The release version — the server's, because the widget ships INSIDE the
 * server package and `/healthz` reports that number. widget-core's
 * own package.json is private and stays at 0.0.0.
 */
export function releaseVersion() {
  return JSON.parse(readFileSync(join(REPO, "apps", "server", "package.json"), "utf8")).version;
}

/** What the Vite passes compile in, before stamping. */
export const placeholder = (version = releaseVersion()) => `${version}+${SLOT}`;

/**
 * Hash `dir`'s artefacts and write the id over the placeholder in every one.
 * Exported for the unit test, which stamps two temp directories.
 */
export function stamp(dir, version = releaseVersion()) {
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".js") || f.endsWith(".js.map"))
    .sort();
  const js = names.filter((f) => f.endsWith(".js"));
  const from = placeholder(version);

  const h = createHash("sha256");
  let carriers = 0;
  for (const name of js) {
    const body = readFileSync(join(dir, name));
    // Name AND length AND bytes, so a rename or a split is a different build.
    h.update(`${name}\0${body.length}\0`).update(body);
    if (body.includes(from)) carriers++;
  }
  if (!carriers) {
    throw new Error(
      `no artefact in ${dir} carries ${JSON.stringify(from)} — the stub was built without ` +
        "the build-id plugin (vite.config.ts), or was already stamped; rebuild with `pnpm build:widget`",
    );
  }
  const cv = `${version}+${h.digest("hex").slice(0, HASH_LENGTH)}`;

  for (const name of names) {
    const file = join(dir, name);
    const text = readFileSync(file, "utf8");
    if (text.includes(from)) writeFileSync(file, text.split(from).join(cv));
  }
  for (const name of js) {
    if (readFileSync(join(dir, name), "utf8").includes(SLOT)) {
      throw new Error(`${name} still carries the build-id placeholder after stamping`);
    }
  }
  writeFileSync(join(dir, "build.json"), `${JSON.stringify({ version, cv }, null, 2)}\n`);
  return cv;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(HERE, "..", "dist");
  console.log(`✓ widget build id ${stamp(dir)}`);
}
