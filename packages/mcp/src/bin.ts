#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

/**
 * The stdio entry point — the supported transport.
 *
 * | Transport | Where it runs | Default |
 * |---|---|---|
 * | **stdio** | the developer's own machine, spawned by their MCP client | **the supported path** |
 * | streamable HTTP | our server, at `POST /mcp` | **off** until the switch on Studio › Integrations › MCP, or `SNAGSET_MCP_HTTP_ENABLED` |
 *
 * This file is the first. Stdio is the default and the design is the reason, not
 * a scheduling accident: source mapping needs the checkout, the checkout is
 * on the developer's machine, and a remote server cannot offer `source:map`
 * at all — the instance serves the second without it.
 *
 * ── NOTHING MAY BE WRITTEN TO STDOUT ──
 *
 * stdout IS the protocol channel. A `console.log` anywhere in this package
 * corrupts the JSON-RPC stream and the client reports a parse error with no
 * indication of where it came from. Diagnostics go to stderr, which the client
 * shows in its logs. This is the single most common way an MCP server that
 * works in a test fails in a real client.
 */

const env = process.env;

/**
 * Config comes from the MCP CLIENT's process env, not ours — it is
 * written into the client's config file:
 *
 * ```jsonc
 * { "mcpServers": { "snagset": { "command": "npx", "args": ["-y", "@snagset/mcp"],
 *     "env": { "SNAGSET_MCP_TOKEN": "…", "SNAGSET_MCP_HOST": "https://review.example.com" } } } }
 * ```
 *
 * `CLICKREVIEW_TOKEN` and `CLICKREVIEW_HOST` are DELETED — the last
 * un-namespaced spelling in 07, kept there only as a deletion record. They are
 * not read here, not even as a fallback: a fallback is how a deleted name stays
 * alive for years.
 */
const token = env["SNAGSET_MCP_TOKEN"];
const host = env["SNAGSET_MCP_HOST"];

function die(message: string): never {
  // stderr, and a non-zero exit. A server that starts and then answers every
  // tool call with "no token" looks to the agent like a product that does not
  // work; failing at startup puts the message where the developer configuring
  // it will actually see it.
  process.stderr.write(`snagset-mcp: ${message}\n`);
  process.exit(2);
}

if (!token) {
  die(
    "SNAGSET_MCP_TOKEN is not set. Mint one on the instance with `snagset mcp-token create <name>` " +
      "and put it in your MCP client's config under env.",
  );
}
if (!host) {
  die("SNAGSET_MCP_HOST is not set — the base URL of your Snagset instance, e.g. https://review.example.com");
}
if (!token.startsWith("snagmcp_")) {
  // Named early because the two credentials look nothing alike and the failure
  // otherwise arrives as a 401 on the first tool call, three steps later.
  die("SNAGSET_MCP_TOKEN does not look like an MCP token — they begin `snagmcp_`. An API key will not work here.");
}

const server = createServer({
  host,
  token,
  // The client spawns us in the developer's project directory, which is what
  // makes `map_thread_to_source` work with no configuration at all.
  repoRoot: env["SNAGSET_MCP_REPO_ROOT"] ?? process.cwd(),
  project: env["SNAGSET_MCP_PROJECT"],
  version: env["SNAGSET_MCP_VERSION"] ?? "0.0.0",
});

await server.connect(new StdioServerTransport());
process.stderr.write(`snagset-mcp: connected to ${host}\n`);
