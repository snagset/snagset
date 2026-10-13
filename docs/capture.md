# What gets captured — and what never does

Snagset runs on your client's real site, sometimes on production. This page is
the whole of what leaves the browser, and it is written so you can hand it to a
security team without editing it.

## What a comment carries

When somebody clicks and types, one thread is created with:

- **Their text**, and their name if they gave one
- **Where they clicked** — a description of the element, plus a proportional
  offset so the pin lands in the right place at a different window size
- **The page** — URL, route, and viewport size
- **The browser** — a coarse name and version, platform, whether it is a touch
  device, and light or dark preference
- **A screenshot**, if you have configured a bucket
- **Recent console errors and network failures** — see breadcrumbs below

That is the list. There is no session recording, no mouse tracking, no keystroke
log, no heatmap and no analytics of any kind.

## The visitor who does not comment

**One small request, and nothing about them in it.** On load, the tag asks your
Snagset instance a single question — *is review open on this site?* — a ~300
byte GET, cached for a minute, carrying no cookies and nothing about the
visitor. If review is closed, that is the whole cost. No beacon, no font, no
error report, no analytics, and nothing a visitor does is ever sent unless they
themselves open the toolbar and comment.

The request goes to **your** server, which stores nothing about it — there is
no visitor log to keep. A tag with no `data-snag-site` (the demo mode) makes no
request at all.

This is checkable rather than promised: open the network tab on a page carrying
the tag — one `config` fetch, then silence.

## Redaction, before anything is stored

Everything captured runs through a redactor **in the browser**, before it is
sent. What it removes:

| | |
|---|---|
| Anything under a sensitive key name | `password`, `token`, `secret`, `authorization`, `api_key`, and the rest |
| Email addresses | in any captured string |
| JWTs, API keys, bearer tokens | by shape, including vendor prefixes |
| Long hex, base64 and base64url blobs | session ids, hashes, encoded payloads |
| `data:` URLs | which can carry an entire file |
| Credentials inside a URL | `https://user:pass@host` |
| Any string over 120 characters | too long to be a label, so treated as a payload |

Values are replaced, not truncated — a redacted field says it was redacted.

The list is deliberately over-eager. A false positive costs you a breadcrumb
that says `[redacted]`; a false negative puts a live session token in a comment
thread and then in an issue tracker.

## Screenshots

Only if you have configured a bucket. **With no bucket you get annotation
mode** — everything above except the picture — and the widget tells the
reviewer screenshots are unavailable rather than offering one that fails.

These are painted over before the image is encoded, always, with no
configuration:

```
input[type="password"]
input[autocomplete*="password" i]
[autocomplete*="cc-" i]
[autocomplete="one-time-code"]
input[type="email"]
input[type="tel"]
```

The `i` is case-insensitivity — `autocomplete="CC-Number"` is masked too.

Plus anything you mark:

```html
<div data-snag-mask>…</div>
<div class="snag-mask">…</div>
<div class="snag-block">…</div>
```

`data-snag-mask-selectors` adds your own. **Your selectors add to the built-in
list; they never replace it** — a config that shortens the list would be a
config that undresses a password field, so it cannot.

To mask every field on the page, set `data-snag-screenshots="mask-all"`, which
adds `input`, `textarea`, `select` and `[contenteditable]`.

Each screenshot records **how many elements were masked**, so a reviewer looking
at a picture with grey boxes in it knows they are deliberate.

## Breadcrumbs

The last few console errors and failed network requests, so that "the button
does nothing" arrives with the `TypeError` that explains it.

- **Errors and warnings only.** `console.log` is not collected.
- **Redacted** by the same pass as everything else.
- **URLs, statuses and timings** for failed requests — never request or response
  bodies.
- Capped, and the oldest fall off.

Breadcrumbs are the part most likely to catch something personal, which is why
they sit behind their own permission on an agent token and are not handed out
by default.

## What is never collected, in any mode

- Cookies, `localStorage`, `sessionStorage`
- Request or response bodies
- Keystrokes, mouse movement, scroll paths, dwell time
- Anything from a page where the widget did not activate
- Any raw IP address — the server stores a salted hash, and the salt is
  per-project

## Where it goes

**Your server.** That is the whole answer. The widget talks to the instance it
was served from — or the one named in `data-snag-host` — and to nothing else. No
analytics endpoint, no error reporter, no CDN. There is no telemetry, and the configuration variable that
would enable it exists only so the boot validator can refuse to turn it on.

## What your CSP has to allow

One directive:

```
script-src 'self'
```

That is the whole change, and only if your policy does not already permit
same-origin scripts. The widget is served by your own instance and talks back
to that same origin, so there is no third party in the picture; its styles live
inside a shadow root, so no `unsafe-inline` is needed for them.

It is worth knowing what the alternative costs, because the shape is common.
Vercel's Toolbar — a good product, built for a different job — asks for six
directives, including a third-party websocket and inline styles:

```
script-src  https://vercel.live
connect-src https://vercel.live wss://ws-us3.pusher.com
img-src     https://vercel.live https://vercel.com data: blob:
frame-src   https://vercel.live
style-src   https://vercel.live 'unsafe-inline'
font-src    https://vercel.live https://assets.vercel.com
```

*(Their documentation, read 2026-08-27.)* That is not carelessness — their
comments UI runs in an iframe carrying a vercel.com session, and each directive
follows from that. It is the bill for an architecture where the review tool is
somebody else's service. Ours is yours, which is why the bill is one line.

## Blind spots, stated

A screenshot is a render of the DOM, not a photograph of the screen: the
widget redraws what is on screen from each element's computed styles, since
the page's own stylesheet files cannot be loaded inside the redraw. It cannot
see:

- `<iframe>` content from another origin
- WebGL that clears its canvas after each frame (a plain 2D `<canvas>` is
  copied in; a WebGL one usually reads back empty and is marked instead)
- Video frames
- Anything drawn by a browser extension

Images from another domain are not on that list. The browser only lets a page
copy an image's pixels when the image's server allows it with CORS headers,
and plenty of CDNs and site builders do not. So the widget asks the image's
server first, and when that is refused it asks your Snagset server, which
fetches the image itself — no browser rule applies there — and hands it back.
Nothing for the reviewer to accept, and nothing to configure. The server only
does this for a review session on that site, only for images on the public
internet (never `localhost` or a private network), up to 10 MB each. An image
that still cannot be fetched — one behind the reviewer's own login, say — is a
grey placeholder, counted once in the screenshot's notes.

Where these are on the page, the capture **records that it could not see
them** and the reviewer is told. An honestly incomplete screenshot is worth more
than one that quietly omits the part somebody was pointing at.
