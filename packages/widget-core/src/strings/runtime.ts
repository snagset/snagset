import { en } from "./en.ts";
import { make } from "./format.ts";

/**
 * The strings only the RUNTIME chunk can render — the toolbar, the pins, the
 * add-mode hint and highlight chip, and the failure notices.
 *
 * The FOURTH catalogue, and the same packaging reason as the second and third:
 * a bundler cannot tree-shake properties out of an object literal, so every one
 * of these shipped inside `snag.panels.js` and `snag.capture.js` as well —
 * copy those chunks have no component to draw. It is the mirror image of the
 * `badge.*` mistake, which went the other way, and it was 7% of each chunk.
 *
 * Which half a key belongs in is decided by ONE question: can more than one
 * chunk render it? `status.*` and `where.*` reach the dock and the Markdown
 * export through `statusLabel()` and `whereText()`, so they stay shared in
 * en.ts even though they look like runtime concerns. `error.panels` cannot
 * reach anything but the vanilla notice, so it lives here.
 *
 * en.ts's two rules still apply and are not restated: no brand literal, and no
 * sentence assembled from fragments.
 */
export const runtimeStrings = {
  // ── Toolbar. These render BEFORE the panels chunk exists, so they are the
  // strings that must survive with the UI framework blocked (F-04).
  "toolbar.aria": "{product} review toolbar",
  "toolbar.group": "What you see",
  "toolbar.browse": "Browse",
  // SINGULAR, and it is a mode name rather than a collection (dogfood round 2:
  // "this is more like mode comment mode and browse mode"). Paired with
  // "Browse" it now reads verb / verb — two things you can be doing — where
  // "Browse / Comments" read verb / noun and quietly suggested the button
  // opened a list. The list is the panel button, and it is called "All
  // comments" for exactly that reason.
  "toolbar.comments": "Comment",
  "toolbar.comments.unresolved": "Comment, {n} unresolved",
  "toolbar.add": "Add a comment",
  // F-12. Named rather than implied: the mark is a glyph, and a glyph alone is
  // nothing at all to a screen reader.
  "toolbar.add.draft": "Add a comment — one is unfinished",
  "toolbar.panel": "All comments",
  // The `add` picker sub-segment's two strings were here and are gone with it
  // there is no picker, so there is nothing to name.

  // ── Pins, as a screen reader and a tooltip read them.
  // An ARIA IDREF cannot cross a shadow boundary, so
  // a pin can NEVER be programmatically associated with the element it marks —
  // it must DESCRIBE that element in words, built from the anchor's own role
  // and accessible name. Whole sentences, never halves joined at the call site.
  "pin.aria": "Comment {key} on {target}. {status}, {replies} replies. Press Enter.",
  "pin.aria.one": "Comment {key} on {target}. {status}, 1 reply. Press Enter.",
  "pin.aria.none": "Comment {key} on {target}. {status}. Press Enter.",
  // A pin whose anchor did not settle says SO, in place of its reply count:
  // The design requires the three anchor states to be distinguishable by name alone
  // (the rings that distinguish them visually are no help here), and a broken
  // anchor is the more urgent of the two facts.
  "pin.aria.moved": "Comment {key} on {target}. {status}. {where}. Press Enter.",
  /** The target phrase itself — one key, so a translator owns the word order. */
  "pin.target": "{role} “{name}”",
  // The copy, whole-sentence: {list} is the pre-joined ordinal list
  // enumeration joins are the one call-site assembly the catalogue tolerates.
  "cluster.aria": "{n} comments here: {list}",

  // ── The pin navigator. KEYBOARD ONLY since the first dogfood:
  // the ▲▼ pair and its "n/m" counter left the toolbar, which is why
  // "nav.prev", "nav.next" and "nav.position" are gone from here — nothing
  // renders them any more, and a string nobody renders is a string nobody
  // maintains. The announcement stays, and is now the WHOLE of what makes n/p
  // usable: it is the only place the position is reported at all.
  // The announcement, verbatim shape: "Comment 4 on “Sign up”, 2 of 7".
  "nav.announce": "Comment {n} on {label}, {i} of {total}",

  // ── The notice's actions. F-the one-click rescue is named as the whole
  // sequence, because half of it — clearing without exporting — is the thing
  // you can never undo.
  "action.retry": "Retry",
  "action.dismiss": "Dismiss",
  "action.export": "Export",
  "action.exportclear": "Export & clear",

  // ── Errors. The copy rules: never blame the reviewer, always name what
  // failed AND what to do next, never leak an internal id into the sentence.
  "error.quota": "Storage is full — this {item} is on screen but not saved. Export to keep them.",
  // F-01. The banner a client on Safari private mode must see — without it they
  // leave twenty comments, watch them appear all session, and lose every one on
  // reload having been told nothing. Present tense and plain: it is not a
  // failure that happened, it is a condition that holds.
  "error.nostorage": "Comments won't be saved in this browser. Export before you leave to keep them.",
  // A SERVER refusal, which is a different loss from a full disk and must not
  // borrow its wording: nothing is on screen "but not saved" — the pin is
  // removed, because leaving it there is how a reviewer walks away believing
  // a comment exists that nobody will ever read. Found by the walking
  // skeleton: the first server rejection painted a pin and said nothing.
  // F-19: the link was turned off. NOT the same event as running out
  // of time, and 01 is normative for what the reviewer is told — a build that
  // showed the 12-hour sentence here would tell someone to wait when the
  // answer is "ask for a new link".
  "error.linkrevoked": "This review link was turned off. Ask whoever sent it for a new one.",
  // F-18b: the 12-hour absolute cap. Re-opening the same link works.
  "error.sessionended": "This review session has ended. Open your review link again to carry on.",
  "error.sendfailed": "That {item} couldn't be sent, so it wasn't kept. Check your connection and try again.",
  // Layer 3 /. Shown ONLY where somebody deliberately turned the
  // widget on — never on the automatic path, because a mirrored copy of a
  // client's page must stay silent rather than announce us on it.
  //
  // It names the ADDRESS because that is the fix: the origin has to go on the
  // site's allow-list, and a developer who forgot which one they are serving
  // from cannot act on "not enabled here".
  "error.origin": "{product} is not enabled for {origin}. Add that address to the site's allowed origins.",
  // F-04, verbatim. It names what failed and what still works — the
  // reviewer's next question is "have I lost anything", and the answer is no.
  // The `+` keeps its accessible name and gains this as its explanation, rather
  // than disappearing: a control that vanishes reads as "I imagined it".
  "error.panels": "{product} loaded, but its comment UI didn't. You can still see the comments on the page.",
  "error.panels.add": "Adding comments is unavailable until the comment UI loads.",
  // The CAPTURE chunk, which is a different loss and must not borrow the
  // panels wording: the comment UI is fine, the dock opens, every existing
  // comment reads normally. What is gone is making a new one.
  "error.capture": "{product} can't take new comments — the part that records the page didn't load. Everything already here still works.",

  // The row, verbatim, and 01 owns this copy — the design says so and
  // says why the notice exists at all: without it the toolbar simply stops
  // responding and the widget looks broken rather than paused.
  "paused.dialog": "Review paused — a dialog is open on this page. Close it to carry on commenting. Commenting inside a native dialog isn't supported yet.",
  "paused.close": "Close",

  // The announcements. Whole sentences — a live region reads
  // what it is given. Mode changes reuse the toolbar's own words rather than
  // minting synonyms of them, and the pause notice announces itself (it
  // carries role="status" already), so neither needs a key here.
  "announce.created": "Comment {key} added.",

  // F-06, verbatim — the ?snag_t permalink that names a thread this
  // project does not have. Deliberately soft, never auth-shaped: a permalink
  // is not a credential and its failure must not read like one.
  "permalink.unknown": "That comment isn't on this page any more",
} as const;

/** Core plus runtime. Every runtime module formats through this. */
export const all = { ...en, ...runtimeStrings } as const;

export type RuntimeStringKey = keyof typeof all;
/** The name notice.ts and the toolbar already used. */
export type StringKey = RuntimeStringKey;

export const format = make(all);
export { count, when } from "./format.ts";
