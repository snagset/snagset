import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, lstatSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

/**
 * Anchor → source mapping, *"the reason this server is worth
 * building"*, and the one place this package touches a filesystem.
 *
 * Three strategies descending in confidence. R1 (build plugin,
 * `data-snag-src`) and R2 (React DevTools fibre) both read the LIVE PAGE, which
 * this process does not have — they belong to the widget, and does that
 * reading. What is implementable here is **R3, the local heuristic search**,
 * plus passing through an R1 attribute when the anchor already carries one.
 *
 * ── WHY STDIO IS THE SUPPORTED TRANSPORT ──
 *
 * This function is the answer. The whole value is turning an anchor into
 * `src/components/ProductCard.tsx:42`, and the repository is on the developer's
 * machine, not on ours. That is also why `source:map` cannot exist on the HTTP
 * transport at all — the design requires that to be *"a configuration error surfaced
 * at token creation, not a silent empty result"*.
 *
 * ── THE CONSTRAINTS ARE NORMATIVE ──
 *
 * The design states them as rules rather than suggestions, because this is the only
 * code in the package that reads files an injected instruction might want:
 *
 *   · **Path-confined to the resolved repo root.** Every candidate is resolved
 *     and must remain a descendant. Symlinks are NOT followed. `..` never
 *     escapes. *"A traversal attempt is an error, not a filtered result."*
 *   · Skips `.git`, `node_modules`, `dist`, `build`.
 *   · At most 20 candidates, each `{ file, line, snippet, confidence,
 *     strategy }` where `snippet` is **the matched line only** — never
 *     surrounding file contents.
 *
 * That last clause is the one worth restating: this is a search tool, not a
 * file-read tool. The design says there is no file-write tool and no
 * arbitrary-fetch tool; returning the six lines around a match would quietly
 * make this the file-READ tool nobody agreed to.
 */

const exec = promisify(execFile);

export interface SourceCandidate {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly confidence: number;
  readonly strategy: string;
}

/** At most 20 *(calibration)*. */
export const MAX_CANDIDATES = 20;

const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage", "out"]);
const EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".astro", ".html", ".php", ".erb"]);

/**
 * Confidence per strategy, descending — the *"ranked by strategy strength"*.
 *
 * All at or below 0.4, which is R3's ceiling. A `data-testid` is nearly unique
 * in a codebase; an accessible name often appears in a translation file and a
 * component both; a text match is the weakest and is capped hardest. Presenting
 * any of these as certain is the failure mode — an agent that edits the wrong
 * file confidently is worse than one that asks.
 */
const STRATEGY: readonly { key: string; confidence: number }[] = [
  { key: "testId", confidence: 0.4 },
  { key: "accessibleName", confidence: 0.3 },
  { key: "text", confidence: 0.2 },
];

export interface MapOptions {
  readonly repoRoot: string;
  /** The anchor's own strings, from the thread. */
  readonly anchor: { testId?: string; accessibleName?: string; text?: string; sourceRef?: unknown };
  /** Overridden in tests. */
  readonly ripgrep?: boolean;
}

