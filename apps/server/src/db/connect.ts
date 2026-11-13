import postgres from "postgres";

/**
 * The one place a connection is opened — and the one place `prepare: false`
 * is explained, so it does not get "optimised" back on.
 *
 * The design describes the blessed path as *"marketplace Postgres attached in the
 * click, handing the app a **pooled** `DATABASE_URL`"*. A pooled endpoint is
 * PgBouncer in transaction mode: a connection is handed to one transaction and
 * then to somebody else, so a prepared statement created on it may be executed
 * later against a different backend that never saw the PREPARE.
 *
 * The failure is not a clean error at the point of the mistake. It surfaces
 * as `cached plan must not change result type` on some later query, usually
 * after a migration has changed a table the plan referenced — which reads as
 * database corruption and is nothing of the kind. It was found here by running
 * the share-link suite twice against one pooled Neon endpoint: the second run
 * dropped and recreated the schema, and every query afterwards failed.
 *
 * THE COST IS ONE EXTRA ROUND TRIP PER PARAMETERISED STATEMENT, EVERY TIME —
 * not per unique query shape, which is what this comment used to claim.
 * postgres.js sets `describeFirst` whenever a query has parameters and is not
 * prepared (connection.js: `parameters.length && !q.prepared`), so it sends
 * Describe+Flush, waits, then Bind+Execute+Sync. Measured against London from
 * Seoul, 4 runs each: a parameterised `SELECT $1::int` costs **520 / 521 / 509
 * / 519 ms** unprepared against **539 / 268 / 270 / 264 ms** prepared, on a
 * link whose one-way is ~260 ms. Every statement in a request pays it.
 *
 * It is still the right default, and the reason is deployment rather than
 * performance: The blessed path hands out a pooled URL, and this is the
 * setting that makes that URL work. But the cost is now written down, because
 * it is the largest single term in the create path's latency and the next
 * person to look at that number should not have to measure it again.
 *
 * (For the record, postgres.js DOES retry both `RevalidateCachedQuery` and
 * `FetchPreparedStatement` — so re-enabling `prepare` is a real option to
 * evaluate, not a settled impossibility. It wants its own test against a
 * schema change on a pooled endpoint, which is the scenario that produced the
 * original failure, and it should not be flipped without one.)
 */

/** `SNAGSET_DATABASE_SSL`: `auto` = require unless the host is local. */
export type SslMode = "auto" | "require" | "disable";

/**
 * Is this a host where plaintext is the normal, safe thing?
 *
 * Loopback, the RFC 1918 and link-local ranges, `localhost` and its
 * subdomains, and a bare single-label name (`db`, `postgres`) — the shape a
 * compose network or a private DNS hands out. Decided from the string rather
 * than by resolving it: a connect that first does a DNS lookup to decide
 * whether to encrypt would add a round trip to every pool open, and a host
 * that resolves to something public is one somebody typed a public name for.
 */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "" || h === "localhost" || h.endsWith(".localhost")) return true;
  // Not `node:net`'s isIP: the mail suite's seam test treats that import as
  // a transport reaching outside the two adapters, and two regexes are
  // enough to tell a literal address from a name.
  const v = /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? 4 : h.includes(":") ? 6 : 0;
  if (v === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  if (v === 6) return h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:127.");
  // A unix socket path, or a name with no dot in it — never a public host.
  return h.startsWith("/") || !h.includes(".");
}

/**
 * What to hand postgres.js as `ssl`, from the operator's setting and the URL.
 *
 * WHY THIS EXISTS. `SNAGSET_DATABASE_SSL` was registered in from the
 * first draft and read by nothing: the connection took whatever the URL said,
 * and a URL that said nothing meant PLAINTEXT. That never showed on Neon,
 * whose strings carry `?sslmode=require`. Supabase's do not — the string its
 * dashboard hands you has no query at all — so a Supabase project with
 * *Enforce SSL* on refused the connection, and one without it carried every
 * reviewer's words across the internet in the clear. Neither is what "auto"
 * promised.
 *
 * The rules, in order:
 *   · `disable` → plaintext, whatever the URL says. The operator's call.
 *   · `require` → TLS, whatever the URL says.
 *   · `auto`    → the URL's own `sslmode`/`ssl` if it has one (postgres.js
 *                 reads it; a provider that wrote it knew its endpoint), else
 *                 TLS unless the host is local (`isLocalHost`).
 *
 * `undefined` means "leave it to postgres.js", which is where the URL's
 * parameter is honoured; passing an explicit value overrides the URL.
 *
 * `require` is libpq's meaning: encrypted, the certificate NOT verified. That
 * is what a managed provider's own CA (Supabase's, Neon's) needs without a
 * root certificate on the operator's machine, and it is what their strings
 * ask for. `verify-full` is available by writing it into the URL.
 */
export function sslFor(url: string, mode: SslMode = "auto"): "require" | false | undefined {
  if (mode === "disable") return false;
  if (mode === "require") return "require";
  let host = "";
  let saysSo = false;
  try {
    const u = new URL(url);
    host = u.hostname;
    saysSo = u.searchParams.has("sslmode") || u.searchParams.has("ssl") || u.searchParams.has("sslrootcert");
  } catch {
    return undefined; // an unparseable URL is loadConfig's to refuse, not this function's
  }
  if (saysSo) return undefined;
  return isLocalHost(host) ? undefined : "require";
}

export function connect(url: string, opts: { max?: number; ssl?: SslMode } = {}): postgres.Sql {
  const ssl = sslFor(url, opts.ssl ?? "auto");
  return postgres(url, {
    max: opts.max ?? 10,
    prepare: false,
    ...(ssl === undefined ? {} : { ssl }),
    // Seconds. Without this a pooler that stops resolving — Neon did, twice in
    // one afternoon: `read ETIMEDOUT`, then `getaddrinfo ENOTFOUND` — leaves
    // every request hanging for the OS's TCP timeout, and the dashboard shows
    // a loading skeleton with nothing to say for as long as that takes. Ten
    // is generous for a managed database on the other side of an ocean and
    // short enough that the client's "still waiting" can become a real error.
    connect_timeout: 10,
    // The server has its own logging rules (app.ts); postgres.js NOTICE output
    // would bypass them.
    onnotice: () => {},
  });
}
