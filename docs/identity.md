# Identity: guests, review links, and your own users

Nobody signs up to leave a comment. That is the point of the product, and it is
also the thing that needs explaining, because "no account" and "no access
control" are not the same sentence.

## The three kinds of person

| Kind | How they got in | Named |
|---|---|---|
| **guest** | Typed a name, or nothing | By what they typed |
| **link** | Opened a review link you sent | By the name on the link |
| **verified** | Your own application vouched for them | By your user record |

Plus **you** — the studio. That is a real account with a password, on the
dashboard, and it is a completely separate system: different table, different
credential, different origin, different lifetime. A reviewer credential can
never become a dashboard credential, because there is no code path between them.

## Who is allowed to comment

A per-site setting, and the default changes after a day:

| `write_mode` | Who can write |
|---|---|
| `open` | Anyone who can load the page |
| `link-required` | Only somebody holding a review link |
| `verified-only` | Only users your application vouches for |

A new site starts **`open` for 24 hours**, then falls back to
`link-required` on its own. That window exists so the first pin needs no
set-up — paste the tag, click, type — and it closes on its own so that a site
you set up and forgot is not a public comment box a year later.

`SNAGSET_WRITE_MODE_GRACE_HOURS` changes the window. Set it to `0` for
link-required from the first second.

The same setting decides who can **read** the comments. On an `open` site
anyone who loads the page sees them; on a `link-required` or `verified-only`
site only someone holding a link (or your application's identity) does — and
the studio, always.

## Review links

**The link is the access control.** There is no separate permission screen,
because a second system to keep in step with the links is a second system to get
wrong.

A link carries:

- **A name**, so comments are attributed without anyone typing one
- **What the holder may do** — six permissions, of which three are on by default
- **An expiry** — 14 days unless you say otherwise
- **Optionally a round**, so the link lands on the round you meant

Mint one on the dashboard — the site's **Reviewers** screen, where it is shown
once and can be revoked — or on the machine running your instance:

```bash
snagset link prj_… "Ana at Acme"
```

| Permission | Default |
|---|---|
| `thread:create` | ✅ |
| `comment:create` | ✅ |
| `thread:resolve` | ✅ |
| `thread:delete:own` | ✅ |
| `thread:private` | — |
| `thread:assign` | — |

Guests have no link to carry permissions, so they get the default set, and
whether that includes changing status is the site's choice: **Guests can
change status** in the site's settings, on unless you turn it off. It applies
to guests already on the page, not only the next ones — their next change is
refused, and the widget shows the status as read-only once it refreshes.

`thread:delete:own` lets a reviewer delete a snag they started, and only
while nobody else has replied to it — once someone has answered, deleting it
would take their words too. Their own replies they can always edit or delete;
everyone else's they cannot touch.

**Revoking is immediate.** It bumps the project's session epoch, so every
session minted from that link stops verifying on its next request — including a
tab that was already open, which is told it was signed out rather than quietly
dropping to read-only.

An unknown permission is **refused at creation**, not stored and ignored. A
permission that is silently dropped reads to the operator as "I granted it and
it did nothing".

## Sessions

A reviewer's credential is a short-lived signed token: **15 minutes sliding, 12
hours absolute.** It lives in memory on the client and is exchanged again when
it lapses. It is not a cookie, because the widget runs on somebody else's origin
where a cookie would be both useless and dangerous.

The link itself lives only in the **URL fragment** — after the `#` — so it is
never sent to your server, never lands in an access log, and never appears in a
`Referer` header. It is taken out of the address bar on arrival.

## Studio members on a client's site

You do not need a review link — or a made-up guest name — to comment on a
site you are building. In the comment box, choose **Studio member? Sign in**.
A small window opens on your dashboard; if you are not signed in there it asks
you to, then it asks once more: *Sign in to Acme on https://acme.com as you?*
Press **Continue** and the window closes. The comment box stops asking for a
name and an email and says **Commenting as** your name instead.

What you write from the widget is under the same author as your replies in the
dashboard, and you see what you see there — team-only threads included. Owners
and admins can also **delete anyone's comment or snag** from the widget, as
they can in the dashboard; nobody can edit somebody else's words, so a
client's comment is never rewritten under their name. The
sign-in is remembered by that browser — every tab of the site knows you — for
up to 12 hours, after which **Sign in** is one click again. **Not you? Sign
out** in the comment box ends it everywhere. Clients' sessions are not
remembered this way: theirs end with the tab, so a shared office computer
never keeps someone signed in.

Three things keep it safe on somebody else's page:

- **It only works on the site's own addresses** — its domain, its allowed
  origins, or localhost. The dashboard refuses to sign you in for any other
  page, so no other site can obtain your session.
- **It always takes a click.** Opening that window does nothing on its own;
  Continue is what signs you in.
- **Leaving the studio ends it.** A member who is removed is signed out of
  the widget within seconds; one made a viewer, within fifteen minutes, when
  the session next renews.

**No click at all when the site and the dashboard share a domain.** If your
dashboard is at `snagset.yourstudio.com` and the client's staging site at
`acme.yourstudio.com`, the browser treats the two as one site, and the widget
can ask your dashboard directly whether you are signed in. If you are, the
comment box already says **Commenting as** your name the first time you open
it, and the sign-in renews itself every 12 hours — always 12 for a sign-in
nobody clicked, even if you raise `SNAGSET_SESSION_ABSOLUTE_TTL_S`, since it
costs you nothing and keeps a session lifted from a compromised page short. It only happens on the
site's own addresses, only from a page on the dashboard's own domain (never a
shared host like `vercel.app`), and only for a member who is not a viewer.
Clients on the same staging site are simply not signed in to your dashboard,
so nothing changes for them. On a client's own domain (`acme.com`) the browser
will not share your dashboard's sign-in, and **Studio member? Sign in** is the
way in, as above. **Not you? Sign out** keeps you signed out in that browser
until you use **Sign in** again.

## Your own users (`verified`)

If your application already knows who is looking at the page, tell Snagset and
skip the link entirely. Your server signs a short HMAC over the user's id and
name with a shared secret; the widget presents it; a `verified` reviewer is
created or matched.

That is the tier with the moderation bypass, and the only one — which is why an
agent writing through MCP is **never** `verified`, whatever name its token
carries. It posts as a guest, flagged as an agent, traceable to the token that
made it.

## What a reviewer can never do

- See a site they were not given a link to
- See a thread marked team-only
- Reach the dashboard
- Add a site, mint a link, or change a setting
- Act on another project, even holding a valid credential for this one

Every one of those is checked on the server, per request. Absent CORS headers
stop a browser on another origin from reading a response; they stop nothing
else, which is a lesson this codebase learned by minting a review link with
`curl` against its own port.