export async function mapToSource(opts: MapOptions): Promise<SourceCandidate[]> {
  const root = resolve(opts.repoRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`${opts.repoRoot} is not a directory. Pass repoRoot, or run the MCP server from your checkout.`);
  }

  // R1 passthrough: `data-snag-src="src/components/ProductCard.tsx:42:7"`, if
  // the host runs one of the build plugins and already resolved it.
  // Confidence 1.0, and it short-circuits — there is nothing to search for.
  const r1 = fromSourceRef(opts.anchor.sourceRef, root);
  if (r1) return [r1];

  const found: SourceCandidate[] = [];
  const seen = new Set<string>();
  for (const s of STRATEGY) {
    const needle = (opts.anchor as Record<string, string | undefined>)[s.key];
    if (!needle || needle.trim().length < 3) continue;
    const hits = await search(root, needle.trim(), opts.ripgrep !== false);
    for (const hit of hits) {
      const dedupe = `${hit.file}:${hit.line}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      found.push({ ...hit, confidence: s.confidence, strategy: s.key });
      if (found.length >= MAX_CANDIDATES) return found;
    }
  }
  return found;
}

/**
 * `src/components/ProductCard.tsx:42:7` → a candidate, IF it stays inside the
 * root.
 *
 * The value is authored by the host application — it arrives in an
 * attribute on somebody else's page, so it is attacker-reachable and gets the
 * same confinement check as everything else here. `../../../etc/passwd:1` is an
 * entirely plausible thing to find in this field.
 */
function fromSourceRef(ref: unknown, root: string): SourceCandidate | null {
  const raw =
    typeof ref === "string" ? ref : typeof ref === "object" && ref ? String((ref as { file?: string }).file ?? "") : "";
  if (!raw) return null;
  const m = /^(.+?):(\d+)(?::\d+)?$/.exec(raw);
  if (!m) return null;
  const file = confine(root, m[1]!);
  if (!file) return null;
  const line = Number(m[2]);
  return {
    file,
    line,
    snippet: lineAt(join(root, file), line),
    confidence: 1,
    strategy: "plugin",
  };
}

/**
 * The confinement check, and the ONLY way a path becomes a result.
 *
 * Returns the root-relative path, or null. `resolve` collapses `..` before the
 * comparison — checking for the literal string `..` instead is the classic
 * mistake, since `a/../../b` and a URL-encoded separator both slip past it.
 * The trailing separator on the prefix matters too: without it, `/repo-evil`
 * passes a `startsWith("/repo")` test.
 */
function confine(root: string, candidate: string): string | null {
  const full = resolve(root, candidate);
  if (full !== root && !full.startsWith(root + sep)) return null;
  // Symlinks are not followed. A link inside the checkout pointing at
  // `~/.ssh` resolves to a path that passes every check above.
  try {
    if (lstatSync(full).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return relative(root, full);
}

/** One line, by number, or `""`. Never its neighbours. */
function lineAt(file: string, line: number): string {
  try {
    return (readFileSync(file, "utf8").split("\n")[line - 1] ?? "").trim().slice(0, 300);
  } catch {
    return "";
  }
}

type Hit = { file: string; line: number; snippet: string };

/** ripgrep where present, a bounded walker otherwise. */
async function search(root: string, needle: string, tryRipgrep: boolean): Promise<Hit[]> {
  if (tryRipgrep) {
    const viaRg = await ripgrep(root, needle);
    if (viaRg) return viaRg;
  }
  // The walker builds absolute paths as it descends, so it is confined on the
  // way OUT rather than on the way in — same check, same function, one place.
  return relativise(root, walk(root, needle));
}

async function ripgrep(root: string, needle: string): Promise<Hit[] | null> {
  try {
    const { stdout } = await exec(
      "rg",
      [
        "--fixed-strings",
        "--line-number",
        "--no-heading",
        "--max-count",
        String(MAX_CANDIDATES),
        // Skips .gitignore'd paths. Ripgrep does this by default, which
        // is half the reason it is preferred over the walker below.
        "--glob",
        "!{.git,node_modules,dist,build}/**",
        "--",
        needle,
        root,
      ],
      { cwd: root, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return parseRg(stdout, root);
  } catch (e) {
    // Exit 1 is "no matches", which is an ANSWER and not a failure — falling
    // through to the walker there would search the tree twice to find the same
    // nothing.
    const err = e as { code?: number | string; stdout?: string };
    if (err.code === 1) return [];
    return null;
  }
}

function parseRg(stdout: string, root: string): Hit[] {
  const hits: Hit[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    // `path:line:text`, and the path may itself contain colons on some
    // platforms — so the split is bounded from the LEFT at the last two.
    const first = raw.indexOf(":");
    const second = raw.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const file = confine(root, raw.slice(0, first));
    if (!file) continue;
    hits.push({
      file,
      line: Number(raw.slice(first + 1, second)) || 0,
      snippet: raw.slice(second + 1).trim().slice(0, 300),
    });
    if (hits.length >= MAX_CANDIDATES) break;
  }
  return hits;
}

/**
 * The fallback walker. Bounded on every axis that could run away: directory
 * depth, files visited, file size, and candidates returned.
 *
 * A search tool that can be made to read a 2 GB log file is a denial of service
 * an injected comment can trigger, and this one runs on the developer's own
 * machine.
 */
function walk(root: string, needle: string, depth = 0, budget = { files: 20_000 }): Hit[] {
  if (depth > 12 || budget.files <= 0) return [];
  const hits: Hit[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root === "" ? "." : root);
  } catch {
    return hits;
  }
  for (const name of entries) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const full = join(root, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      hits.push(...walk(full, needle, depth + 1, budget));
    } else if (EXT.has(name.slice(name.lastIndexOf("."))) && st.size < 1_000_000) {
      budget.files--;
      if (budget.files <= 0) break;
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (!text.includes(needle)) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(needle)) {
          hits.push({ file: full, line: i + 1, snippet: lines[i]!.trim().slice(0, 300) });
          break;
        }
      }
    }
    if (hits.length >= MAX_CANDIDATES) break;
  }
  return hits;
}

/** Absolute walker paths become root-relative, and are confined on the way. */
function relativise(root: string, hits: Hit[]): Hit[] {
  const out: Hit[] = [];
  for (const h of hits) {
    const file = confine(root, h.file);
    if (file) out.push({ ...h, file });
  }
  return out;
}
