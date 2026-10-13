/**
 * GitHub, spoken with a fine-grained token.
 *
 * The design decided a GitHub App for the cloud; a self-host will not register
 * one, so the connection here is a token scoped to one repository (Issues:
 * read and write, Metadata: read). Three calls are all this needs: create an
 * issue, move its state, and prove the token can see the repo. Every call
 * carries the API version header, and every failure comes back as a sentence
 * with GitHub's own message in it, because "422" tells nobody what to fix.
 */

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export interface GitHubClientOptions {
  token: string;
  /** api.github.com, or a GitHub Enterprise Server's API root — or a test's fake. */
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
}

export interface CreatedIssue {
  number: number;
  url: string;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    // 5xx and the two rate-limit answers are "not now"; 4xx are "not like this".
    this.retryable = status >= 500 || status === 429 || status === 403 && /rate limit/i.test(message);
  }
}

export function githubClient(opts: GitHubClientOptions) {
  const base = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const f = opts.fetch ?? globalThis.fetch;
  const headers = {
    authorization: `Bearer ${opts.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "snagset",
  };

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new GitHubError(0, `could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { message?: string; errors?: { message?: string; field?: string }[] };
        detail = [j.message, ...(j.errors ?? []).map((x) => x.message ?? x.field)].filter(Boolean).join("; ");
      } catch {
        /* no body */
      }
      const what =
        res.status === 401
          ? "the token was refused (revoked, expired, or not a GitHub token)"
          : res.status === 404
            ? "the repository was not found, or the token cannot see it"
            : res.status === 403
              ? "the token is not allowed to do that on this repository"
              : `GitHub answered ${res.status}`;
      throw new GitHubError(res.status, detail ? `${what}: ${detail}` : what);
    }
    return (await res.json()) as T;
  }

  return {
    /** Proves the token can see the repo and may write issues. */
    async probe(r: GitHubRepo): Promise<{ ok: true; fullName: string; canWrite: boolean } | { ok: false; detail: string }> {
      try {
        const repo = await call<{ full_name: string; permissions?: { push?: boolean; admin?: boolean } }>(
          "GET",
          `/repos/${enc(r.owner)}/${enc(r.repo)}`,
        );
        return { ok: true, fullName: repo.full_name, canWrite: !!(repo.permissions?.push || repo.permissions?.admin) };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
    async createIssue(r: GitHubRepo, issue: { title: string; body: string; labels?: string[] }): Promise<CreatedIssue> {
      const made = await call<{ number: number; html_url: string }>("POST", `/repos/${enc(r.owner)}/${enc(r.repo)}/issues`, {
        title: issue.title,
        body: issue.body,
        ...(issue.labels?.length ? { labels: issue.labels } : {}),
      });
      return { number: made.number, url: made.html_url };
    },
    /** `closed` with a reason, or `open`. GitHub's own vocabulary; the mapping from ours is the worker's. */
    async setIssueState(r: GitHubRepo, number: number, state: "open" | "closed", reason?: "completed" | "not_planned"): Promise<void> {
      await call("PATCH", `/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${number}`, {
        state,
        ...(state === "closed" && reason ? { state_reason: reason } : {}),
      });
    },
    async comment(r: GitHubRepo, number: number, body: string): Promise<void> {
      await call("POST", `/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${number}/comments`, { body });
    },
  };
}

const enc = encodeURIComponent;

/** The issue title — the algorithm on an already-escaped first line. */
export function issueTitle(input: { key: string; route: string; firstBody: string | null; author: string }): string {
  let summary = "";
  const raw = (input.firstBody ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) summary = `review comment from ${input.author || "a reviewer"}`;
  else {
    const first = raw.split(/(?<=[.!?])\s+/)[0] ?? raw;
    summary = first.length <= 72 ? first : `${first.slice(0, 71).replace(/\s+\S*$/, "")}…`;
  }
  const route = input.route.length > 32 ? `…${input.route.slice(-31)}` : input.route;
  return `${route} — ${summary}`.slice(0, 256);
}
