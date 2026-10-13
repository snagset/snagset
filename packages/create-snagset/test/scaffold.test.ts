import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, packageName, RENAME } from "../src/scaffold.ts";

/**
 * What `npx create-snagset` actually writes.
 *
 * Every assertion here is about a file whose ABSENCE is silent. A scaffold with
 * no `.gitignore` produces a repository whose first `git add .` commits a `.env`
 * holding a database password; one with no `.env` makes the first run fail on a
 * variable the operator was never shown; one with no compose file makes the
 * README's first command a lie. None of those throw.
 */

function into(fn: (dir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "create-snagset-"));
  try {
    scaffold("my-review", root);
    fn(join(root, "my-review"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the underscored template names are written under their real ones", () => {
  into((dir) => {
    const written = readdirSync(dir).sort();
    // npm STRIPS `.gitignore` from a published tarball and rewrites a nested
    // `package.json`, which is why the template ships them prefixed. If that
    // renaming ever breaks, the scaffold is a directory of `_`-files.
    for (const name of [".gitignore", ".env", ".env.example", "package.json", "vercel.json", "README.md"]) {
      assert.ok(written.includes(name), `expected ${name}, got ${written.join(", ")}`);
    }
    for (const name of written) {
      assert.ok(!name.startsWith("_"), `${name} was not renamed`);
    }
    assert.deepEqual(Object.values(RENAME).filter((v) => v.includes("/")), ["api/index.js"]);
    assert.match(readFileSync(join(dir, "api", "index.js"), "utf8"), /@snagset\/server\/serverless/);
  });
});

test(".gitignore covers the two files that must never be committed", () => {
  into((dir) => {
    const ignored = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(ignored, /^\.env$/m, "holds the database password");
    assert.match(ignored, /^\.snagset\/$/m, "holds the signing key");
    assert.match(ignored, /^node_modules\/$/m);
  });
});

test(".gitignore keeps OS clutter and the Vercel binding out of the first commit", () => {
  into((dir) => {
    const ignored = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(ignored, /^\.DS_Store$/m, "macOS writes one into every folder Finder opens");
    assert.match(ignored, /^\.vercel$/m, "`vercel link` writes the project binding here");
  });
});

test(".env is written with a REAL signing key, not the commented placeholder", () => {
  into((dir) => {
    const env = readFileSync(join(dir, ".env"), "utf8");
    const key = /^SNAGSET_SECRET_KEY=(.+)$/m.exec(env)?.[1] ?? "";
    // 32 bytes base64url. Generated here rather than on first boot because
    // the generate-to-disk is bin-only — an operator who scaffolds locally
    // and deploys to a platform would otherwise find out on the far side.
    assert.equal(key.length, 43, `expected 43 base64url chars, got ${JSON.stringify(key)}`);
    assert.match(key, /^[\w-]+$/);
    assert.match(env, /^DATABASE_URL=/m, "the one required variable, already spelled");

    // …and the example keeps the placeholder, so it stays copy-pasteable.
    assert.match(readFileSync(join(dir, ".env.example"), "utf8"), /# SNAGSET_SECRET_KEY=/);
  });
});

test("two scaffolds do not share a signing key", () => {
  const keys = new Set<string>();
  for (let i = 0; i < 2; i++) {
    into((dir) => {
      keys.add(/^SNAGSET_SECRET_KEY=(.+)$/m.exec(readFileSync(join(dir, ".env"), "utf8"))![1]!);
    });
  }
  assert.equal(keys.size, 2);
});

test("package.json is named after the directory and pins the server version", () => {
  into((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name: string;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, "my-review");
    // EXACT, not a caret: `create-snagset@1.4.2` must produce a repo on the
    // server version this template was run against.
    const pinned = pkg.dependencies["@snagset/server"]!;
    assert.doesNotMatch(pinned, /[\^~]/, `"${pinned}" is a range, not a pin`);
    assert.ok(!("snagset" in pkg.dependencies), "the AGPL server is @snagset/server; `snagset` is the MIT widget");
    for (const script of ["start", "migrate", "env"]) {
      assert.ok(script in pkg.scripts, `npm run ${script}`);
    }
  });
});

test("NO Docker artifact is scaffolded — LOCK, and it shipped one anyway", () => {
  // "Not use docker at all" — the maintainer, 2026-08-06, quoted verbatim in LOCK
  // which also deletes the Dockerfile rather than merely undocumenting
  // it. LOCK the design lists "Docker Compose as the primary/blessed path" as dead
  // vocabulary that must not survive in normative text.
  //
  // It survived anyway: the template shipped a `compose.yml` with a Postgres
  // service, the scaffolded README's FIRST command was `docker compose up`,
  // and both went out in create-snagset 0.0.1 and 0.0.2. Nothing caught it
  // because the tests asserted the compose file was present and correct —
  // they encoded the thing the lock forbids. Found by installing the
  // published package as a stranger would.
  into((dir) => {
    for (const name of ["compose.yml", "compose.dev.yml", "docker-compose.yml", "Dockerfile", ".dockerignore"]) {
      assert.ok(!existsSync(join(dir, name)), `${name} must not be scaffolded (LOCK)`);
    }
    // The word may appear — the README says "no Docker, on purpose", which is
    // the point. What must not appear is an INSTRUCTION to use it.
    for (const f of ["README.md", ".env", ".env.example"]) {
      const text = readFileSync(join(dir, f), "utf8");
      assert.ok(!/docker\s+compose|docker\s+run|docker\s+build/i.test(text), `${f} tells you to run docker`);
    }
  });
});

test("the README's first command is one the scaffold can actually run", () => {
  into((dir) => {
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    assert.match(readme, /pnpm install/, "the install step, in the default package manager");
    assert.match(readme, /pnpm start/, "and the run step");
    assert.match(readme, /DATABASE_URL/, "and it says what you have to bring");
    assert.ok(!readme.includes("__NAME__"), "placeholders were substituted");
    assert.match(readme, /my-review/, "and with the real name");
  });
});

test("a non-empty directory is refused, never merged into", () => {
  const root = mkdtempSync(join(tmpdir(), "create-snagset-"));
  try {
    scaffold("taken", root);
    writeFileSync(join(root, "taken", ".env"), "DATABASE_URL=do-not-lose-me");
    // Merging is how a scaffolder overwrites somebody's .env, and there is no
    // undo for that.
    assert.throws(() => scaffold("taken", root), /already exists and is not empty/);
    assert.match(readFileSync(join(root, "taken", ".env"), "utf8"), /do-not-lose-me/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`.` scaffolds into the directory you are in, named after it", () => {
  const root = mkdtempSync(join(tmpdir(), "create-snagset-"));
  try {
    const here = join(root, "Client Review");
    // `git init` and Finder get there first; neither may block a scaffold.
    mkdirSync(join(here, ".git"), { recursive: true });
    writeFileSync(join(here, ".DS_Store"), "");
    assert.equal(scaffold(".", here), here);
    const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
    assert.equal(pkg.name, "client-review", "not `.`, and not a name npm refuses");
    assert.ok(existsSync(join(here, ".env")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`.` still refuses a directory holding something it would overwrite", () => {
  const root = mkdtempSync(join(tmpdir(), "create-snagset-"));
  try {
    writeFileSync(join(root, "README.md"), "mine");
    assert.throws(() => scaffold(".", root), /not empty \(README\.md\)/);
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), "mine");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package name is the directory's, made one npm accepts", () => {
  assert.equal(packageName("/a/my-review"), "my-review");
  assert.equal(packageName("/a/Client Review"), "client-review");
  assert.equal(packageName("/a/.hidden"), "hidden");
  assert.equal(packageName("/"), "snagset");
});
