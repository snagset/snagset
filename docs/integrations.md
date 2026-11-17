# Integrations

A comment becomes work somewhere else. Five cards on Studio › Integrations —
your coding agent first, then GitHub, Linear, Jira and Slack — connect a site
to that somewhere, and every one of them is a token you paste, not an app you
register: the setup story a self-host can finish in a few minutes.

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
the health the worker last saw, and whether the tracker's webhook has been
heard from. Tokens are stored encrypted with the instance's key and never come
back to the screen.

## How connecting works

GitHub, Linear and Jira connect in three steps, in one dialog:

1. **Access.** Paste the key the tracker gives you. It is checked straight
   away, and the answer lists what it can see. The eye beside the field shows
   what you pasted.
2. **Connect.** Pick the repository, team or project from that list — no key
   to type. Choose whether every new comment opens an issue (off by default:
   you make one from a comment's brief when you mean it).
3. **Way back.** The webhook that lets a change in the tracker move the
   comment here. The dialog shows the address and the secret side by side,
   and a line that turns into a tick when the tracker's first delivery
   arrives — or says, in words, why it was refused.

You can skip step 3 and come back to it: **Webhook…** on a connected site
opens it again. The card always says when the last delivery arrived.

## GitHub

**1. Access — a fine-grained token.**

1. Open GitHub › Settings › Developer settings ›
   [Fine-grained tokens › Generate new token](https://github.com/settings/personal-access-tokens/new).
2. *Repository access:* only select repositories → the site's repository.
3. *Permissions › Repository permissions › Issues:* Read and write.
4. Generate, copy the token (`github_pat_…`), and paste it into step 1.

**2. Connect.** Pick the repository. One the token can only read is marked:
it needs *Issues: read and write* to open issues. Labels are optional and go
on every issue Snagset opens.

**3. Way back.** Snagset makes the webhook secret and shows it once.

1. Open the repository's *Settings › Webhooks › Add webhook* (the dialog
   links straight to it).
2. *Payload URL:* the address from the dialog. *Content type:*
   `application/json`. *Secret:* the secret from the dialog.
3. *Which events:* "Let me select individual events" → tick **Issues** only.
4. Add webhook. GitHub sends a test delivery at once, and the dialog ticks.

**What happens:** "Create GitHub issue" on the brief makes the issue with the
brief as its body and your labels on it. Resolving here closes it as
completed; reopening here reopens it. Closed on GitHub resolves the comment
here, reopened opens it, deleted detaches the link. Lost the secret? **Make a
new secret** in the webhook dialog, and paste it into GitHub's webhook; the
old one stops working at once.

## Linear

**1. Access — a personal API key.**

1. Open Linear › Settings ›
   [Security & access](https://linear.app/settings/account/security).
2. Under *Personal API keys*, make a new key. It acts as you, so you must be a
   member of the team the issues go to.
3. Copy it (`lin_api_…`) and paste it into step 1.

**2. Connect.** Pick the team. The key in brackets is the prefix on the team's
issues — the `ENG` in `ENG-123`.

**3. Way back.** Linear makes this secret, not Snagset.

1. Open Linear › Settings › [API](https://linear.app/settings/api) ›
   Webhooks › *New webhook*.
2. *URL:* the address from the dialog. *Team:* the team you picked.
   *Data change events:* tick **Issues**. Create.
3. Linear shows a *signing secret*. Copy it — with the copy icon, so nothing
   is cut off — and paste it into the dialog's *Signing secret*, then Save.
4. Move any issue in the team to another status once. The dialog ticks.

A wrong paste shows as "signed with a different secret". Paste the right one
over it: it is replaced in place, no disconnecting.

**What happens:** the issue is made in the team's state that matches the
comment's status, by type: completed, started, unstarted. Our status moves it
between those states the same way, and a state change in Linear moves the
comment here. A removed issue detaches the link.

## Jira

**1. Access — an API token with your email.**

1. Open your Atlassian account ›
   [Security › API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. *Create API token* — the plain one, not "with scopes". Name it Snagset and
   pick an expiry.
3. Copy it at once: Atlassian shows it once. In step 1, give your Jira
   address (`https://yours.atlassian.net`), the email you sign in with, and
   the token.

**2. Connect.** Pick the project. Jira now calls projects *spaces* and shows
the name first; the key in brackets — `KAN` in `KAN-12` — is the one that
matters, and is why a project named after your studio is often `KAN`. A
*Task* issue type is chosen where the project has one.

**3. Way back.** Jira takes any secret, so Snagset makes one and shows it
once — nothing to invent.

1. Open Jira › Settings › System › *WebHooks* (the dialog links straight to
   it). It needs a Jira admin.
2. *Create a WebHook.* *URL:* the address from the dialog. *Secret:* the
   secret from the dialog.
3. Under *Issue*, tick **updated** and **deleted**. Leave JQL empty, or limit
   it to the project. Create.
4. Move any issue in the project once. The dialog ticks.

**What happens:** the issue is made with the brief as its description, in
Jira's own wiki format with its specials escaped. Our status moves it through
the project's workflow by **status category**: resolved goes to a done status,
in progress to an in-progress one, open and in review to a new one. A workflow
that offers no such transition is reported on the card rather than guessed. A
status change in Jira comes back the same way; a deleted issue detaches.

## Slack

**You need:** a bot token from an app you create from our manifest, and a
channel.

1. **Create app…** in the dialog opens Slack with the app's name and scopes
   filled in. Pick your workspace and create it.
2. *Install to workspace*, allow, then copy the *Bot User OAuth Token*
   (`xoxb-…`) from *OAuth & Permissions*, and paste it into the dialog.
3. The channel, by `#name` or id. A private channel needs the app invited
   first: `/invite @Snagset` in the channel.

**What happens:** one message per comment, posted by default for every new
comment (Slack is where people are told, so this one is on unless you turn it
off), or "Post to Slack" from the brief. The message carries the comment, the
page, the reviewer, the environment, and two buttons: open in Snagset, open the
page. As the status moves, the **same message is edited** — never a second
message, never a reply.

Slack sends nothing back in this version.

## MCP

The first card is for an agent rather than a tracker: it mints the token a
coding agent presents, shows it once beside the config that uses it, and
revokes it. It also holds the switch for the remote transport — the same
server at `POST /mcp`, for an agent with no checkout — off until an owner turns
it on, unless the environment decided (`SNAGSET_MCP_HTTP_ENABLED`). The
[MCP page](mcp) covers the tools, the scopes and what to think about before
granting a write.
