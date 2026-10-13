# Try it on any page

Before you install anything, you can see what the widget does on a page you do
not control — your own site, a client's live site, this one.

## The bookmarklet

Drag this to your bookmarks bar, or make a new bookmark with this as the URL:

```js
javascript:(function(){var s=document.createElement('script');s.src='https://review.example.com/snag.js';s.setAttribute('data-snag-site','prj_…');document.head.appendChild(s);})()
```

Replace the URL with your instance and the uid with your site's. The dashboard's
**Sites** screen prints a ready-made one.

Click it on any page and the toolbar appears. Press **Alt + C** to start
commenting.

## What this is good for

- **Seeing it work** before you ask a client to paste anything
- **A site you cannot edit yet** — a CMS you have no access to, a build you are
  waiting on
- **Checking a production page** where the tag is deliberately switched off

## What it is not good for

**Your client.** A bookmarklet is a thing you have to explain, and the whole
premise here is that reviewing costs your client nothing to learn. Send them a
review link to a page carrying the tag.

It also cannot work everywhere. A site with a strict
`Content-Security-Policy` will refuse to load a script from another origin —
which is correct of it, and is exactly the case the same-origin install exists
to solve.

## The origin still has to be allow-listed

The bookmarklet loads the widget, but the widget still has to talk to your
server, and your server only accepts the addresses on the site's allow-list.

If nothing happens after you comment, that is why:

```bash
snagset allow-origin prj_… https://the-site-you-are-on.com
```

Or add it on the **Sites** screen. This is the single most common reason a
correct-looking install does nothing — see [kill switches](kill-switches) for
the others.
