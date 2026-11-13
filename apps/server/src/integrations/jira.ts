import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Jira Cloud, spoken with an API token.
 *
 * What Atlassian gives a self-hoster without a Marketplace listing: an API
 * token plus the account's email, as HTTP basic auth against the site's
 * REST API. Version 2 of the API rather than 3, on purpose: v3 wants the
 * description as an Atlassian Document, v2 takes text, and the brief is
 * text. Status is moved through TRANSITIONS, chosen by the status CATEGORY
 * they lead to — done, indeterminate, new — never by a status name, which
 * is per-project and arbitrary.
 */

export interface JiraClientOptions {
  siteUrl: string;
  email: string;
  apiToken: string;
  fetch?: typeof globalThis.fetch;
}

export type JiraCategory = "new" | "indeterminate" | "done";

export class JiraError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.retryable = status >= 500 || status === 429;
  }
}

export function jiraClient(opts: JiraClientOptions) {
  const base = opts.siteUrl.replace(/\/+$/, "");
  const f = opts.fetch ?? globalThis.fetch;
  const headers = {
    authorization: "Basic " + Buffer.from(`${opts.email}:${opts.apiToken}`, "utf8").toString("base64"),
    accept: "application/json",
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
      throw new JiraError(0, `could not reach Jira: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 204) return undefined as T;
    let parsed: any = null;
    try {
      parsed = await res.json();
    } catch {
      /* no body */
    }
    if (!res.ok) {
      const detail = [
        ...((parsed?.errorMessages as string[] | undefined) ?? []),
        ...Object.entries((parsed?.errors as Record<string, string> | undefined) ?? {}).map(([k, v]) => `${k}: ${v}`),
      ].join("; ");
      const what =
        res.status === 401
          ? "the email and API token were refused"
          : res.status === 403
            ? "the account is not allowed to do that in this project"
            : res.status === 404
              ? "the project was not found, or the account cannot see it"
              : `Jira answered ${res.status}`;
      throw new JiraError(res.status, detail ? `${what}: ${detail}` : what);
    }
    return parsed as T;
  }

  return {
    /** The account, the project, and an issue type to create with — Task if the project has one. */
    async probe(projectKey: string): Promise<
      | { ok: true; me: string; project: { id: string; key: string; name: string }; issueType: { id: string; name: string } }
      | { ok: false; detail: string }
    > {
      try {
        const me = await call<{ displayName?: string; emailAddress?: string }>("GET", "/rest/api/2/myself");
        const project = await call<{ id: string; key: string; name: string; issueTypes?: { id: string; name: string; subtask?: boolean }[] }>(
          "GET",
          `/rest/api/2/project/${encodeURIComponent(projectKey)}`,
        );
        const types = (project.issueTypes ?? []).filter((t) => !t.subtask);
        const issueType = types.find((t) => /^task$/i.test(t.name)) ?? types.find((t) => /^bug$/i.test(t.name)) ?? types[0];
        if (!issueType) return { ok: false, detail: `project ${project.key} has no issue type this account can create` };
        return {
          ok: true,
          me: me.displayName ?? me.emailAddress ?? opts.email,
          project: { id: String(project.id), key: project.key, name: project.name },
          issueType: { id: String(issueType.id), name: issueType.name },
        };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
    async createIssue(input: { projectId: string; issueTypeId: string; summary: string; description: string }): Promise<{ id: string; key: string; url: string }> {
      const made = await call<{ id: string; key: string }>("POST", "/rest/api/2/issue", {
        fields: {
          project: { id: input.projectId },
          issuetype: { id: input.issueTypeId },
          summary: input.summary.slice(0, 255),
          description: input.description,
        },
      });
      return { id: String(made.id), key: made.key, url: `${base}/browse/${made.key}` };
    },
    /** Move the issue to a status in the category; refused with a sentence when the workflow offers none. */
    async transitionTo(issueKey: string, category: JiraCategory): Promise<void> {
      const list = await call<{ transitions: { id: string; name: string; to: { statusCategory?: { key?: string } } }[] }>(
        "GET",
        `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
      );
      const t = list.transitions.find((x) => x.to?.statusCategory?.key === category);
      if (!t) {
        // Already there is not a failure — a workflow offers no transition to
        // the status the issue holds.
        const current = await call<{ fields?: { status?: { statusCategory?: { key?: string } } } }>(
          "GET",
          `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=status`,
        );
        if (current.fields?.status?.statusCategory?.key === category) return;
        throw new JiraError(422, `the project's workflow offers no transition from the issue's current status to a ${category} status`);
      }
      await call("POST", `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, { transition: { id: t.id } });
    },
  };
}

/** Jira Cloud signs a webhook that has a secret with `X-Hub-Signature: sha256=<hex HMAC-SHA256 of the body>`. */
export function verifyJiraSignature(raw: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const hex = header.startsWith("sha256=") ? header.slice(7) : header;
  const given = Buffer.from(hex.trim(), "hex");
  const want = createHmac("sha256", secret).update(raw, "utf8").digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Our status → the status category to transition to; their category → our status. */
export function jiraCategoryFor(status: string): JiraCategory {
  return status === "resolved" ? "done" : status === "progress" ? "indeterminate" : "new";
}
export function statusForJiraCategory(category: string): "resolved" | "progress" | "open" {
  return category === "done" ? "resolved" : category === "indeterminate" ? "progress" : "open";
}

/**
 * Jira's v2 description is wiki markup, which a reviewer's text could steer
 * (`{code}`, `[link|url]`, `!image!`). The brief's own structure is plain
 * Markdown and reads fine as text; the reviewer's words get the few wiki
 * specials escaped after the outbound sanitiser has done its part.
 */
export function escapeForJiraWiki(s: string): string {
  return s.replace(/([{}\[\]|!])/g, "\\$1");
}
