# `@snagset/mcp`

The [Snagset](https://github.com/snagset/snagset) MCP server. It gives a coding
agent the review comments left on your site, so *"fix the pin on the PDP"* is a
task the agent can start — rather than a screenshot pasted into a chat window.

## Setting it up

Mint a token on your instance — Studio › Integrations › MCP › **New token…**,
which shows it once beside the config below, or on the box itself:

```bash
snagset mcp-token create "Claude Code"
```

It is shown once. Put it in your MCP client's config:

```jsonc
{
  "mcpServers": {
    "snagset": {
      "command": "npx",
      "args": ["-y", "@snagset/mcp"],
      "env": {
        "SNAGSET_MCP_TOKEN": "snagmcp_…",
        "SNAGSET_MCP_HOST": "https://review.example.com",
        "SNAGSET_MCP_PROJECT": "prj_…"
      }
    }
  }
}
```

Start the client **from your checkout** — `map_thread_to_source` searches the
directory it was spawned in. `SNAGSET_MCP_REPO_ROOT` overrides that.

## The tools

| Tool | Scope | What it does |
|---|---|---|
| `list_threads` | `threads:read` | What is broken, where, in which state |
| `get_thread` | `threads:read` | One snag's full conversation |
| `get_thread_context` | `context:read` | Browser, viewport, console breadcrumbs |
| `map_thread_to_source` | `source:map` | Search your checkout for the element |
| `comment_on_thread` | `comments:write` | Reply, as the agent |
| `mark_ready` | `threads:write` | Move a snag to `review` |

**There is no tool that resolves a thread.** An agent can propose, never
dispose — whoever reported a snag decides when it is fixed. Same for editing or
deleting anyone's comment: neither exists.

The default token is **read-only**. Add write scopes explicitly:

```bash
snagset mcp-token create "Claude Code" threads:read,source:map,comments:write
```

## Remote

With the remote transport on — the switch on Studio › Integrations › MCP, or
`SNAGSET_MCP_HTTP_ENABLED=true` in the instance's environment — the same server
is served at `POST /mcp` for an agent that has no checkout: the token goes as a
bearer, `map_thread_to_source` is absent, and writes need a token minted with
remote writes allowed. The dashboard's token dialog shows the config for it.

## What it is not

It holds **no database connection**. Every read goes through the same
`/api/v1` routes with the same authorisation as any other caller, so a bug in
this package cannot read a thread its token could not already read.

Review comments are typed by anyone who can load your site. Everything this
server returns is wrapped in `<untrusted-content>` and preceded by a boundary
statement — but fencing reduces the rate at which a model follows injected
text, it does not close the class. The controls that hold when the model *is*
fooled are the ones that do not depend on it: no execution primitives, a hard
write budget (20 writes / 10 minutes, enforced server-side), a read-only
default, and a revocable token with an audit trail.

If that is not enough for your deployment, do not issue a write scope.

MIT.
