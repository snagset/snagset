import { captureStrings } from "./capture.ts";
import { en } from "./en.ts";
import { make } from "./format.ts";
import { panelStrings } from "./panels.ts";

/**
 * The FIFTH catalogue: strings only the DOCK renders.
 *
 * Same packaging reason as the other four, discovered the same way. Since
 * the decision made chunks self-contained the dock bundles its OWN copy of whatever
 * catalogue it imports — so every dock-only key sitting in panels.ts was
 * ALSO shipping inside the eager `snag.panels.js`, which is envelope. The
 * filter bar (25 keys) pushed that to 39.92/40 and forced the split the
 * "one table, reached cross-chunk" comment in strings.test had priced away
 * back when cross-chunk imports existed.
 *
 * The rule stays the placement test's: a key lives in the NARROWEST
 * catalogue whose chunks all render it. Composer/disclosure/notice keys stay
 * in panels.ts; anything only the dock can draw belongs here.
 *
 * en.ts's two rules apply and are not restated: no brand literal, and no
 * sentence assembled from fragments.
 */
export const dockStrings = {
  // The screenshot thumbnail and its lightbox.
  "shot.open": "See the screenshot",
  "shot.aria": "Screenshot",
  "shot.close": "Close",

  // The design names this one explicitly — "because the visible feedback is a
  // colour". The dock owns it: the dock is where status is changed.
  "announce.status": "Comment {key} set to {status}.",

  // ── The list header: search, chips, sort and filter menus.
  "search.placeholder": "Search {n} comments\u2026",
  "search.aria": "Search comments",
  // ── The round selector (T10). "(closed)" is a suffix, not a state
  // chip: a closed round is still selectable — closing only means new
  // threads go elsewhere, and its unresolved work must stay reachable.
  "round.label": "Round",
  "round.closed": "(closed)",
  "filter.status": "Status",
  "filter.clear": "Clear",
  "filter.selectall": "Select all",
  "sort.button": "Sort",
  "sort.newest": "Newest first",
  "sort.oldest": "Oldest first",
  "sort.page": "By page",
  "filter.button": "Filter",
  "filter.button.n": "Filter \u00b7 {n}",
  "filter.by": "Comments by",
  "filter.by.anyone": "Anyone",
  "filter.pages": "Pages",
  "filter.pages.all": "All pages",
  "filter.pageonly": "Show comments on this page only",
  // The pill's three states are one control's label changing, not
  // three controls: spells all three out.
  "filter.new": "See new activity \u00b7 {n}",
  "filter.new.on": "Showing new activity \u2014 show all",
  "filter.new.none": "You\u2019re caught up \u2014 show all",
  "filter.read": "Marked as",
  "filter.read.all": "Anyone\u2019s, read or not",
  "filter.read.unread": "Unread",
  "filter.read.read": "Read",
  "dock.unread": "Unread",

  // ── The row's anchor chips. *moved* is the reviewer's word; *orphaned* is ours.
  "badge.anchored": "",
  "badge.approximate": "~",
  "badge.orphaned": "moved",
  "badge.hidden": "hidden",

  // ── The detail's capture block heading and page line.
  "capture.label": "Comment left on",
  "capture.page": "{route}",
  "device.Mobile": "Mobile",
  "device.Desktop": "Desktop",

  // ── Dock, list.
  "dock.aria": "All comments",
  "dock.title.list": "All comments",
  "dock.title.detail": "Comment",
  "dock.close": "Close all comments",
  "dock.empty": "No comments yet. Press +, then click anything on the page.",
  "dock.empty.filter": "Nothing matches that filter.",
  "dock.empty.orphans": "Every comment here lost its element \u2014 but what each one pointed at is still recorded.",
  "dock.empty.page": "Nothing on this page. {n} comments on {m} other pages.",
  "dock.row.empty": "(no comment)",
  "dock.replies": "{n} replies",
  "dock.goto": "Go to {route}",
  "dock.cluster": "{n} comments in this cluster",
  "dock.cluster.clear": "Show all",
  "dock.hiddenrow": "That comment is now hidden by your filter",
  "dock.hiddenrow.show": "Show",

  // ── Dock, detail and walker.
  "dock.back": "All",
  "dock.back.aria": "Back to all comments",
  "dock.position": "{n} of {total}",
  "dock.prev": "Previous comment",
  "dock.next": "Next comment",
  "dock.clear": "Clear all",
  "dock.clear.aria": "Delete every comment in this review",
  "comment.edit": "Edit this comment",
  "comment.delete": "Delete this comment and its pin",
  "reply.delete": "Delete this reply",
  "time.now": "just now",
  "who.name": "Your name",
  "who.email": "Email, so we can reply",
  "who.email.bad": "Check the address — or leave it blank.",
  "who.signin": "Studio member? Sign in",
  "who.signin.blocked": "Allow pop-ups for this page to sign in.",
  "who.member": "Replying as {name}",
  "who.signout": "Not you? Sign out",
  "detail.hidden.show": "Show anyway",
  "field.status": "Status",
  // Beside a read-only status, for a session that cannot change it.
  "field.status.locked": "Only the studio can change status here.",
  // Who holds a snag. Shown read-only to anyone who cannot change it.
  "field.assignee": "Assigned to",
  "assignee.none": "Unassigned",
  "permalink.copy": "Copy link",
  "permalink.copied": "Copied",
  "reply.add": "Add reply",
  "reply.aria": "Reply",
  "reply.placeholder": "Reply\u2026",
  "reply.send": "Reply",

  // ── Actions and exports the dock alone draws (the composer's live in panels.ts).
  "action.more": "More actions",
  "action.edit": "Edit",
  "action.delete": "Delete",
  "action.save": "Save",
  "action.sure": "Sure?",
  "export.button": "Export",
  "export.md": "Markdown",
  "export.json": "JSON",
} as const;

/** Core + capture + panels + dock — everything a dock component may draw. */
export const all = { ...en, ...captureStrings, ...panelStrings, ...dockStrings } as const;

export type DockStringKey = keyof typeof all;

export const format = make(all);
export { count, when } from "./format.ts";
