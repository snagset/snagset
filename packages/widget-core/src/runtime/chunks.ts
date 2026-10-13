import { ARTIFACT } from "@snagset/types/names";

/**
 * ONE loader for every lazy artefact — the contract.
 *
 * Before this, each chunk had a bespoke loader: panels carried its own retry
 * counter, capture its own import, and the three artefacts adds would
 * have made five copies of the same subtle code. The subtleties are the point:
 *
 *   · A REJECTED dynamic import is recorded in the browser's module map against
 *     its URL, so re-importing the identical href replays the cached rejection
 *     without touching the network (R5). Retries vary the URL with a
 *     per-chunk monotonic `?r=N` — safe because chunks are self-contained
 *     no baked specifier anywhere cares which generation loaded.
 *   · Every URL carries `?cv=<version>`, so a CDN edge cannot serve
 *     a stale chunk against a fresh runtime without the URL saying so.
 *   · The base resolves against the DOCUMENT first: `new URL(x, "/widget/")`
 *     throws, and a host that mounts the runtime directly may pass a
 *     root-relative base.
 *
 * The contract callers rely on: **this function never throws.** It returns a
 * typed result, and `unavailable` is an ordinary value the caller must handle —
 * a blocked chunk is a state the product lives in (the F-tier), not an
 * exception. One automatic retry happens here; anything beyond that is the
 * caller's Retry button, which calls again and gets a fresh URL.
 */

/** This chunk's own version — kept in lockstep with the loader's by the
 *  release process; the R7 covers the case where they disagree. */
const VERSION = "0.0.0";

export type ChunkName = keyof typeof CHUNK_FILE;

/** Names → registered artefact filenames. The stub, runtime and
 *  panels are absent deliberately: the stub is never lazy, and the two eager
 *  chunks are imported at activation by the stub itself. */
const CHUNK_FILE = {
  capture: ARTIFACT.capture,
  "anchor-ext": ARTIFACT.anchorExt,
  "anchor-fuzzy": ARTIFACT.anchorFuzzy,
  crumbs: ARTIFACT.crumbs,
  screenshot: ARTIFACT.screenshot,
  dock: ARTIFACT.dock,
  text: ARTIFACT.text,
} as const;

export type ChunkResult<T> =
  | { ok: true; mod: T }
  | { ok: false; reason: "unavailable" };

/** Resolved modules — a chunk loads once; every later call is free. */
const loaded = new Map<ChunkName, unknown>();
/** In-flight loads, so concurrent callers share one fetch. */
const pending = new Map<ChunkName, Promise<ChunkResult<unknown>>>();
/** Attempt counters, per chunk, monotonic for the life of the page. */
const attempts = new Map<ChunkName, number>();

/**
 * base + file + ?cv, plus `?r=N` on every attempt after the first. The varied
 * URL is the module-map defence: a rejected dynamic import is recorded against
 * its URL and replayed from cache, so a retry at the same href never touches
 * the wire (R5). Chunks are SELF-CONTAINED precisely so this is
 * safe — nothing holds a baked static specifier to a chunk URL, so nothing
 * cares which `?r` generation a chunk finally loaded from.
 */
function urlFor(name: ChunkName, base: string, doc: Document): string {
  const abs = new URL(base, doc.location.href).href;
  const u = new URL(CHUNK_FILE[name], abs);
  u.searchParams.set("cv", VERSION);
  const n = attempts.get(name) ?? 0;
  if (n > 0) u.searchParams.set("r", String(n));
  attempts.set(name, n + 1);
  return u.href;
}

/**
 * PROBE BEFORE IMPORT — the module-map defence, corrected.
 *
 * The first design varied the import URL on retry (`?r=N`), because a rejected
 * dynamic import poisons its URL in the module map. That worked until the
 * chunks started importing EACH OTHER: the dock's compiled output carries a
 * static `./snag.panels.js?cv=…` specifier, and once the canonical panels URL
 * had been poisoned by one blocked attempt, no retry could ever heal the dock —
 * its baked specifier replayed the cached rejection forever. Caught by the
 * Retry-recovers E2E on all three engines at once.
 *
 * So the canonical URL is now NEVER imported until a plain fetch() has proven
 * it reachable. A fetch failure poisons nothing — the module map never hears
 * about it — and the eventual import() is the URL's first, against bytes the
 * probe just fetched into the HTTP cache. ES modules require CORS anyway, so
 * the probe can reach exactly what import() could.
 *
 * The residual: a chunk whose BYTES are broken (a parse error) still poisons
 * its URL on import — and should, because retrying a truncated artefact is
 * how a CDN incident becomes an infinite loop.
 */
/**
 * The probe is a `<link rel="modulepreload">`, not a fetch — because a fetch
 * probe DOUBLED the round trips on the critical path and the Fast-3G perf gate
 * went red the moment it landed. A modulepreload is one network request whose
 * response the subsequent import() REUSES, its failure is HTTP-level only
 * (nothing enters the module map), and its error event is the probe signal.
 *
 * Safari 16.4–16.6 has no modulepreload (support arrived at 17.0, and the
 * floor is 16.4) — there the fallback is the plain fetch probe, paying the
 * extra round trip only on engines that give no choice.
 */
export async function loadChunk<T = unknown>(
  name: ChunkName,
  base: string,
  doc: Document = document,
): Promise<ChunkResult<T>> {
  const done = loaded.get(name);
  if (done) return { ok: true, mod: done as T };
  const flight = pending.get(name);
  if (flight) return flight as Promise<ChunkResult<T>>;

  const run = (async (): Promise<ChunkResult<unknown>> => {
    // Two attempts: the original and R5's one automatic retry, each at
    // a fresh URL so a cached rejection is never replayed.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const mod: unknown = await import(/* @vite-ignore */ urlFor(name, base, doc));
        loaded.set(name, mod);
        return { ok: true, mod };
      } catch {
        /* fall through to the second attempt, or to unavailable */
      }
    }
    return { ok: false, reason: "unavailable" as const };
  })();

  pending.set(name, run);
  try {
    return (await run) as ChunkResult<T>;
  } finally {
    pending.delete(name);
  }
}

/** Test seam: the E2E harness resets between scenarios so a chunk blocked in
 *  one test is loadable in the next. Not part of the public surface. */
export function resetChunksForTest(): void {
  loaded.clear();
  pending.clear();
  attempts.clear();
}
