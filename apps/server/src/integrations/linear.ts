import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Linear, spoken with a personal API key.
 *
 * The design decided OAuth with `actor=app` for the cloud; a self-host will not
 * register an OAuth application, so the connection is an API key belonging
 * to a member of the team. Three GraphQL calls are all this needs: find the
 * team and its workflow states, create an issue, move its state. Selections
 * are hand-written and minimal because Linear charges complexity on what is
 * requested, and every failure comes back as a sentence with Linear's
 * own message in it.
 */

export interface LinearClientOptions {
  apiKey: string;
  /** https://api.linear.app/graphql, or a test's fake. */
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
}

/** The team's workflow states we move issues between, resolved once at connect by TYPE, never by name. */
export interface LinearStates {
  completed: string;
  started: string;
  unstarted: string;
}

export class LinearError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.retryable = status >= 500 || status === 429;
  }
}

export function linearClient(opts: LinearClientOptions) {
  const url = opts.apiBase ?? "https://api.linear.app/graphql";
  const f = opts.fetch ?? globalThis.fetch;

  async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await f(url, {
        method: "POST",
        headers: { authorization: opts.apiKey, "content-type": "application/json", "user-agent": "snagset" },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      throw new LinearError(0, `could not reach Linear: ${e instanceof Error ? e.message : String(e)}`);
    }
    let body: { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* no body */
    }
    if (res.status === 401 || res.status === 403) {
      throw new LinearError(res.status, "the API key was refused (revoked, or not a Linear key)");
    }
    if (!res.ok) throw new LinearError(res.status, `Linear answered ${res.status}${body.errors?.[0]?.message ? `: ${body.errors[0].message}` : ""}`);
    if (body.errors?.length) {
      const first = body.errors[0]!;
      const code = first.extensions?.code ?? "";
      const auth = /AUTHENTICATION|FORBIDDEN|UNAUTHENTICATED/i.test(code);
      throw new LinearError(auth ? 401 : 422, first.message ?? "Linear refused the request");
    }
    if (!body.data) throw new LinearError(502, "Linear answered without data");
    return body.data;
  }

  return {
    /** The team by key, and the first state of each type we need — the shape the worker moves issues between. */
    async probe(teamKey: string): Promise<
      { ok: true; team: { id: string; key: string; name: string }; states: LinearStates; viewer: string } | { ok: false; detail: string }
    > {
      try {
        const data = await gql<{
          viewer: { name: string };
          teams: { nodes: { id: string; key: string; name: string; states: { nodes: { id: string; name: string; type: string; position: number }[] } }[] };
        }>(
          `query SnagsetProbe($key: String!) {
             viewer { name }
             teams(filter: { key: { eq: $key } }, first: 1) {
               nodes { id key name states { nodes { id name type position } } }
             }
           }`,
          { key: teamKey },
        );
        const team = data.teams.nodes[0];
        if (!team) return { ok: false, detail: `no team with the key ${teamKey} is visible to this API key (private teams need a member's key)` };
        const byType = (type: string) => team.states.nodes.filter((s) => s.type === type).sort((a, b) => a.position - b.position)[0];
        const completed = byType("completed");
        const started = byType("started");
        const unstarted = byType("unstarted") ?? byType("backlog") ?? byType("triage");
        if (!completed || !started || !unstarted) {
          return { ok: false, detail: `team ${team.key} lacks a workflow state of type completed, started or unstarted` };
        }
        return {
          ok: true,
          team: { id: team.id, key: team.key, name: team.name },
          states: { completed: completed.id, started: started.id, unstarted: unstarted.id },
          viewer: data.viewer.name,
        };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
    async createIssue(input: { teamId: string; title: string; description: string; stateId?: string }): Promise<{ id: string; identifier: string; url: string }> {
      const data = await gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null } }>(
        `mutation SnagsetCreate($input: IssueCreateInput!) {
           issueCreate(input: $input) { success issue { id identifier url } }
         }`,
        { input: { teamId: input.teamId, title: input.title, description: input.description, ...(input.stateId ? { stateId: input.stateId } : {}) } },
      );
      if (!data.issueCreate.success || !data.issueCreate.issue) throw new LinearError(502, "Linear did not create the issue");
      return data.issueCreate.issue;
    },
    async setState(issueId: string, stateId: string): Promise<void> {
      const data = await gql<{ issueUpdate: { success: boolean } }>(
        `mutation SnagsetState($id: String!, $input: IssueUpdateInput!) {
           issueUpdate(id: $id, input: $input) { success }
         }`,
        { id: issueId, input: { stateId } },
      );
      if (!data.issueUpdate.success) throw new LinearError(502, "Linear did not move the issue");
    },
  };
}

/** `Linear-Signature` is the hex HMAC-SHA256 of the raw body with the webhook's signing secret. */
export function verifyLinearSignature(raw: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const given = Buffer.from(header.trim(), "hex");
  const want = createHmac("sha256", secret).update(raw, "utf8").digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Our status → the team's state (by TYPE); their state type → our status. */
export function linearStateFor(status: string, states: LinearStates): string {
  return status === "resolved" ? states.completed : status === "progress" ? states.started : states.unstarted;
}
export function statusForLinearState(type: string): "resolved" | "progress" | "open" {
  return type === "completed" || type === "canceled" ? "resolved" : type === "started" ? "progress" : "open";
}
