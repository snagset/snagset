import { captureStrings } from "./capture.ts";
import { en } from "./en.ts";
import { make } from "./format.ts";

/**
 * The strings only the PANELS chunk can render — the dock, the composer, the
 * detail, the export.
 *
 * Separate from en.ts for one reason, and it is a packaging reason rather than
 * an editorial one: a bundler cannot tree-shake properties out of an object
 * literal, so a single shared catalogue shipped every one of these inside
 * `snag.runtime.js` as well. That is the eager chunk — downloaded by every
 * reviewer who activates, whether or not they ever open a panel — and 1.6 KB of
 * copy it has no component to render was what pushed the activation envelope
 * past the normative 40 KB.
 *
 * Both rules from en.ts still apply and are not restated: no brand literal, and
 * no sentence assembled from fragments.
 *
 * A THIRD catalogue sits between this and en.ts — capture.ts — holding the keys
 * the dock and the Markdown serialiser BOTH render. The serialiser ships in
 * `snag.capture.js` (AC G5), and importing this file to reach eight export
 * strings pulled every dock and composer string in with them.
 */
export const panelStrings = {

  // ── The one-time disclosure — shown once per reviewer
  // project at the first pin, then never again; re-readable in settings/docs
  // rather than re-shown (the whole argument). Four sentences: the always-on
  // metadata, the console/network category in whichever state this project
  // configured, the screenshot truth for this release, and retention. The
  // "privacy notes" sentence is where the full what-can-still-leak list
  // lives; the docs task gives it a URL.
  "disclosure.title": "Before your first comment",
  "disclosure.always":
    "Each comment carries the page address, viewport size and browser make.",
  "disclosure.crumbs.on":
    "Recent console messages and network results ride along, recognisable secrets redacted first.",
  "disclosure.crumbs.off": "Console and network capture is off here.",
  "disclosure.screenshot.off": "Screenshots are off for this project.",
  // The A11 ACCURACY CORRIGENDUM, verbatim from 00 foundations — test-pinned
  // against the spec source. "blurred" is the corrigendum's own word even
  // though the mask is a solid block; ship the mandated sentence as-is
  // until A11 is amended (brief, conflict 3).
  "disclosure.screenshot.on":
    "{product} never reads what you type. Screenshots are pictures of the page, so anything visible on screen is in the picture — mark sensitive regions with {maskAttr} and they are blurred before the screenshot leaves your browser.",
  // TWO sentences, because there are two deployments and one of them was
  // being told the other's. With no server the widget really is a notebook in
  // one browser; with `data-snag-host` set, every comment is sent to that
  // server the moment it is posted. Showing the local sentence on a
  // server-backed install is not a wording slip — it is a privacy notice
  // stating the opposite of what happens, on the screen whose entire job is
  // to be accurate before someone types.
  "disclosure.retention":
    "Everything stays in this browser until someone exports it — the privacy notes list what can still leak.",
  "disclosure.retention.server":
    "Your comment, the page address and the details above are sent to {host} when you post — the privacy notes list what can still leak.",
  "disclosure.ack": "Got it",

  // ── Composer.
  "composer.aria": "New comment",
  // The ▲/▼ steppers — the [ / ] widen/narrow primitive's
  // touch face. Named for what they DO, because a triangle says nothing.
  "composer.parent": "Pin the parent",
  "composer.child": "Pin the first child",
  // Mobile screenshots are opt-in per comment.
  "composer.shot": "Add a screenshot",
  "composer.name": "Your name",
  // The own words. It says WHY in four words, which is what stops an
  // optional field reading like a data grab.
  "composer.email": "Email, so we can reply",
  "composer.email.bad": "Check the address — or leave it blank.",
  // A studio member skips the name and the email by signing in to the
  // dashboard in a popup. Phrased as a question so a client, who is not a
  // studio member, reads it as not for them.
  "composer.signin": "Studio member? Sign in",
  "composer.signin.blocked": "Allow pop-ups for this page to sign in.",
  "composer.member": "Commenting as {name}",
  "composer.signout": "Not you? Sign out",
  // The reviewer is looking at a closed round, which takes no new
  // comments. Said before they type, with where the comment WILL go, rather
  // than after it lands somewhere they were not looking.
  "composer.round.closed": "This round is closed — your comment goes to {round}.",
  // Characters LEFT, not characters used: the number a person acts on is how
  // much room remains, and it is the one that reaches zero.
  "composer.chars": "{n} characters left",
  "composer.body": "Comment",
  "composer.body.placeholder": "What's the {item}?",

  // ── The list row's short anchor badge. Only the dock renders it, so it lives
  // here rather than in en.ts: three strings nothing in the eager chunk can
  // draw were three strings every reviewer downloaded to activate. *moved* is
  // the reviewer's word for it; *orphaned* is ours, and it belongs in the code
  // rather than on screen.
  // The hidden-anchor chip — same lowercase reviewer-word register.

  // The detail's capture heading. It reads only in the dock — the Markdown
  // export writes its own heading — so it is a panels string despite sitting
  // above a block of shared ones.
  // ── The detail's capture block. FOUR lines, and
  // four keys rather than one assembled sentence: this file forbids building a
  // sentence from fragments, and both formatting rules below are word-order
  // decisions a translator has to be able to make.
  //
  //   Comment left on
  //   /pricing
  //   Chrome · macOS
  //   Desktop · 1280×860 @2x
  //
  // Separators are space + U+00B7 + space, and the dimensions use U+00D7 — a
  // lowercase "x" between two numbers reads as a variable.

  // Rendered by the DOCK alone. The Markdown export writes its own device and
  // page lines from the same `CaptureContext`, in its own words — which is why
  // these look like capture strings and are not.
  // The device glyph's accessible name and title. Words, because the
  // glyph alone does not survive a screen reader — and colour or shape alone is
  // never the signal.

  // ── The filter bar. Search counts the round; chips carry
  // live counts; the Filter button wears `· n` when its panel has active
  // facets. The three neutral option labels (Anyone / All pages) are minted
  // here — the spec is silent on them; flagged for copy review.
  // The filter-aware empty states, verbatim.
  // The Back-to-a-filtered-row notice — sentence plus a separate
  // button label, never one string assembled from halves.
  // The permalink affordance. Clipboard is secure-context-only; the
  // fallback renders the URL selectable instead of pretending. NOT detail.*:
  // that family's dynamic template would drag these into the capture chunk.

  // ── Dock, list.
  // The list spans the whole round — "show comments on this page only" is a
  // checkbox that NARROWS it, so page-scoping is the exception and
  // not the default. Grouped by page, so the ROUTE is the group header and no
  // row has to repeat it.
  // On a row for another page, where clicking leaves this one. A verb, because
  // the row IS the control — the design is explicit that a click which moves the
  // page must announce itself as navigation before it is clicked.
  // The >6 case: the list filtered to one cluster, and the way back.

  // ── Dock, detail.
  // Named for what it takes away, because the control it arms says only "Sure?".
  // The pin goes with it, and that is the part somebody would not expect.
  // The override button. The SENTENCE it follows is in the
  // capture catalogue with the rest of the detail.* family; the button is
  // dock-only chrome, so it lives in the narrowest home that reaches it.

  // ── Shared actions.
  "action.cancel": "Cancel",
  // POST, not Send — and the verb is the accurate one rather than the borrowed
  // one. At v0 nothing is sent anywhere: the comment is attached to an element
  // and written to this browser. "Send" also collides with the thing the studio
  // will genuinely send later — the round — and one verb meaning both "submit
  // this comment" and "hand the round over" is a verb that stops meaning
  // either. The noun stays on the button because this is the one control a
  // first-time client has to find, and the corridor test's bar is 3 of 3
  // unaided.
  "action.post": "Post comment",
  // The armed half of every destructive two-step. One word, so
  // the control does not resize and move under the pointer that armed it.
  // Esc-stack rung 5. Named in full for the arm state, because "Sure?" on its
  // own tells a screen-reader user nothing about what they are confirming.
  "composer.discard.sure": "Sure? Discard this comment",
  "action.discard": "Discard?",
} as const;

/**
 * Core plus capture plus panels. The panels chunk already contains the other
 * two — it renders `status.*`, `badge.*` and the capture block — so merging
 * costs it nothing, and a panel component never has to know which of the three
 * a key lives in.
 */
export const all = { ...en, ...captureStrings, ...panelStrings } as const;

export type PanelStringKey = keyof typeof all;

export const format = make(all);
export { count, when } from "./format.ts";
