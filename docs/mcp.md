# Connect your coding agent

Snagset speaks [MCP](https://modelcontextprotocol.io), so a coding agent can
read the comments left on your site. "Fix the pin on the PDP" becomes a task the
agent can start — instead of a screenshot pasted into a chat window.

It works with Claude Code, Claude Desktop, Cursor, and anything else that speaks
MCP.

## 1. Mint a token

On the dashboard: **Studio › Integrations › MCP › New token…**. Name it for the
agent that will hold it, choose a site or all of them, tick the scopes, and it
is shown **once** — beside the `claude mcp add` line and the `mcpServers` JSON
for Cursor, Claude Desktop and the rest, both copyable, so a 51-character
secret is never retyped. The same card lists every token by name, by the first
eight characters, and by what it may do in words, and revokes it.

A studio **member** mints theirs from **You › Your agent tokens** instead, and
sees and revokes only their own; owners and admins see every token in the
studio, and the owner can revoke any of them. A member may tick every scope:
none of them reaches past what a member can do, because an agent never
resolves, assigns, makes a thread team-only or deletes, whoever minted it.

Or on the machine running your instance:

```bash
snagset mcp-token create "Claude Code"
```

```
  snagmcp_PxQAYZv7_dPJxW8A7EcXsGg5xs6d5iZrplGyPAwM6yt-zhQblYL8

  Shown once — only its hash is stored.
  scopes: threads:read, source:map
```

**Read the "shown once" literally.** Only a hash is stored, so a lost token is
revoked and replaced, never re-displayed — from the card, or:

```bash
snagset mcp-token list
snagset mcp-token revoke PxQAYZv7
```

This is not your API key, and the two are not interchangeable. An API key is a
server-to-server credential for CI with no notion of scopes or a write budget,
and handing one to a program that reads text typed by strangers and then writes
is the wrong trade.

## 2. Point your client at it

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

For Claude Code, that file is `.mcp.json` in your project. For Claude Desktop it
is `claude_desktop_config.json`. Cursor uses `.cursor/mcp.json`.

**Start your client from your checkout.** `map_thread_to_source` searches the
directory it was launched in; `SNAGSET_MCP_REPO_ROOT` overrides that if you need
it to.

## 3. Ask it something

> Which snags are open on /checkout?

> Read SN-14, find the component, and tell me what is wrong.

## The tools

| Tool | Scope | What it does |
|---|---|---|
| `list_threads` | `threads:read` | What is broken, where, in which state |
| `get_thread` | `threads:read` | One snag's full conversation |
| `get_thread_context` | `context:read` | Browser, viewport, console breadcrumbs |
| `map_thread_to_source` | `source:map` | Search your checkout for the element |
| `comment_on_thread` | `comments:write` | Reply, as the agent |
| `mark_ready` | `threads:write` | Move a snag to "ready for review" |

**There is no tool that resolves a thread.** An agent can propose, never
dispose — whoever reported a snag decides when it is fixed. Editing or deleting
somebody's comment does not exist either.

## Scopes

The token you just minted is **read-only**, plus local source mapping. That is
deliberate. To let the agent write, tick the write scopes when minting on the
dashboard, or from the CLI:

```bash
snagset mcp-token create "Claude Code" threads:read,source:map,comments:write,threads:write
```

| Scope | Grants |
|---|---|
| `threads:read` | list and read threads, comments, anchor state |
| `context:read` | capture context, breadcrumbs, why a screenshot is missing |
| `source:map` | search the local checkout |
| `comments:write` | post a reply as the agent |
| `threads:write` | mark a snag ready for review |

`context:read` is separate from `threads:read` on purpose. Breadcrumbs and
capture context are the part that can carry personal data, and an agent that
only needs "what is broken and where" should not be handed a console log.

An agent's reply is attributed to the agent — a guest reviewer carrying the
token's name, never a verified human. Your client sees "Claude Code said…", not
a person who did not say it.

## What to think about before granting a write scope

Anyone who can load your site can type a comment. While a site is `open` (the
default, until you switch it to link-required) that is anyone at all. Your agent
then reads that text with access to your repository.

Everything Snagset returns is wrapped in `<untrusted-content>` tags and preceded
by a statement telling the model it is reading data rather than instructions.
That reduces how often a model follows injected text. **It does not eliminate
it, and nothing can.**

So the controls that matter are the ones that hold when the model *is* fooled:

- **No execution.** No shell tool, no file-write tool, no fetch tool. Source
  mapping searches inside your repo root and returns matched lines — never
  surrounding file contents, never a path outside the root, never through a
  symlink.
- **A write budget the agent cannot argue with.** Twenty writes per ten minutes,
  enforced by the server. An agent talked into "resolve every thread" hits a wall
  on the twenty-first and has to tell you.
- **Read-only by default**, which is why the first token above has no write scope.
- **A revocable token with an audit trail.** Every agent write lands in `events`
  with the token id, so "what did the agent do on Tuesday" is one query, and
  turning it off is one `revoke`.

If that is not enough for what you are working on, the answer is not to issue a
write scope.

## Remote — an agent with no checkout

Everything above runs the MCP server on your own machine, where the checkout
is. An agent that is somewhere else — hosted, a CI job, a colleague's laptop
that never cloned the repo — can talk to your instance directly instead, at
`POST /mcp`, with the same token as a bearer:

```bash
claude mcp add --transport http snagset https://review.example.com/mcp \
  --header "Authorization: Bearer snagmcp_…"
```

The token dialog shows this beside the stdio config whenever it is available.
Two things are different there, both on purpose:

- **No source mapping.** There is no checkout on the server to search, so the
  tool is absent rather than present and failing.
- **Writes need a token minted with "may write over the remote transport".**
  Reading is the same as stdio; a write from a machine you cannot see is a
  decision you make per token, and the dialog offers it as a tick, off.

**It is off until an owner turns it on.** The switch is on the MCP card, at
Studio › Integrations › MCP, above the tokens; it counts from the next request,
no restart. An endpoint an agent can reach is a surface, and turning one on
should be a decision someone can see. If the deployment should decide instead,
set `SNAGSET_MCP_HTTP_ENABLED` in the instance's environment — to `true` or
`false` — and the switch shows that state and says so.

## It is not a second API

The MCP server holds no database connection. Every read goes through the same
`/api/v1` routes with the same authorisation as any other caller, so a bug in it
cannot read a thread its token could not already read. It runs on your machine,
talks to your instance, and stores nothing.
