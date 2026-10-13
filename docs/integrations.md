# Integrations

A comment becomes work somewhere else. Five cards on Studio › Integrations
connect a site to that somewhere, and every one of them is a token you paste,
not an app you register — the setup story a self-host can finish in a minute.

Three rules hold across all of them.

- **Your status is canonical.** A mirror is moved by *state type* (open or
  closed, a workflow state's type, a Jira status category), never by a state's
  name, and a change on the other side comes back the same way. Nothing
  echoes: a change that arrived from GitHub is not sent back to GitHub.
- **One issue per comment per tracker.** Ask twice and you get the same issue.
  A comment can be in GitHub, Linear and Jira at once.
- **A reviewer's words cannot act.** The issue body, the Slack message and the
  brief are the same text, and every reviewer-typed field is escaped for the
  destination: no `@channel`, no `@mention`, no `#123` that resolves, no HTML,
  no wiki markup. A client's comment is quoted, never executed.

Connecting is per site. Each card lists the sites it is connected on, when
issues are made — from the brief when you ask, or one for every new comment —
and the health the worker last saw. Tokens are stored encrypted with the
instance's key and never come back to the screen.

## GitHub

**You need:** a fine-grained personal access token with *Issues: read and
write* on the one repository. It is checked against the repository before it is
saved.

**What happens:** "Create GitHub issue" on the brief makes the issue with the
brief as its body and your labels on it. Resolving here closes it as completed;
reopening here reopens it.

**The way back:** after connecting, the card shows a payload URL and a secret,
once. Add a webhook to the repository — Settings › Webhooks › Add webhook —
with that URL, content type `application/json`, that secret, and *Issues*
events. Closed resolves the comment here, reopened opens it, deleted detaches
the link. "Webhook…" on the card mints a new secret and retires the old one.

## Linear

**You need:** a personal API key from Linear › Settings › API, belonging to a
member of the team, and the team's key — the `ENG` in `ENG-123`. Both are
checked against the team before anything is saved.

**What happens:** the issue is made in the team's state that matches the
comment's status, by type: completed, started, unstarted. Our status moves it
between those states the same way.

**The way back:** in Linear › Settings › API › Webhooks, create a webhook for
the team with the URL the card shows and *Issue* events, and paste its signing
secret when connecting. A state change in Linear moves the comment here; a
removed issue detaches the link.

## Jira

**You need:** the site's URL, the project's key — the `KAN` in `KAN-12` — and
an API token from id.atlassian.com › Security with the email of the account it
belongs to. That is what Atlassian gives a self-hoster without a Marketplace
listing. A *Task* issue type is chosen at connect where the project has one.

**What happens:** the issue is made with the brief as its description, in
Jira's own wiki format with its specials escaped. Our status moves it through
the project's workflow by **status category**: resolved goes to a done status,
in progress to an in-progress one, open and in review to a new one. A workflow
that offers no such transition is reported on the card rather than guessed.

**The way back:** in Jira › Settings › System › Webhooks, create one with the
URL the card shows, the events *Issue updated* and *Issue deleted*, and a
secret; paste the same secret when connecting.

## Slack

**You need:** a bot token from an app you create from our manifest — the
"Create app…" button opens Slack with the scopes filled in — and a channel, by
`#name` or id. A private channel needs the app invited first.

**What happens:** one message per comment, posted by default for every new
comment (Slack is where people are told, so this one is on unless you turn it
off), or "Post to Slack" from the brief. The message carries the comment, the
page, the reviewer, the environment, and two buttons: open in Snagset, open the
page. As the status moves, the **same message is edited** — never a second
message, never a reply.

Slack sends nothing back in this version.

## MCP

The fifth card is for an agent rather than a tracker: it mints the token a
coding agent presents, shows it once beside the config that uses it, and
revokes it. It also holds the switch for the remote transport — the same
server at `POST /mcp`, for an agent with no checkout — off until an owner turns
it on, unless the environment decided (`SNAGSET_MCP_HTTP_ENABLED`). The
[MCP page](mcp) covers the tools, the scopes and what to think about before
granting a write.
