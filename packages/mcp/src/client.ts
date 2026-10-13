/**
 * The HTTP client — the load-bearing sentence made literal.
 *
 * > *"It is not a second API. Every read the MCP server performs goes through
 * > the same `/api/v1` routes with the same authorisation as any other caller;
 * > it holds no database connection, no credential store and no cache of its
 * > own. A bug in this package cannot read a thread its token could not already
 * > read."*
 *
 * That last clause is a claim about THIS FILE, and it is only true while this
 * is the only way out of the package. There is no `postgres` dependency here
 * and there must never be one: the day this package can reach the database, its
 * scopes become advisory and every mitigation .6 rests on the agent
 * behaving.
 *
 * The whole surface is one method. `fetch` is the platform's, so the package
 * carries no HTTP dependency either.
 */

export interface ClientConfig {
  /** `SNAGSET_MCP_HOST` — the instance's base URL. */
  readonly host: string;
  /** `SNAGSET_MCP_TOKEN` — read from the MCP client's process env. */
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * What a tool gets back. Never a thrown `Response`: an agent needs to be told
 * what went wrong in words it can relay to its user, and the MCP tool layer
 * turns this into `isError: true` with that text.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; message: string; status: number };

export class Client {
  readonly #host: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(cfg: ClientConfig) {
    // Trailing slash removed once, here, rather than at eleven call sites —
    // `https://x/` + `/api/v1` is a double slash, which some proxies 404 and
    // some silently normalise, so it fails on somebody else's deployment and
    // not on ours.
    this.#host = cfg.host.replace(/\/+$/, "");
    this.#token = cfg.token;
    this.#fetch = cfg.fetch ?? globalThis.fetch;
  }

  get host(): string {
    return this.#host;
  }

  async call<T>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<Result<T>> {
    const url = new URL(this.#host + path);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }

    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (e) {
      // A network failure is the single most likely thing to go wrong here —
      // the agent is on a laptop, the instance is somewhere else — and the
      // message names the host, because "fetch failed" sends a developer to
      // look at their code rather than at their VPN.
      return {
        ok: false,
        status: 0,
        message: `Could not reach ${this.#host}: ${e instanceof Error ? e.message : String(e)}. Check SNAGSET_MCP_HOST and that the instance is running.`,
      };
    }

    const text = await res.text();
    if (!res.ok) {
      const parsed = safeJson(text) as { error?: { code?: string; message?: string } } | null;
      const code = parsed?.error?.code;
      const message = parsed?.error?.message ?? text.slice(0, 400);

      // On 429 the tool layer must tell the agent to STOP and ask its
      // user — *"never a silent retry, never a sleep-and-retry loop. An agent
      // that has been talked into mass-resolving threads must hit a wall it has
      // to report, because the wall is the only part of the mitigation a human
      // sees."* This client therefore has no retry logic at all, on any status.
      if (res.status === 429) {
        // Appended only when the server did not already say it. The server's
        // own budget message ends "do not retry", and adding ours produced
        // "…do not retry. Do not retry — tell your user." — a stop signal that
        // reads like a stutter, which is the opposite of what it is for.
        const stop = /do not retry/i.test(message) ? "" : " Do not retry — tell your user.";
        return { ok: false, status: 429, message: message + stop };
      }
      if (code === "mcp_scope_denied") {
        return { ok: false, status: 403, message };
      }
      return { ok: false, status: res.status, message: `${res.status}: ${message}` };
    }

    const value = safeJson(text);
    if (value === null && text.trim() !== "null") {
      return {
        ok: false,
        status: res.status,
        // The exact failure the server's own widget route had: a 200 with an
        // HTML body, because an SPA fallback answered a path nobody had
        // registered. Named, because "unexpected token <" is not a diagnosis.
        message: `${this.#host} answered ${res.status} with something that is not JSON. Is SNAGSET_MCP_HOST pointing at a Snagset instance?`,
      };
    }
    return { ok: true, value: value as T };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
