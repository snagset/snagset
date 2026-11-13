import { Hono, type Context } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "@snagset/mcp";
import { CREDENTIAL_PREFIX, HTTP_HEADER } from "@snagset/types/names";
import type { AddressSource } from "../instance/address.ts";
import type { McpHttpSource } from "../instance/mcpHttp.ts";
import type { McpClaims } from "./mcpToken.ts";

/**
 * `POST /mcp` — the remote MCP transport, 05 endpoint 42 and the
 * second row.
 *
 * The same MCP server the developer runs on their own machine over stdio,
 * built here per request and spoken to over streamable HTTP, so an agent that
 * is not on a laptop with a checkout — a hosted one, a CI job, a colleague's
 * box that never cloned the repo — can list and read threads with the token
 * the dashboard mints.
 *
 * Three things are deliberately different from stdio:
 *
 *   · `source:map` is absent. There is no checkout here to search.
 *   · Writes need `allow_remote_writes` on the token — a server-side
 *     gate, enforced in `mcpAuth`, distinct from the UX obligation stdio
 *     carries. Every call the MCP server makes back into the API is marked
 *     with the transport header so the gate can tell.
 *   · It is OFF until an owner turns it on — the switch on Studio ›
 *     Integrations › MCP, or `SNAGSET_MCP_HTTP_ENABLED`, which wins and
 *     locks the switch. An agent-reachable surface is a decision,
 *     not a default; read live, so the switch restarts nothing.
 *
 * Stateless: no session id, one JSON response per request. The API calls go
 * straight to this app's `fetch` — no socket, no second hop, the same
 * authorisation as any other caller, because the bearer travels with them.
 */

type Env = { Variables: { requestId: string; mcp?: McpClaims } };
type Ctx = Context<Env>;

export interface McpHttpDeps {
  /** The switch, read live: the environment's, the owner's, or off. */
  mcpHttp: McpHttpSource;
  address: AddressSource;
  version: string;
  /** This app's own fetch — the MCP server's API calls land here, in-process. */
  dispatch: (req: Request) => Promise<Response>;
}

function fail(c: Ctx, status: number, code: string, message: string) {
  return c.json({ error: { code, message, requestId: c.get("requestId") } }, status as 400);
}

export function mcpHttpRoutes(deps: McpHttpDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.all("/mcp", async (c) => {
    if (!(await deps.mcpHttp()).enabled) {
      return fail(c, 404, "not_found", "The remote MCP transport is off. An owner turns it on at Studio › Integrations › MCP, or set SNAGSET_MCP_HTTP_ENABLED=true in the environment; the stdio server needs nothing here.");
    }
    const presented = /^Bearer (.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    if (!presented?.startsWith(CREDENTIAL_PREFIX.mcp) || !c.get("mcp")) {
      return fail(c, 401, "unauthorized", "Send an MCP token as a bearer: Authorization: Bearer snagmcp_… — mint one on Studio › Integrations › MCP.");
    }
    const host = await deps.address();
    const server = createServer({
      host,
      token: presented,
      repoRoot: "",
      transport: "http",
      version: deps.version,
      // Every API call the tools make goes back into this process, carrying
      // the same bearer and the transport marker the write gate reads.
      fetch: async (input, init) => {
        const req = new Request(input, init);
        req.headers.set(HTTP_HEADER.mcpTransport, "http");
        return deps.dispatch(req);
      },
    });
    // No session id generator at all is the SDK's stateless mode: one JSON answer per request.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await transport.close().catch(() => {});
    }
  });

  return app;
}
