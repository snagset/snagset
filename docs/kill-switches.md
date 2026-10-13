# Kill switches, automation and E2E tests

Snagset is on somebody's real site. Every way of turning it off is here, and
each one is a single thing you can do without a deploy.

**They are all silent.** A gated page installs no toolbar, binds no hotkey,
loads no chunk and prints nothing to the console. A visitor cannot tell the
difference between a site with Snagset switched off and a site without Snagset.

## Turn it off for everyone

**Delete the tag.** That is the whole uninstall. Nothing is left behind — no
service worker, no cookie, no local storage on anyone's machine.

Or leave the tag and switch it off:

```html
<script src="…/snag.js" data-snag-site="prj_…" data-snag-disabled defer></script>
```

**Presence means off.** `data-snag-disabled="false"` still turns it off, the
same way `<input disabled="false">` is still disabled. That is HTML's rule and
copying it is safer than inventing a second one.

## Turn it off for one person, or one page load

Add `?snag_off` to the URL:

```
https://staging.acme.com/checkout?snag_off
```

The same switch also reads a `snag_off` cookie, so a developer who wants it gone
for the rest of the day sets that once instead of editing every URL.

## Only run where you mean it

```html
<script … data-snag-mode="auto"></script>
```

| `data-snag-mode` | Behaviour |
|---|---|
| `auto` *(default)* | The dashboard decides: the toolbar shows when review is open on this site, for link holders and returning reviewers otherwise — except where `data-snag-env="production"`, which needs a link or a prior visit |
| `on` | Always runs, whatever the dashboard says — an override, not the normal path |
| `off` | Never runs |

`auto` is the default because the common mistake is shipping the staging tag to
production by accident, and the safe answer to that is a widget that declines to
appear. Someone holding a review link still gets it — that is the case where you
*want* review on the real site.

You can also restrict by origin, from the page rather than the tag:

```html
<script>
  window.SnagsetConfig = { allowedOrigins: ["https://staging.acme.com"] };
</script>
```

A page served from anywhere else installs nothing.

## Your E2E tests

**This one is on by default and you probably want it.** A review widget that
binds a capture-phase hotkey and puts a toolbar over the page will eventually
break somebody's test suite, so Snagset refuses to run under automation:

| Detected by | Set by |
|---|---|
| `navigator.webdriver` | Playwright, Puppeteer, Selenium, WebDriver |
| `window.Cypress` | Cypress |
| a Cypress `window.opener` | Cypress, seen from a window it spawned |

Cypress is checked separately because **it sets nothing standard** — it runs
your app inside an iframe in its own runner. A client running Cypress against a
staging deployment carrying `data-snag-mode="on"` had a live review widget
intercepting their clicks, which is how that check came to be three checks.

To test the widget itself, opt back in:

```html
<script … data-snag-allow-automation></script>
```

## For your CI build

Nothing in this product needs a build step, so there is nothing to strip. If you
inject the tag from a template, the ordinary conditional is enough:

```jsx
{process.env.NEXT_PUBLIC_SNAGSET_ENABLED === "true" && (
  <Snagset host="https://review.example.com" site="prj_…" />
)}
```

That variable is **yours**, set on your build. Snagset's own server will not
accept it and does not read it — it is named in the config registry only so
that the boot validator knows to leave it alone.

## For a Playwright suite that must be certain

```js
await page.addInitScript(() => { window.__SNAGSET_DISABLED__ = true; });
```

This runs before any page script, so it beats the tag whatever the tag says.
It is the switch to reach for when you cannot change the HTML and cannot rely on
`navigator.webdriver` — a hosted preview, or a page you do not control.

## Every switch, in order

The first one that matches wins. They are checked before anything touches the
DOM, so a gated page never loads the runtime at all.

| Order | Switch | Where |
|---|---|---|
| 1 | `window.__SNAGSET_DISABLED__` | a script that runs first |
| 2 | `window.SnagsetConfig.disabled` | the page |
| 3 | `data-snag-disabled` | the tag |
| 4 | `?snag_off` | the URL |
| 5 | `snag_off` cookie | the browser |
| 6 | automation detected | Playwright, Cypress, Selenium |
| 7 | `data-snag-mode="off"` | the tag |
| 8 | `mode="auto"` on production, no review link and never reviewed here | the tag |
| 9 | `SnagsetConfig.allowedOrigins` excludes this origin | the page |
