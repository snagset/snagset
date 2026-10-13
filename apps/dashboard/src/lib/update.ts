/**
 * "Is there a newer Snagset?" — asked of npm, by the operator's browser, on
 * the operator's click. Never by the server, never on a timer.
 *
 * The design is "no phone-home, ever", and the registry carries a
 * SNAGSET_TELEMETRY row that exists ONLY so the boot validator can refuse it
 * — the spec's own words: a variable that exists only to be refused is a
 * stronger promise than a paragraph. A server job that contacted npm on a
 * schedule would break that promise in the one place it is mechanically
 * enforced. What the maintainer actually asked for — "they can just do it when they
 * want" — is an action, not a beacon, and an action belongs where the person
 * is: in their browser, when they ask.
 *
 * The package is @snagset/server because that is what a self-hosted deploy
 * depends on (docs/self-hosting.md) and what `pnpm update` moves.
 */

const LATEST = "https://registry.npmjs.org/@snagset%2Fserver/latest";

export interface UpdateResult {
  latest: string;
  /** True only when the registry's version is STRICTLY newer than ours. A
   *  dev build ahead of the registry — 0.0.5 against a published 0.0.4 — is
   *  not an update waiting, and saying so would be a nag with nothing to do. */
  newer: boolean;
}

export async function checkForUpdate(current: string): Promise<UpdateResult> {
  const res = await fetch(LATEST, {
    signal: AbortSignal.timeout(6000),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`npm answered ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== "string") throw new Error("npm's answer carried no version");
  return { latest: body.version, newer: compare(body.version, current) > 0 };
}

/** Three numeric parts, pre-release tag ignored. Enough for x.y.z, which is
 *  all this package has ever published; not a general semver. */
export function compare(a: string, b: string): number {
  const p = (v: string) => v.replace(/^v/, "").split("-")[0]!.split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
