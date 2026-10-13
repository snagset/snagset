# What Snagset is (and is not)

Your client says the spacing is wrong on the pricing page. You get a screenshot
in WhatsApp, cropped, with an arrow. You spend twenty minutes finding out which
page, which breakpoint, which browser.

Snagset is a `<script>` tag that makes them click the thing instead.

## What it is

**Click-to-comment on a live website.** Not a mockup, not a staging clone — the
real site, in their real browser, at their real window size. They press
**Alt + C**, click, and type. You get a pin on the element, a screenshot, the
route, the viewport, the browser, and any console errors from the last few
seconds.

**A dashboard you host, holding as many client sites as you have clients.** Each
gets its own uid, its own review links, its own rounds.

**One script tag, or one npm import.** No proxy, no DNS change, no build step.
Deleting the tag deletes the tool, completely.

**Yours.** AGPL, self-hosted, one required environment variable. There is no
crippled open-source edition and no feature that lives only in a paid tier.

## What it is not

**Not session recording.** No mouse tracking, no keystroke logging, no
heatmaps, no replay. A visitor who never opens the toolbar generates *no network
request at all*.

**Not analytics.** Nothing is counted, nothing is reported, and the config
variable that would turn telemetry on exists only so the server can refuse it.

**Not a bug tracker.** It is the step before one. Threads have four statuses and
that is deliberately all — no assignees-with-workflows, no sprints, no burndown.
Push it to GitHub, Linear or Jira when a snag becomes work, and let Slack know — see [integrations](integrations).

**Not a design tool.** No comments on Figma frames. The whole premise is that
the artefact is the running site.

**Not a chat widget.** Your client's customers never see it. It appears for
people you gave a link to, and on production it stays hidden unless somebody
arrives holding one.

**Not React-only.** This is the difference worth knowing about: because the core
is a script tag, it works on WordPress, Webflow, Shopify, Rails, Craft, Kirby
and anything else that can render HTML. The React, Vue and Astro packages are
convenience over the tag, never a replacement for it.

## Who it is for

A studio or a freelancer with clients who are not technical, reviewing sites
that already work. If your reviewers are engineers who will happily open your
issue tracker, you may not need this.

## How much it costs to run

A Postgres and a small Node process. On a hobby-tier Neon and a free Vercel
plan, a handful of client projects costs nothing per month. Screenshots want an
S3-compatible bucket; that is the only line item, and it is optional — without
one you get *annotation mode*, which is everything except the picture.

## The honest limits

- **No screenshots without a bucket.** The widget says so rather than offering
  one that fails.
- **Cross-origin iframes cannot be reached.** Browser rule, not ours.
- **Anchoring is not magic.** A pin whose element is genuinely deleted orphans,
  keeps its thread, and moves to the list. [How anchoring works](anchoring)
  explains what you can do in your markup to make it rarely happen.
- **Self-hosting is community supported.** No inbox, no SLA. The source is
  public and so is the issue tracker.

## Next

- [Quickstart](quickstart) — the tag, on a page, in a minute
- [Install and run it yourself](self-hosting) — `npx create-snagset`
- [What gets captured](capture) — the page to hand a security team
