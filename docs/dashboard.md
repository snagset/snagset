# The dashboard

The widget is where a client leaves comments. The dashboard is where your studio
works through them. It is served by your own instance, on the same address as
the widget, and it is built around two nouns: **sites** and **comments**.

## Sites

The home screen is your sites, one card each, with how many comments are open
and when something last happened. Add a site with its name and its **domain**:
every subdomain, scheme and port of that domain may run the widget, and
`localhost` always may, so staging, previews and your own machine work without
a second thought. Exact addresses elsewhere can be added in the site's settings
as "Also allowed".

A new studio starts with the first run: name a site, give it its domain, see
the tag to paste. No site ready yet? **Skip for now** leaves it, and Sites opens
empty; add one there when it is.

Each site has three screens of its own: **Comments**, **Reviewers** and
**Settings**.

## Comments

The list is grouped by the page the comment was left on. Everything about the
view is in the URL, so any view is a link you can send to a colleague: the
round, the status chips, the page, the search, the sort, the assignee filter.

**Rounds.** You see one round at a time; the menu at the top switches between
them or starts another. Rounds run side by side — your own QA pass can stay
open while the client's runs — and starting one closes none of the others.
Comments do not follow you into a new round, and the screen keeps a line
saying how many are unresolved in the rounds you are not looking at, so a
clean board is never a lost board. A comment filed in the wrong round can be
moved: tick it (or open it) and choose **Move to round…**. It keeps its key,
so links to it still work, and takes the next number in the round it moves
to. Owners and admins can move comments, into an open or a closed round but
not an archived one.

**The brief.** Open a comment and the right-hand panel is the brief: what was
said, the element it was left on, the page, the environment, the browser, and
the breadcrumbs behind a disclosure. **Copy as brief** puts the same thing on
your clipboard as Markdown, and it is the same text an agent gets over MCP and
the same text an issue is made from, so none of them can drift.

**Status** is four states, and that is deliberate: Open, In progress, In
review, Resolved. Change it on the brief, or tick several rows and move them at
once. **Assign** a comment to yourself, to someone in the studio, or to anyone
who has commented on the site; "Add a person" makes a placeholder for someone
who has not written yet. When the instance has mail, the person you assign is
emailed an hour later — not at once, so a burst of triage is one email, not
twelve: everything assigned to them in that hour arrives together, with each
snag's key, its first line and a link. If by then the snag has moved to someone
else, been resolved, or they have already replied or changed its status, it is
left out. Nobody is emailed for assigning something to themselves. A studio
member signed in from the widget can assign there too; everyone else sees who
holds a snag in its detail, read-only.

**Editing and deleting.** Each comment in the brief has a `⋯` menu. **Delete**
is on every comment, yours or a client's: the text is removed and the comment
stays in the conversation as "Comment deleted" under its author's name, so the
replies around it still make sense. **Edit** is only on your own comments —
the studio can remove what a client said, but never rewrite it under their
name. The bin at the top of the brief **deletes the whole thread**: it goes
from the list, the board, Activity and the widget for everyone, along with its
screenshot, and any notification still waiting to be sent is dropped. Issues
already made in GitHub, Linear, Jira or Slack are left where they are.

**Keys.** `j` and `k` move down and up through what is on screen, `e` resolves
the one you are on (and puts it back), and `⌘K` opens a palette that goes to
any site or screen and searches every comment on every site by its words.

**The board.** A chip turns the list into four columns, one per status, and a
card dragged between them changes its status. It is a view, not the default,
and it lives in the URL like everything else.

## Activity

Every site in one column, newest change first, each line naming its site and
carrying the words that were last written. It answers "what happened" the way
Sites answers "how many are open". The default shows what still needs
attention; **Resolved** is the archive, one chip away, and nothing new had to
be invented to hold a comment that is done.

## Reviewers

A review link is how a client gets in: a name, what the holder may do, an
expiry. Mint one here, and it is shown **once** — copy it then, because only
its hash is kept. Revoke it here too, and everyone holding a session from it is
signed out within seconds. The [identity page](identity) explains the model.

You and your studio need no link: on the site itself, the comment box's
**Studio member? Sign in** signs you in with this dashboard's account, so what
you write there is yours, under the same name as your replies here.

## Site settings

The name, the domain and the addresses beside it, who may comment (anyone who
loads the page, or only people with a link), the install tag, and the **widget
switch**: paused, the widget disappears from the site while your triage goes
on. Deleting a site asks you to type its name.

**Guests can change status** is on by default: people who comment without an
account or a review link can move a comment between Open, In progress, In
review and Resolved. Turn it off and they see the status but cannot change it —
at once, including anyone already on the page. Owners and admins can change
it. Review links keep their own permissions either way.

**Rounds** are managed here too, newest first, each with its number, whether
it is open, closed or archived, and how many comments it holds. Owners and
admins can rename a round, close or reopen it, **archive** it — out of the
widget and the round menu, every comment kept, one click to restore — or
**delete** it, which removes the round and every comment in it with their
screenshots, after you type its name. The last open round cannot be closed,
archived or deleted: new comments need somewhere to go, so open another one
first.

## Studio

Behind the studio's name at the top of the sidebar.

The studio's name, top left, is a menu when you belong to more than one
studio, or when the instance lets you make another: every studio you are in,
the current one marked, and **New studio…** where it is offered.

**General** — the studio's name; the instance's version with a "check for
updates" that asks npm from your browser and never from the server; the
instance's **address**, which is what every review link, issue and email is
built from — kept from the moment you claimed the instance, and editable here
unless the environment set it; and two rows for what the instance is connected
to, **storage** (a bucket for screenshots, probed before it is stored) and
**mail** (a transport for notifications, proved with a test message). Secrets
never come back to the screen. How often the owner is emailed — a daily digest,
or one email per comment — is set in the environment with `SNAGSET_MAIL_NOTIFY`
(see [self-hosting](self-hosting#who-gets-email-and-how-often)).

**Members** — the people in the studio, by email, with a role. Owners manage
the members; admins see them. Both can connect sites to GitHub, Linear, Jira
and Slack, and mint their own MCP tokens — an admin can revoke the tokens they
made, the owner anyone's, and removing a member revokes theirs. People join through an **invite link**: an owner
presses **Invite**, picks a role and, if they like, the person's email, and
gets a link to send. Whoever opens it chooses their own name and password and
lands signed in — nobody chooses a password for somebody else. A link works
once, lasts seven days, and is shown only when it is made; lost, it is revoked
from **Pending invites** on the same page and made again. Given an email, only
that address can use it, and when the instance has mail connected (Studio ›
General) the dialog can send it there; with no mail, copy the link and send it
however you like. Someone who already has an account on this instance — in
another studio — joins with that account's password and gets the studio
added to their switcher. There is no reset email: a forgotten password is
set again from the server's shell, `printf '%s' "$NEW" | snagset passwd
them@example.com`, which signs out every session that account had.

**Integrations** — one card per provider: GitHub, Linear, Jira, Slack and MCP.
The [integrations page](integrations) covers each; the MCP card also holds the
switch for the remote transport, which the [MCP page](mcp) covers.

**You** — your name, your password, and the theme.
