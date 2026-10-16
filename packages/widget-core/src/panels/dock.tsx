import { CSS_VAR, param } from "@snagset/types/names";
import { render, type JSX, type VNode } from "preact";
import { useState, useRef, useEffect } from "preact/hooks";
import { adopt, FORM_CSS } from "./style.ts";
import { useArm } from "./arm.ts";
import { liftOnKeyboard } from "./kb.ts";
import { renderMarkdown } from "./markdown.ts";
import { signIn } from "./signin.ts";
import { readIdentity, writeIdentity } from "../storage/identity.ts";
import type { MemberSession } from "../storage/types.ts";
import { LAYER, t } from "../runtime/theme.ts";
import { format, count } from "../strings/dock.ts";
import { STATUS, statusColour, statusInk, statusLabel, whereText, type Snag, type Status } from "../storage/types.ts";
import { isIgnoredQueryParam } from "../runtime/params.ts";
import {
  ALL_STATUSES,
  activeFacets,
  countStatuses,
  defaultFilter,
  isUnread,
  listNarrow,
  pinPass,
  sortSnags,
  toggleStatus,
  type ListFilter,
} from "../storage/filter.ts";

/**
 * The dock — the list and the detail, as a STACK.
 *
 * The detail is a dedicated view with a back affordance, not a row that expands
 * in place. A thread carries a status, a capture line and its replies; an
 * accordion either truncates all of that or pushes every other row off-screen,
 * and the list is the thing people navigate by. Prev/next then lets someone
 * work a whole round without returning to the list between each snag.
 *
 * Every class here is `snag-dk-`-prefixed. The first version reused `.snag-row`,
 * which the toolbar already owns — same shadow root, so the two silently fought.
 * Shared form controls come from style.ts rather than from the composer.
 */

export interface DockProps {
  /** The WHOLE round, every page. The "this page only" is a checkbox
   *  that NARROWS this (v0.1) — page scope is the exception, not the default. */
  snags: Snag[];
  /** The page being viewed: the group the list SCROLLS to on open, and the one
   *  whose rows lift their pins on hover (the others have no pin to lift). */
  route: string;
  /** Which snag the detail is showing, or null for the list. */
  openId: string | null;
  /**
   * Thread id → epoch ms it was last looked at. Client-local by
   * decision (the note) — it arrives as a prop rather than through an
   * adapter method because there is no route for it and there is not going to
   * be one in v1. Absent means "no seen model", and every thread reads as
   * read: that is v0's behaviour, and the dock must not sprout dots on an
   * adapter that never marks anything.
   */
  seenAt?: ReadonlyMap<string, number>;
  /**
   * Open a thread — or, when it lives on another page, LEAVE for that page and
   * reopen it there. The runtime decides which, because only it knows the route
   * and owns the handoff; the dock just names the thread it wants.
   */
  onOpen(id: string | null): void;
  onStatus(id: string, status: Status): void;
  /** `name` is who wrote it, when the reply box just asked (or a member
   *  signed in) — otherwise the browser's stored guest identity. */
  onReply(id: string, body: string, name?: string): void;
  /**
   * The same three hooks the composer gets, so the reply box can ask
   * who is writing the way the comment box does: a name and an email the
   * first time, or "Sign in" for a studio member. Absent on a local install.
   */
  studio?: {
    host: string;
    uid: string;
    env?: string | undefined;
    member: string | null;
    adopt(b: MemberSession): void;
    signOut(): void;
  };
  onEdit(commentId: string, body: string): void;
  onDeleteComment(commentId: string): void;
  /** Deletes the thread and, with it, the pin. */
  onDeleteThread(id: string): void;
  /**
   * Whether a comment is the viewer's own — the only ones the widget offers
   * to edit or delete. The server refuses the rest either way; the menu used
   * to be on every comment, so a client saw Edit and Delete under the
   * studio's words and got an error for trying. Absent (the local adapter,
   * where every comment is the one person's): all of them.
   */
  isMine?: (author: import("../storage/types.ts").Reviewer) => boolean;
  /** The session may delete a thread it started (`thread:delete:own`). */
  canDeleteOwnThread?: boolean;
  /**
   * The session may change a thread's status (`thread:resolve`). False draws
   * the status read-only with a one-line reason, and the 1-4 and R chords do
   * nothing: a control the server will refuse is the bug real guests
   * reported — they resolved a comment and it came back. Absent: editable.
   */
  canStatus?: boolean;
  /** A signed-in studio owner or admin: Delete on every comment and thread,
   *  Edit still only on their own — the dashboard's rule. */
  canModerate?: boolean;
  /**
   * In the widget. Present only for a session holding `thread:assign`:
   * the pool to pick from, and the write. Without them the detail still
   * SHOWS who holds the snag, read-only, when somebody does.
   */
  assignees?(): Promise<import("../storage/types.ts").Reviewer[]>;
  onAssign?(id: string, who: import("../storage/types.ts").Reviewer | null): void;
  onClearAll(): void;
  /** Everything in the round marked read, now — the new-activity count clears
   *  without closing the panel (which also marks everything read). */
  onMarkAllRead?: () => void;
  onClose(): void;
  /**
   * Absent on a server-backed install: everything is in the dashboard there,
   * and Export is the one way out only for the local, server-less mode.
   */
  onExport?: (kind: "md" | "json") => void;
  /** Lift the matching pin while a row is pointed at, so list and page connect. */
  onHover(id: string | null): void;
  /** The round's filter — runtime-owned, because its first
   *  four fields govern the pins and pins outlive this chunk. */
  filter: import("../storage/filter.ts").ListFilter;
  onFilter(next: import("../storage/filter.ts").ListFilter): void;
  /** A >6 cluster opened the list filtered to these ids. */
  clusterFilter?: string[];
  /** T10/ — all three together or none: the round history (newest
   *  first), which one is in view, and the switch. Absent on adapters with no
   *  round concept, and when there is only one round — a dropdown over one
   *  option is furniture. */
  rounds?: import("../storage/types.ts").RoundInfo[];
  activeRound?: number;
  onRound?(round: number): void;
  onClusterClear?(): void;
  /** The hidden-anchor override — the runtime scrolls to
   *  the recorded coordinates and draws the ghost there. */
  onShowAnyway?(snag: Snag): void;
  /** Speak into the runtime's polite live region. */
  onAnnounce?(text: string): void;
  /** Fetch a screenshot's bytes — from the instance when the
   *  ref carries its URL, else from the local blob store. The WHOLE ref, not
   *  the id: an id alone could only ever be looked up locally, which is why a
   *  server-backed thumbnail never rendered. The runtime owns both handles;
   *  the dock only paints what it is given. */
  loadShot?(att: { id: string; url?: string }): Promise<Blob | null>;
}

const STATUS_ORDER = Object.keys(STATUS) as Status[];

/**
 * A destructive control that must be pressed twice.
 *
 * The design specifies this for *Clear all* — "the first click arms it to
 * *Sure?* for 3 s" — and it is reused for every delete rather than inventing a
 * confirm dialog per action. One idiom for destruction across the panel, no
 * modality, and nothing that can be dismissed by accident into a deletion.
 *
 * The armed label is one word so the button does not resize under the pointer
 * that just armed it — a control that grows on click moves the second click
 * somewhere else.
 */
function Danger({
  label,
  title,
  cls,
  role,
  onConfirm,
}: {
  label: string;
  title: string;
  cls: string;
  /** `menuitem` where it sits inside one; the default is a plain button. */
  role?: JSX.ButtonHTMLAttributes<HTMLButtonElement>["role"];
  onConfirm(): void;
}) {
  const { armed, press } = useArm(onConfirm);

  return (
    <button
      type="button"
      {...(role === undefined ? {} : { role })}
      class={`${cls}${armed ? " snag-dk-armed" : ""}`}
      // The accessible name says what will be destroyed in both states. "Sure?"
      // alone tells a screen-reader user nothing about what they are confirming.
      aria-label={armed ? `${format("action.sure")} ${title}` : title}
      title={title}
      onClick={press}
    >
      {armed ? format("action.sure") : label}
    </button>
  );
}

/**
 * The device glyph — the ONE behavioural consumer of
 * `CaptureContext.derived` that the design permits.
 *
 * Why it earns its place, verbatim: "it's broken" means something
 * different from a 390 px phone than from a 1440 px desktop, and the studio
 * triages differently on sight.
 *
 * Inline SVG, never an icon font — a font is a network request, a FOUT and an
 * a11y hazard for two glyphs. The WORD is the accessible name and the title,
 * because a glyph alone survives neither a screen reader nor a glance.
 *
 * PLACEMENT DEVIATES, which puts it "at the right of the header
 * line" — meaning the `Alex · 2h` author line, which this row does not render
 * at all (that row carries no release tag anywhere in 01, which under the design makes
 * it v1). It sits in the right-hand slot the row does have, beside the replies
 * count. Nothing is lost; the anchor point simply does not exist yet.
 */
function DeviceGlyph({ snag }: { snag: Snag }) {
  const device = snag.context?.derived?.device;
  if (!device) return null; // written before capture existed
  const label = format(`device.${device}`);
  return (
    <span class="snag-dk-dev" title={label} aria-label={label} role="img">
      {device === "Mobile" ? (
        <svg width="11" height="14" viewBox="0 0 11 14" fill="none" aria-hidden="true">
          <rect x=".75" y=".75" width="9.5" height="12.5" rx="1.75" stroke="currentColor" stroke-width="1.5" />
          <path d="M4.5 11h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect x=".75" y="1.75" width="12.5" height="8.5" rx="1.75" stroke="currentColor" stroke-width="1.5" />
          <path d="M5 12.75h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      )}
    </span>
  );
}

/** Author line plus the two things you can do to a comment you can read. */
/**
 * The **Details** — a read-only dump of the `AnchorRecord`, v0.
 *
 * *"Enough for a developer to find the element by hand, and enough to explain
 * cross-breakpoint drift ('this was pinned at 1440 × 900; you are at 375')."*
 *
 * It did not exist, which made an orphan a dead end. Asks for the orphan
 * to appear *"with its selector and record readable via Details"*, and what a
 * reader actually had was one sentence naming the label. The selector is
 * generated and stored — it was simply unreachable from the UI, so the one
 * artefact that locates the element in a codebase was write-only.
 *
 * Shown only for a NON-ANCHORED pin. On an anchored one the element is on
 * screen with a mark on it, and a panel of selectors would be noise in front of
 * the answer. `<details>` rather than an always-open block for the same reason:
 * the reader who needs this is debugging, and everyone else is not.
 *
 * The `rect` and `breakpoint` rows are the cross-breakpoint story the design names
 * the live viewport is beside the recorded one, because "this was pinned at a
 * different width" is the commonest honest explanation for a drifted pin and
 * nothing else in the UI says it.
 */
function AnchorDetails({ anchor }: { anchor: Snag["anchor"] }): VNode {
  const rows: [string, string][] = [];
  if (anchor.testid) rows.push(["testid", anchor.testid]);
  if (anchor.domid) rows.push(["id", anchor.domid]);
  if (anchor.css) rows.push(["css", anchor.css]);
  if (anchor.hostPath?.length) rows.push(["shadow host", anchor.hostPath.join(" >> ")]);
  if (anchor.role) rows.push(["role", anchor.role]);
  if (anchor.accessibleName) rows.push(["name", anchor.accessibleName]);
  if (anchor.text?.exact) rows.push(["text", anchor.text.exact]);
  if (anchor.path?.length) rows.push(["path", anchor.path.join(" > ")]);
  if (anchor.rect) {
    const r = anchor.rect;
    rows.push(["rect", `${Math.round(r.x)}, ${Math.round(r.y)} — ${Math.round(r.w)} x ${Math.round(r.h)}`]);
  }
  if (anchor.breakpoint) {
    rows.push([
      "breakpoint",
      `${anchor.breakpoint} at capture · you are at ${typeof window === "undefined" ? "?" : window.innerWidth}px`,
    ]);
  }

  return (
    <details class="snag-dk-anchor">
      <summary>{format("detail.details")}</summary>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            {/* Selectable rather than a copy BUTTON: `navigator.clipboard` is
                secure-context only, and a studio reviewing a staging site over
                plain http on a LAN is exactly the case that would fail. */}
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * When a comment was written — "4 min ago" for the last week, then the date.
 * The detail showed who and never when, so "the earlier comment" in a long
 * review had to be worked out from the order. The full date and time is the
 * tooltip, and `<time>` carries the machine-readable instant.
 */
function When({ iso }: { iso: string }): VNode | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const secs = Math.round((t - Date.now()) / 1000);
  let text: string;
  if (Math.abs(secs) < 45) text = format("time.now");
  else if (Math.abs(secs) < 7 * 86400) {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
    const [n, unit]: [number, Intl.RelativeTimeFormatUnit] =
      Math.abs(secs) < 3600
        ? [Math.round(secs / 60), "minute"]
        : Math.abs(secs) < 86400
          ? [Math.round(secs / 3600), "hour"]
          : [Math.round(secs / 86400), "day"];
    text = rtf.format(n, unit);
  } else {
    text = d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
    });
  }
  return (
    <time class="snag-dk-dim snag-dk-when" dateTime={d.toISOString()} title={d.toLocaleString()}>
      {text}
    </time>
  );
}

function CommentActions({
  body: raw,
  onEdit,
  deleteLabel,
  onDelete,
}: {
  /** Nullable, because a snag created without a body is a legal record. */
  body: string | null;
  /** Absent: Delete only — a studio admin on somebody else's words, which
   *  they may remove but never rewrite under that person's name. */
  onEdit?: (next: string) => void;
  deleteLabel: string;
  /** Absent: Edit only — the opening comment of a thread someone else has
   *  replied to, whose deletion would take their replies with it. */
  onDelete?: () => void;
}) {
  const body = raw ?? "";
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(body);
  const ref = useRef<HTMLTextAreaElement>(null);
  // The same Escape rung as the dock's other menus: the menu goes, the thread
  // it belongs to stays.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !open) return;
    e.stopPropagation();
    setOpen(false);
  };

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (editing && onEdit) {
    return (
      <div class="snag-dk-editbox">
        <textarea
          ref={ref}
          class="snag-text"
          rows={3}
          aria-label={format("comment.edit")}
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (draft.trim()) {
                onEdit(draft.trim());
                setEditing(false);
              }
            }
            // Leaves the edit, keeps the original. It does not save a half-typed
            // replacement over words that were already there.
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(body);
              setEditing(false);
            }
          }}
        />
        <div class="snag-actions">
          <button
            type="button"
            class="snag-cancel"
            onClick={() => {
              setDraft(body);
              setEditing(false);
            }}
          >
            {format("action.cancel")}
          </button>
          <button
            type="button"
            class="snag-send"
            disabled={!draft.trim() || draft.trim() === body}
            onClick={() => {
              onEdit(draft.trim());
              setEditing(false);
            }}
          >
            {format("action.save")}
          </button>
        </div>
      </div>
    );
  }

  // BEHIND AN ELLIPSIS, not behind a hover.
  //
  // These two rested at `opacity: 0` and appeared on `:hover` or
  // `:focus-within`. That is a fine quiet on a desktop — two destructive words
  // beside every line is worse — but a touch device has no hover, so on a
  // phone the controls were invisible and merely still tappable, which is not
  // a disclosure so much as a secret. An ellipsis is the same restraint said
  // out loud: one always-visible control, and the two words behind it.
  return (
    <div class="snag-dk-acts snag-dk-menus" onKeyDown={onKey}>
      {open && <div class="snag-dk-menubg" aria-hidden="true" onClick={() => setOpen(false)} />}
      <span class="snag-dk-menuwrap">
        <button
          type="button"
          class="snag-dk-act snag-dk-more"
          aria-label={format("action.more")}
          aria-expanded={open}
          aria-haspopup="menu"
          title={format("action.more")}
          onClick={() => setOpen(!open)}
        >
          {"\u22EF"}
        </button>
        {/* DOWNWARD, unlike the footer's. The ellipsis sits directly under the
            comment it acts on, and a menu opening up would cover the words you
            are about to edit or delete. Below it is the status control, which
            is not what you are looking at while you decide. */}
        {open && (
          <div class="snag-dk-menu" role="menu">
            {onEdit && (
              <button
                type="button"
                role="menuitem"
                title={format("comment.edit")}
                aria-label={format("comment.edit")}
                onClick={() => {
                  setOpen(false);
                  setDraft(body);
                  setEditing(true);
                }}
              >
                {format("action.edit")}
              </button>
            )}
            {/* The arm stays. It is the one idiom for destruction in this
                panel, and a menu that closed on the first click would turn a
                two-step delete into a one-step one. */}
            {onDelete && (
              <Danger
                label={format("action.delete")}
                title={deleteLabel}
                cls="snag-dk-act--danger"
                role="menuitem"
                onConfirm={onDelete}
              />
            )}
          </div>
        )}
      </span>
    </div>
  );
}

/**
 * Where a snag points, and how honest the answer is.
 *
 * The list row says *moved* on an orphan. The badge is amber and
 * carries the word — colour alone is never the signal, and "moved" is
 * the reviewer's word for it, not "orphaned", which is ours.
 */
function Where({ snag }: { snag: Snag }) {
  // The `hidden` chip. Keyed off the resolution's REASONS, not
  // a new AnchorState member: hidden is a fact about the page right now, and
  // the persisted state stays whatever the cascade judged.
  const hidden = snag.anchorReasons?.includes("hidden") ?? false;
  return (
    <span class="snag-dk-dim snag-dk-where">
      {hidden && (
        <>
          <span class="snag-dk-moved">{format("badge.hidden")}</span>{" "}
        </>
      )}
      {snag.anchorState !== "anchored" && (
        <>
          <span class="snag-dk-moved">{format(`badge.${snag.anchorState}`)}</span>{" "}
        </>
      )}
      {snag.anchor.label}
    </span>
  );
}

/**
 * The number on the pin — which is the number WITHIN that comment's own page.
 *
 * The list spans every page now, so its index is not the pin's number. Getting
 * this wrong would break the one thing numbering exists for: "snag three"
 * meaning the same object to two people looking at the same page.
 */
function numbering(snags: Snag[]): Map<string, number> {
  const perRoute = new Map<string, number>();
  const out = new Map<string, number>();
  for (const s of snags) {
    const n = (perRoute.get(s.route) ?? 0) + 1;
    perRoute.set(s.route, n);
    out.set(s.id, n);
  }
  return out;
}

interface Group {
  route: string;
  here: boolean;
  snags: Snag[];
}

/**
 * The round, split by page. Alphabetical — ALWAYS, including the page you are on.
 *
 * Files grouping under v0.1, and this is ahead of that on purpose:
 * a flat all-pages list stopped being readable the first week it held twenty
 * comments across three routes, because the one fact that decides what a row
 * means — which page it is about — was a small grey clause at the end of it.
 * The header carries the route ONCE and no row repeats it.
 *
 * Also says "current route first", and that is the one part NOT followed,
 * because it cannot survive contact with the walker. Hoisting the current page
 * re-orders the whole list on every navigation, so a walker that crosses routes
 * has its cursor reset to 0 the moment it arrives. Pressing *next* twice
 * then returns you to where you started, and with three pages the third is
 * unreachable by walking at all — observed, two pages, ping-ponging forever.
 *
 * A stable order makes *next* monotonic and makes it terminate. Landing on your
 * own page is delivered instead by scrolling the list to it — same benefit, and
 * it does not cost the order.
 *
 * A badge saying "you're here" used to sit on that header. The decision removed it: the
 * scroll had already put the group in front of you, so the badge was labelling
 * what the panel had just shown.
 *
 * A page with no comments is not a group. An empty header is a row of furniture
 * that says nothing, and on a large site there would be dozens of them.
 */
function grouped(snags: Snag[], route: string): Group[] {
  const by = new Map<string, Snag[]>();
  for (const s of snags) {
    const list = by.get(s.route);
    if (list) list.push(s);
    else by.set(s.route, [s]);
  }
  return [...by.entries()]
    .map(([r, list]) => ({ route: r, here: r === route, snags: list }))
    .sort((a, b) => a.route.localeCompare(b.route));
}

function Row({ snag: s, n, here, unread, onOpen, onHover }: {
  snag: Snag;
  n: number | undefined;
  here: boolean;
  unread: boolean;
  onOpen: DockProps["onOpen"];
  onHover: DockProps["onHover"];
}) {
  // Hovering a row lifts its pin — but only a pin that is on this page. There
  // is nothing to lift for a comment two routes away.
  const hover = (id: string | null) => onHover(here ? id : null);
  const goto = here ? "" : format("dock.goto", { route: s.route });
  return (
    <li>
      <button
        type="button"
        class="snag-dk-item"
        onClick={() => onOpen(s.id)}
        onPointerEnter={() => hover(s.id)}
        onPointerLeave={() => hover(null)}
        onFocus={() => hover(s.id)}
        onBlur={() => hover(null)}
      >
        {/* The number matches the pin exactly — it is what people say out loud
            mid-review ("snag three") — and so does its fill. An orphan keeps its
            status colour: The design gives status ONE source across every surface,
            and greying the row here would hide whether a lost-anchor snag is
            still active. */}
        {/* A 7px accent dot LEFT of the circle. It carries a word for
            a screen reader — colour alone is never the signal — and it
            occupies its slot whether or not it is showing, so a row does not
            shift sideways when the thread is read. */}
        <span class={`snag-dk-dot${unread ? " snag-dk-dot--on" : ""}`} role="img"
          aria-label={unread ? format("dock.unread") : ""} />
        <span
          class={`snag-dk-num${s.anchorState === "anchored" ? "" : ` snag-dk-num--${s.anchorState}`}`}
          style={{ background: statusColour(s.status), color: statusInk(s.status) }}
        >
          {n}
        </span>
        <span class="snag-dk-main">
          {/* A resolved row "greys and strikes the text". It is the
              cheapest possible signal that a round is progressing, and without
              it a list of forty comments reads identically before and after a
              day's work. */}
          <span class={`snag-dk-body${s.status === "resolved" ? " snag-dk-done" : ""}`}>
            {s.comments[0]?.body ?? format("dock.row.empty")}
          </span>
          <span class="snag-dk-sub">
            <Where snag={s} />
          </span>
        </span>
        <DeviceGlyph snag={s} />
        {s.comments.length > 1 && (
          // Labelled, not a bare numeral: on its own the badge reads as "3" to a
          // screen reader, next to a row that already starts with the pin number.
          // `role="img"`: a bare <span> may not carry aria-label at all (ARIA
          // prohibits it on the generic role, and axe flags it), but the badge
          // IS a graphic conveying one fact — the count — so `img` with a name
          // is both legal and accurate.
          <span
            class="snag-dk-replies"
            role="img"
            aria-label={format("dock.replies", { n: count(s.comments.length - 1) })}
          >
            {count(s.comments.length - 1)}
          </span>
        )}
        {!here && (
          // This row leaves the page, and says so before it is clicked. The design
          // is emphatic that a click which moves the page must announce itself
          // as navigation — the glyph is the visible half, the label the half a
          // screen reader gets, since the row's own text is the comment body.
          <span class="snag-dk-goto" role="img" title={goto} aria-label={goto}>
            ↗
          </span>
        )}
      </button>
    </li>
  );
}

/** `--snag-status-open` etc — the chip tints borrow the one palette. */
const statusVar = (st: string): string =>
  (t as Record<string, string>)[`status${st[0]!.toUpperCase()}${st.slice(1)}`] ?? t.muted;

/**
 * The filter bar, re-laid at 0.1.21. Top to
 * bottom: search (with its glyph, so it reads as search before it is read),
 * the four status chips ALWAYS on the face with live whole-round counts, then
 * one row holding the two menus, Sort and Filter. The chips came back out of
 * the menu because their counts are the board's summary — "how much is left"
 * is the first question a reviewer asks the panel, and it was a click away.
 * Sort and Filter are exclusive menus; the Filter button wears `· n` for its
 * own panel's facets. Everything here is lazy dock bytes.
 */
function FilterBar({
  round,
  filter,
  onFilter,
  onClearAll,
  seenAt,
  trailing,
}: {
  round: Snag[];
  filter: ListFilter;
  onFilter: (f: ListFilter) => void;
  onClearAll: () => void;
  /** Absent = no seen model; the facet is not offered rather than offered inert. */
  seenAt?: ReadonlyMap<string, number>;
  /** The new-activity toggle, at the end of the Sort/Filter row. */
  trailing?: VNode | null;
}) {
  // Two exclusive menus again (the decision had folded sort into filter). The scrim and
  // the Escape rung are shared: whichever is open closes first.
  const [menu, setMenu] = useState<null | "sort" | "filter">(null);
  const counts = countStatuses(round);
  const allOn = ALL_STATUSES.every((st) => filter.statuses.includes(st));
  // `undefined` DELETES the facet (exactOptionalPropertyTypes: an absent key
  // and an undefined-valued one are different objects, and the predicate
  // tests presence).
  const set = (patch: { [K in keyof ListFilter]?: ListFilter[K] | undefined }): void => {
    const next = { ...filter } as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    onFilter(next as unknown as ListFilter);
  };
  const facets = activeFacets(filter);
  const authors = [...new Map(round.map((s) => [s.createdBy.id, s.createdBy.name]))];
  const routes = [...new Set(round.map((s) => s.route))].sort();
  // F-07b: unknown statuses get a neutral, non-interactive chip with the raw
  // value — visible in the totals, never hidden by a filter they cannot match.
  const strays = [...counts.byStatus.keys()].filter((k) => !(ALL_STATUSES as readonly string[]).includes(k));
  const toggle = (m: "sort" | "filter"): void => setMenu(menu === m ? null : m);
  const caret = (
    <svg class="snag-dk-caret" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" stroke-width="1.4" />
    </svg>
  );

  return (
    <div class="snag-dk-filters">
      <div class="snag-dk-searchwrap">
        <svg class="snag-dk-searchicon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
        <input
          class="snag-input snag-dk-search"
          type="search"
          aria-label={format("search.aria")}
          placeholder={format("search.placeholder", { n: count(round.length) })}
          value={filter.q ?? ""}
          onInput={(e) => set({ q: (e.currentTarget as HTMLInputElement).value || undefined })}
        />
      </div>
      {/* Status, on the face. Multi-select; none pressed means all shown. */}
      <div class="snag-dk-chiphead">
        <span class="snag-dk-menutitle" id="snag-dk-st">{format("filter.status")}</span>
        {/* Pastel's toggle: "Select all" lights every chip, then reads
            "Clear", which lights none. Both show every comment; the chips say
            which you are looking at. */}
        <button
          type="button"
          class="snag-dk-link snag-dk-selectall"
          onClick={() => set({ statuses: allOn ? [] : [...ALL_STATUSES] })}
        >
          {format(allOn ? "filter.clear" : "filter.selectall")}
        </button>
      </div>
      <div class="snag-dk-chips" role="group" aria-labelledby="snag-dk-st">
        {ALL_STATUSES.map((st) => {
          const on = filter.statuses.includes(st);
          return (
            <button
              type="button"
              class="snag-dk-chip"
              aria-pressed={on}
              style={on
                ? `border-color:${statusVar(st)};background:color-mix(in srgb, ${statusVar(st)} 18%, transparent)`
                : undefined}
              onClick={() => set({ statuses: toggleStatus(filter.statuses, st) })}
            >
              <span class="snag-dk-chipdot" aria-hidden="true" style={{ background: statusColour(st) }} />
              <span class="snag-dk-chiplabel">{statusLabel(st)}</span>{" "}
              <span class="snag-dk-chipn">{count(counts.byStatus.get(st) ?? 0)}</span>
            </button>
          );
        })}
        {strays.map((st) => (
          <span class="snag-dk-chip snag-dk-chip-stray">
            <span class="snag-dk-chiplabel">{st}</span>{" "}
            <span class="snag-dk-chipn">{count(counts.byStatus.get(st) ?? 0)}</span>
          </span>
        ))}
      </div>
      <div
        class="snag-dk-menus"
        onKeyDown={(e: KeyboardEvent) => {
          // Escape closes the MENU, not the dock: an open menu is a rung of
          // its own on the Escape ladder.
          if (e.key !== "Escape" || !menu) return;
          e.stopPropagation();
          setMenu(null);
        }}
      >
        {menu && <div class="snag-dk-menubg" aria-hidden="true" onClick={() => setMenu(null)} />}
        <span class="snag-dk-menuwrap">
          <button
            type="button"
            class="snag-dk-link snag-dk-trigger"
            aria-expanded={menu === "sort"}
            onClick={() => toggle("sort")}
          >
            {format("sort.button")}
            {caret}
          </button>
          {menu === "sort" && (
            <div class="snag-dk-menu" role="radiogroup" aria-label={format("sort.button")}>
              {([
                ["newest", "sort.newest"],
                ["oldest", "sort.oldest"],
                ["page", "sort.page"],
              ] as const).map(([k, label]) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={filter.sort === k}
                  onClick={() => set({ sort: k })}
                >
                  <span class="snag-dk-tick" aria-hidden="true">{filter.sort === k ? "✓" : " "}</span>
                  {format(label)}
                </button>
              ))}
            </div>
          )}
        </span>
        <span class="snag-dk-menuwrap">
          <button
            type="button"
            class="snag-dk-link snag-dk-trigger"
            aria-expanded={menu === "filter"}
            onClick={() => toggle("filter")}
          >
            {facets > 0 ? format("filter.button.n", { n: count(facets) }) : format("filter.button")}
            {caret}
          </button>
          {menu === "filter" && (
            // A group of filter controls (selects and a checkbox), not a menu:
            // the role is a promise about the children.
            <div class="snag-dk-menu snag-dk-menu-form" role="group" aria-label={format("filter.button")}>
              {/* Who and where, then the round's own destructive action. */}
              <div class="snag-dk-menugroup">
                {/* The third facet. Unlike the activity bar, `read`
                    is PIN-GOVERNING. */}
                {seenAt && (
                  <label>
                    {format("filter.read")}
                    <select
                      value={filter.read}
                      onChange={(e) =>
                        set({ read: (e.currentTarget as HTMLSelectElement).value as ListFilter["read"] })
                      }
                    >
                      <option value="all">{format("filter.read.all")}</option>
                      <option value="unread">{format("filter.read.unread")}</option>
                      <option value="read">{format("filter.read.read")}</option>
                    </select>
                  </label>
                )}
                <label>
                  {format("filter.by")}
                  <select
                    value={filter.by ?? ""}
                    onChange={(e) => set({ by: (e.currentTarget as HTMLSelectElement).value || undefined })}
                  >
                    <option value="">{format("filter.by.anyone")}</option>
                    {authors.map(([id, name]) => (
                      <option value={id}>{name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {format("filter.pages")}
                  <select
                    value={filter.page ?? ""}
                    onChange={(e) => set({ page: (e.currentTarget as HTMLSelectElement).value || undefined })}
                  >
                    <option value="">{format("filter.pages.all")}</option>
                    {routes.map((r) => (
                      <option value={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <label class="snag-dk-pageonly">
                  <input
                    type="checkbox"
                    checked={filter.pageOnly}
                    onChange={(e) => set({ pageOnly: (e.currentTarget as HTMLInputElement).checked })}
                  />{" "}
                  {format("filter.pageonly")}
                </label>
              </div>
              {/* Clear all belongs to the ROUND; it keeps its two-step arm. */}
              <div class="snag-dk-menugroup snag-dk-menugroup-last">
                <Danger
                  label={format("dock.clear")}
                  title={format("dock.clear.aria")}
                  cls="snag-dk-link snag-dk-clear"
                  onConfirm={onClearAll}
                />
              </div>
            </div>
          )}
        </span>
        {trailing}
      </div>
    </div>
  );
}

function List({
  snags,
  groups,
  route,
  onOpen,
  onHover,
  onExport,
  onClearAll,
  onMarkAllRead,
  clusterFilter,
  onClusterClear,
  filter,
  onFilter,
  hiddenNote,
  onHiddenShow,
  seenAt,
}: DockProps & { groups: Group[]; hiddenNote: string | null; onHiddenShow: (id: string) => void }) {
  // Numbering base = the UNFILTERED round (pin 3 is still "3" when
  // 1 and 2 are hidden) — never the filtered view.
  const numbers = numbering(snags);
  const ordered = groups.flatMap((g) => g.snags);
  const filterActive =
    filter.statuses.length > 0 || !!filter.by || !!filter.page || !!filter.q?.trim() ||
    filter.pageOnly || filter.newOnly || filter.read !== "all";
  // The count the pill carries: whole-round unseen, like the status chips —
  // not the narrowed list, or reading one thread would change the number that
  // told you how many were left to read.
  const unseen = seenAt ? snags.filter((s) => isUnread(s, seenAt)).length : 0;
  const scroller = useRef<HTMLDivElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // Same rung as the filter menu's: a menu closes before the panel holding it.
  const onExportKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !exportOpen) return;
    e.stopPropagation();
    setExportOpen(false);
  };
  const hereRef = useRef<HTMLElement>(null);

  /**
   * Open the list ON the page you are looking at.
   *
   * This is what replaces hoisting the current group to the top — see grouped().
   * The order stays stable so the walker can be monotonic; the SCROLL does the
   * landing. Sorting alone would otherwise put you at somebody else's page on a
   * site with twenty routes.
   *
   * scrollTop is set arithmetically rather than by scrollIntoView, deliberately:
   * scrollIntoView on an element inside a container that is already at its edge
   * scrolls the HOST PAGE as well, and moving a client's page because a panel
   * opened is precisely the disorientation this whole area is about.
   */
  useEffect(() => {
    const box = scroller.current;
    const here = hereRef.current;
    if (!box || !here) return;
    box.scrollTop += here.getBoundingClientRect().top - box.getBoundingClientRect().top;
  }, [route, groups.length]);

  return (
    <>
      {snags.length > 0 && (
        <FilterBar
          round={snags}
          filter={filter}
          onFilter={onFilter}
          onClearAll={onClearAll}
          {...(seenAt === undefined ? {} : { seenAt })}
          trailing={
            /* ONE control whose label is its state, not three,
               at the end of the Sort/Filter row (it had a full-width bar of its
               own; the row had the room). It appears only when there is unseen
               work, or while it is the thing doing the narrowing (otherwise
               turning it on would remove the only way to turn it off). It
               narrows the LIST only: asserts the pins stay
               byte-identical through it. */
            seenAt && filter.newOnly && unseen > 0 && onMarkAllRead ? (
              // Looking at the new ones: the way out is to clear them, as in
              // Pastel — the count goes, and the full list comes back.
              <button type="button" class="snag-dk-link snag-dk-newpill" onClick={onMarkAllRead}>
                {format("filter.new.markread")}
              </button>
            ) : seenAt && (unseen > 0 || filter.newOnly) ? (
              <button
                type="button"
                class="snag-dk-link snag-dk-newpill"
                aria-pressed={filter.newOnly}
                onClick={() => onFilter({ ...filter, newOnly: !filter.newOnly })}
              >
                {filter.newOnly
                  ? format(unseen === 0 ? "filter.new.none" : "filter.new.on")
                  : format("filter.new", { n: count(unseen) })}
              </button>
            ) : null
          }
        />
      )}
      {snags.length === 0 ? (
        <div class="snag-dk-empty">
          <p>{format("dock.empty")}</p>
        </div>
      ) : ordered.length === 0 && filterActive ? (
        <div class="snag-dk-empty">
          {/* The two filter-aware copies, chosen by which narrowing bit. */}
          {filter.pageOnly && snags.some((s) => s.route !== route) ? (
            <p>
              {format("dock.empty.page", {
                n: count(snags.filter((s) => s.route !== route).length),
                m: count(new Set(snags.filter((s) => s.route !== route).map((s) => s.route)).size),
              })}
            </p>
          ) : (
            <p>{format("dock.empty.filter")}</p>
          )}
        </div>
      ) : (
        <>
          {hiddenNote && (
            <p class="snag-dk-notice">
              {format("dock.hiddenrow")}{" "}
              <button type="button" class="snag-dk-link" onClick={() => onHiddenShow(hiddenNote)}>
                {format("dock.hiddenrow.show")}
              </button>
            </p>
          )}
          {/* The >6 case: the list is showing ONE cluster, and says so
              — with the way back, because a filter with no exit reads as
              comments vanishing. */}
          {clusterFilter && (
            <p class="snag-dk-notice">
              {format("dock.cluster", { n: clusterFilter.length })}{" "}
              <button type="button" class="snag-dk-link" onClick={() => onClusterClear?.()}>
                {format("dock.cluster.clear")}
              </button>
            </p>
          )}
          {/* Not an empty list — a list where every anchor died. The design gives it
              its own copy because "nothing here" and "all of it came loose" are
              different things to walk into. */}
          {snags.every((s) => s.anchorState === "orphaned") && (
            <p class="snag-dk-notice">{format("dock.empty.orphans")}</p>
          )}
          <div class="snag-dk-scroll" ref={scroller}>
            {groups.map((g) => (
              <section key={g.route} class="snag-dk-group" ref={g.here ? hereRef : null}>
                {/* Date sorts flatten — one anonymous group, no header. */}
                {g.route !== "" && (
                  <h3 class="snag-dk-grouphd">
                    <span class="snag-dk-route">{g.route}</span>
                    <span class="snag-dk-dim">{count(g.snags.length)}</span>
                  </h3>
                )}
                <ul class="snag-dk-list">
                  {g.snags.map((s) => (
                    <Row
                      key={s.id}
                      snag={s}
                      n={numbers.get(s.id)}
                      here={g.here}
                      unread={!!seenAt && isUnread(s, seenAt)}
                      onOpen={onOpen}
                      onHover={onHover}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
      {onExport && (
      <div class="snag-dk-foot">
        {/* ONE Export. Two formats side by side made the choice of format look
            like the decision, when the decision is whether to export at all —
            and it put two links in a footer that the decision is emptying. This one IS
            a menu in the ARIA sense: two commands, nothing else. */}
        <div class="snag-dk-menus snag-dk-menus-up" onKeyDown={onExportKey}>
          {exportOpen && (
            <div class="snag-dk-menubg" aria-hidden="true" onClick={() => setExportOpen(false)} />
          )}
          <span class="snag-dk-menuwrap">
            <button
              type="button"
              class="snag-dk-link"
              aria-expanded={exportOpen}
              aria-haspopup="menu"
              onClick={() => setExportOpen(!exportOpen)}
            >
              {format("export.button")}
            </button>
            {exportOpen && (
              <div class="snag-dk-menu snag-dk-menu-up" role="menu">
                {(["md", "json"] as const).map((kind) => (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setExportOpen(false);
                      onExport(kind);
                    }}
                  >
                    {format(kind === "md" ? "export.md" : "export.json")}
                  </button>
                ))}
              </div>
            )}
          </span>
        </div>
      </div>
      )}
    </>
  );
}

/**
 * Reply drafts, held OUTSIDE the component that shows them.
 *
 * "Drafts are held per thread and survive back-to-list, returning, and
 * a role re-render." They were `useState` on `<Detail key={snag.id}>`, which
 * remounts on every prev/next and on every return from the list — so the draft
 * was destroyed by the two most ordinary navigations in the panel. Keyed by
 * thread, because that is the unit the spec names.
 *
 * Module scope rather than a ref, so it also survives the dock closing and
 * reopening. The durable half — F-12's `snag:draft:` key, surviving a page
 * reload — is still owed; this is the in-session half of the same promise.
 */
const replyDrafts = new Map<string, string>();


/**
 * Where and on what this was written.
 *
 * The four lines are four separate catalogue entries rather than one assembled
 * string, because both formatting rules below are word-order decisions a
 * translator has to be able to make — and because strings/panels.ts forbids
 * building a sentence out of fragments.
 *
 * Degrades to nothing when there is no context, which is the case for records
 * written before capture existed. A block that renders "undefined · undefined"
 * is worse than a block that is not there.
 */
/**
 * The non-reserved query the pin was FILED with. Parsed from the
 * stored, redacted `CaptureContext.url`; reserved and tracking params are
 * page furniture, not page identity, and showing them would say "filed at
 * ?snag_debug=1" about a pin filed on the base page.
 */
function filedQuery(url: string | undefined): string | null {
  const kept: string[] = [];
  try {
    // URL() also strips the fragment; throws on undefined/garbage → null.
    for (const [k, v] of new URL(url!).searchParams) {
      if (isIgnoredQueryParam(k)) continue;
      // A redacted value is page furniture with the words removed — the NAME
      // still says where this was filed; the marker would just say "secret".
      kept.push(v && v !== "[redacted]" ? `${k}=${v}` : k);
    }
  } catch {
    return null;
  }
  return kept.length ? `?${kept.join("&")}` : null;
}

/**
 * The screenshot thumbnail and its lightbox: "the screenshot
 * thumbnail (142 px, `object-position: top`, click → lightbox)".
 *
 * DRAWN INTO A CANVAS, never an <img src=objectURL>. A host running
 * `img-src 'self'` blocks both `blob:` and `data:`, and those are the only
 * two ways to point an <img> at bytes we hold — a canvas needs neither, so
 * the preview is CSP-proof by construction. The blob comes from the
 * runtime, which owns the store handle; this component only paints.
 *
 * In annotation mode there is no thumbnail AND no empty frame (the design
 * is explicit): with no attachment the text lines stand alone.
 */
function Shot({
  att,
  load,
}: {
  att: { id: string; url?: string; width?: number; height?: number };
  load: (att: { id: string; url?: string }) => Promise<Blob | null>;
}): VNode | null {
  const thumb = useRef<HTMLCanvasElement>(null);
  const [open, setOpen] = useState(false);
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);

  useEffect(() => {
    let dead = false;
    void load(att)
      .then(async (blob) => {
        if (!blob || dead) return;
        const b = await createImageBitmap(blob);
        if (dead) b.close();
        else setBmp(b);
      })
      // Undecodable bytes are the same outcome as no bytes — no frame at
      // all, never an unhandled rejection in the host console.
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [att.id, att.url]);

  // Paint the thumbnail top-aligned — the `object-position: top`, which is
  // the half of a screenshot that carries the page's identity.
  useEffect(() => {
    const c = thumb.current;
    if (!c || !bmp) return;
    const w = 142;
    const scale = w / bmp.width;
    c.width = w;
    c.height = Math.min(96, Math.round(bmp.height * scale));
    c.getContext("2d")!.drawImage(bmp, 0, 0, bmp.width, Math.round(c.height / scale), 0, 0, c.width, c.height);
  }, [bmp]);

  if (!bmp) return null;
  return (
    <>
      <button type="button" class="snag-dk-shot" onClick={() => setOpen(true)} aria-label={format("shot.open")}>
        {/* Sized in the markup, not only in the paint effect: the effect runs
            a frame after the element exists, and in between it was the
            browser's default 300×150 — a flash on screen, and what a test
            measuring the first visible frame saw on WebKit. */}
        <canvas ref={thumb} width={142} height={Math.min(96, Math.round(bmp.height * (142 / bmp.width)))} />
      </button>
      {open && <Lightbox bmp={bmp} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The lightbox — the screenshot at its CAPTURE viewport, which is the
 * honest substitute for the one Pastel interaction we cannot copy (their
 * proxy resizes to the comment's viewport; we cannot resize somebody else's
 * site, so we show the picture at the size it was taken).
 */
function Lightbox({ bmp, onClose }: { bmp: ImageBitmap; onClose: () => void }): VNode {
  const full = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = full.current;
    if (!c) return;
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d")!.drawImage(bmp, 0, 0);
  }, [bmp]);
  return (
    <div
      class="snag-dk-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={format("shot.aria")}
      tabIndex={-1}
      ref={(el) => el?.focus()}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation(); // Esc closes the LIGHTBOX, not the dock behind it
          onClose();
        }
      }}
      onClick={onClose}
    >
      <canvas ref={full} />
      <button type="button" class="snag-dk-link snag-dk-lightclose" onClick={onClose}>
        {format("shot.close")}
      </button>
    </div>
  );
}

function CaptureBlock({ snag, loadShot }: { snag: Snag; loadShot?: DockProps["loadShot"] }) {
  const c = snag.context;
  if (!c) return null;
  const shot = snag.attachments?.find((a) => a.kind === "screenshot");
  const d = c.derived;
  /**
   * The viewport is OPTIONAL at render time, whatever the type says.
   *
   * `if (!c) return null` guarded the context and then this block read
   * `c.viewport.dpr` straight through it, so a thread whose context has no
   * viewport threw `Cannot read properties of undefined (reading 'dpr')` —
   * and because this renders inside the panel, the whole detail view failed
   * rather than one line of it.
   *
   * The widget always sends a full `CaptureContext`, which is why nothing
   * caught this. `POST /threads` does not require one: a thread created
   * through the API with `context: { url }` is accepted, and every one of them
   * is a comment the studio cannot open. Found by creating a thread with curl
   * to test something else entirely.
   *
   * Degrade, do not guard the whole block: the route, the browser and the
   * capture reasons are all still worth showing.
   */
  const v = c.viewport;
  // dpr is stored RAW and rounded HERE — two decimal places, and the
  // trailing zeros dropped so 2 renders as "2" rather than "2.00".
  const dpr = v ? Math.round(v.dpr * 100) / 100 : 1;
  return (
    <div class="snag-dk-cap">
      {/* The thumbnail sits BESIDE the four lines. No attachment
          (annotation mode, or a capture that failed and said so) means no
          frame at all — never an empty one. */}
      {shot && loadShot && <Shot att={shot} load={loadShot} />}
      <p class="snag-dk-caplabel">{format("capture.label")}</p>
      {c.page?.route !== undefined && <p>{format("capture.page", { route: c.page.route })}</p>}
      {d && v && (
        <>
          {/* An empty `os` takes the separator with it. "" is the specified
              fallback on an unrecognised platform, and "Chrome · " reads as a
              rendering bug rather than as missing information. */}
          <p>
            {d.os
              ? format("capture.agent", { browser: d.browser, os: d.os })
              : format("capture.agent.noos", { browser: d.browser })}
          </p>
          {/* @1x is suppressed entirely — on the majority of desktops it is
              noise, and a line that ends "@1x" invites the question "as opposed
              to what?" every single time. */}
          <p>
            {dpr === 1
              ? format("capture.device.at1x", { device: d.device, w: v.w, h: v.h })
              : format("capture.device", { device: d.device, w: v.w, h: v.h, dpr })}
          </p>
        </>
      )}
      {/* Rendered VERBATIM: these are sentences, not codes, and they
          are what tells a reviewer why there is no screenshot to look at.
          Blind spots follow in the same quiet register (the degradation
          line) — "1 cross-origin iframe not captured: js.stripe.com" belongs
          exactly where the missing pixels would have been. */}
      {c.capture?.reasons?.map((r) => (
        <p key={r} class="snag-dk-capwhy">
          {r}
        </p>
      ))}
      {c.capture?.blindSpots?.map((b) => (
        <p key={b} class="snag-dk-capwhy">
          {b}
        </p>
      ))}
      {/* Nothing is lost: the query that page identity discarded
          is shown, and the original URL is one click away. Reads from the
          REDACTED stored url, which is the honest form of it. */}
      {(() => {
        const q = filedQuery(c.url);
        return q ? (
          <p class="snag-dk-capwhy">
            {format("detail.filedat", { query: q })}{" "}
            <a class="snag-dk-openq" href={c.url} target="_blank" rel="noreferrer">
              {format("detail.openquery")}
            </a>
          </p>
        ) : null;
      })()}
    </div>
  );
}

/** `<context.url>?snag_t=<Thread.key>` — the KEY, never the
 *  round number. */
function permalink(snag: Snag): string {
  const base = snag.context?.url ?? snag.route;
  return `${base}${base.includes("?") ? "&" : "?"}${param("t")}=${snag.key}`;
}

/**
 * The permalink, where the clipboard exists.
 *
 * Clipboard is secure-context-only. Where it is missing this renders nothing
 * and `PermalinkLine` says the URL instead: the permalink stops being
 * furniture in the header row and becomes a line on the thread it describes.
 * It was a 110px-wide read-only input holding a URL several times that long,
 * sitting in the meta row beside the author's name, on every thread, on the
 * minority of loads that had no clipboard.
 */
function CopyLink({ snag }: { snag: Snag }): VNode | null {
  const [copied, setCopied] = useState(false);
  const url = permalink(snag);
  if (!navigator.clipboard) return null;
  return (
    <button
      type="button"
      class="snag-dk-link"
      onClick={() =>
        void navigator.clipboard.writeText(url).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        )
      }
    >
      {format(copied ? "permalink.copied" : "permalink.copy")}
    </button>
  );
}

/**
 * …and where it does not: the URL as a LINE on the thread, not a field in its
 * header. `user-select:all` makes one click take the whole thing, which is
 * what a field was standing in for, and it wraps instead of being truncated to
 * a width that could never hold a URL.
 */
function PermalinkLine({ snag }: { snag: Snag }): VNode | null {
  if (navigator.clipboard) return null;
  return (
    <p class="snag-dk-permaline">
      <span class="snag-dk-permalabel">{format("permalink.copy")}</span>{" "}
      <span class="snag-dk-permaurl">{permalink(snag)}</span>
    </p>
  );
}

/**
 * WHO HOLDS IT, the dashboard's assignee in the widget.
 *
 * Read-only for everyone without `thread:assign`, and absent when nobody holds
 * it: a client reading "Assigned to: Unassigned" on every snag learns nothing.
 * With the permission it is a select, "Unassigned" plus the pool — fetched
 * once, on the first detail that draws it, and kept for the dock's lifetime:
 * the pool changes when somebody new writes, and a stale list for one session
 * costs a reload, not a wrong assignment (the server checks the pool again).
 * The current holder is always an option, even before the pool arrives or
 * when they have left it, so the select never shows a value it cannot name.
 */
let pool: Promise<import("../storage/types.ts").Reviewer[]> | null = null;

function Assignee({
  snag,
  list,
  onAssign,
}: {
  snag: Snag;
  list?: () => Promise<import("../storage/types.ts").Reviewer[]>;
  onAssign?: (id: string, who: import("../storage/types.ts").Reviewer | null) => void;
}) {
  const [people, setPeople] = useState<import("../storage/types.ts").Reviewer[]>([]);
  useEffect(() => {
    if (!list) return;
    pool ??= list().catch(() => ((pool = null), []));
    void pool.then(setPeople);
  }, [list]);
  const who = snag.assignee ?? null;
  if (!list || !onAssign) {
    return who ? (
      <p class="snag-dk-field">
        <span class="snag-dk-dim">{format("field.assignee")}</span> <strong>{who.name}</strong>
      </p>
    ) : null;
  }
  const options = who && !people.some((p) => p.id === who.id) ? [who, ...people] : people;
  return (
    <label class="snag-dk-field">
      <span class="snag-dk-dim">{format("field.assignee")}</span>
      <select
        class="snag-dk-select"
        value={who?.id ?? ""}
        onChange={(e) => {
          const id = (e.target as HTMLSelectElement).value;
          onAssign(snag.id, options.find((p) => p.id === id) ?? null);
        }}
      >
        <option value="">{format("assignee.none")}</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Detail({
  snags,
  round,
  fallbackCursor,
  openId,
  onOpen,
  onStatus,
  onReply,
  onEdit,
  onDeleteComment,
  onDeleteThread,
  isMine,
  canDeleteOwnThread = true,
  canModerate = false,
  canStatus = true,
  studio,
  assignees,
  onAssign,
  onShowAnyway,
  onAnnounce,
  loadShot,
}: DockProps & { round: Snag[]; fallbackCursor: number }) {
  // The anchored cursor: when the open thread has
  // fallen out of the filtered list — its status changed under an active
  // filter — the detail STAYS OPEN (fetched from the round) and the cursor
  // holds its last position, so `next` goes to what would have been its
  // successor rather than the panel blanking.
  const i = snags.findIndex((s) => s.id === openId);
  const present = i >= 0;
  const mine = (a: import("../storage/types.ts").Reviewer): boolean => (isMine ? isMine(a) : true);
  const at = present ? i : Math.min(fallbackCursor, snags.length);
  const snag = present ? snags[i] : round.find((s) => s.id === openId);
  const saved = openId ? (replyDrafts.get(openId) ?? "") : "";
  const [reply, setReply] = useState(saved);
  // Progressive: a bare "Add reply" until it is wanted, so a thread reads as a
  // thread rather than as a form with an empty box at the bottom — but a draft
  // already in progress opens straight back into the box holding it.
  const [replying, setReplying] = useState(saved.length > 0);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (replying) replyRef.current?.focus();
  }, [replying]);

  /** Every write to the draft goes through here, so nothing can forget to save. */
  const draft = (next: string): void => {
    setReply(next);
    if (!openId) return;
    if (next) replyDrafts.set(openId, next);
    else replyDrafts.delete(openId);
  };

  /**
   * WHO IS REPLYING — the composer's question, asked here too. The reply box
   * used to post under whatever this browser last called itself, or
   * "Anonymous" when it had never been asked: a client opening a link and
   * answering the studio's question had no way to say who they were, and a
   * studio member had no way in but leaving a new pin first. Same rules as
   * the composer: name and email once, remembered; or "Sign in".
   */
  const known = readIdentity();
  const [asking] = useState(!known.name);
  const [member, setMember] = useState(studio?.member ?? null);
  const [name, setName] = useState(known.name ?? "");
  const [email, setEmail] = useState(known.email ?? "");
  const [blocked, setBlocked] = useState(false);
  const badEmail = email.trim().length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canReply = !!reply.trim() && (!!member || !asking || (!!name.trim() && !badEmail));
  const signInNow = (): void => {
    if (!studio) return;
    setBlocked(false);
    // Inside the click, so the popup is a user-initiated window.
    void signIn(studio.host, studio.uid, studio.env).then((b) => {
      if (b === "blocked") return setBlocked(true);
      if (!b) return;
      studio.adopt(b);
      setMember(b.reviewer.name);
      replyRef.current?.focus();
    });
  };
  const sendReply = (): void => {
    if (!snag || !canReply) return;
    let who: string | undefined;
    if (member) who = member;
    else if (asking) {
      who = name.trim();
      writeIdentity({ name: who, ...(email.trim() ? { email: email.trim() } : {}) });
    }
    onReply(snag.id, reply.trim(), who);
    draft("");
    setReplying(false);
  };

  if (!snag) return null;
  const first = snag.comments[0];
  // The number ON THE PIN, which is its position within its own page — not its
  // index in a list that spans the whole round.
  // The pin's number comes from the UNFILTERED round — the circle here
  // must match the 3 on the page whatever the filter is doing.
  const ordinal = round.filter((x) => x.route === snag.route).findIndex((x) => x.id === snag.id) + 1;

  return (
    <div class="snag-dk-detail">
      <div class="snag-dk-detailhd">
        <button
          type="button"
          class="snag-dk-link"
          onClick={() => onOpen(null)}
          aria-label={format("dock.back.aria")}
        >
          <span aria-hidden="true">←</span> {format("dock.back")}
        </button>
        <span class="snag-dk-dim">
          {/* Absent from the filtered list: the count stays honest with a dash
              — the thread is open, its slot in the walk is remembered. */}
          {format("dock.position", { n: present ? count(at + 1) : "\u2013", total: count(snags.length) })}
        </span>
        <span class="snag-dk-nav">
          <button
            type="button"
            class="snag-dk-link"
            disabled={at <= 0}
            aria-label={format("dock.prev")}
            onClick={() => onOpen(snags[at - 1]!.id)}
          >
            ↑
          </button>
          <button
            type="button"
            class="snag-dk-link"
            disabled={present ? at >= snags.length - 1 : at >= snags.length}
            aria-label={format("dock.next")}
            onClick={() => onOpen(snags[present ? at + 1 : at]!.id)}
          >
            ↓
          </button>
        </span>
      </div>

      <div class="snag-dk-card">
        <div class="snag-dk-meta">
          {/* THE NUMBERED CIRCLE, in the pin's number and the pin's colour
              It is the ordinal↔pin map: the one thing
              tying "snag three" in the list, the 3 on the page and this panel
              into the same object. The design calls that the most load-bearing pixel
              in the list, and the detail was the only surface without it. */}
          <span
            class="snag-dk-num"
            style={{ background: statusColour(snag.status), color: statusInk(snag.status) }}
          >
            {ordinal}
          </span>
          <strong>{first?.author.name ?? format("author.unknown")}</strong>
          <span class="snag-dk-dim">{snag.key}</span>
          {first && <When iso={first.createdAt} />}
          <CopyLink snag={snag} />
        </div>
        {/* The seven-node subset, rendered as Preact nodes rather than
            as a string of HTML — see markdown.tsx for why that is the whole
            security story. The LIST ROW deliberately keeps its plain-text
            preview: one ellipsised line is not a place for formatting. */}
        <div class="snag-dk-cardbody">{renderMarkdown(first?.body ?? "")}</div>
        <PermalinkLine snag={snag} />
        {first && (mine(first.author) || canModerate) && (
          // Deleting the comment that OPENED the thread deletes the thread —
          // a pin with nothing behind it is a mark pointing at nothing — so the
          // control says "and its pin" rather than letting that be a surprise.
          // A reviewer gets it only while every comment in it is theirs
          // (deleting a thread someone has answered would delete their answer
          // too) and the session holds `thread:delete:own` — the server's two
          // rules. A studio owner or admin gets it on any thread.
          <CommentActions
            body={first.body}
            {...(mine(first.author) ? { onEdit: (next: string) => onEdit(first.id, next) } : {})}
            deleteLabel={format("comment.delete")}
            {...(canModerate || (canDeleteOwnThread && snag.comments.every((c) => mine(c.author)))
              ? { onDelete: () => onDeleteThread(snag.id) }
              : {})}
          />
        )}
      </div>

      {/* Status is a first-class field and the CLIENT can set it too: the round
          trip this product exists for is the studio asking and the client
          answering. Colour is the primary signal and is shared with the pin. */}
      {canStatus ? (
        <label class="snag-dk-field">
          <span class="snag-dk-dim">{format("field.status")}</span>
          <select
            class="snag-dk-select"
            style={{ borderColor: statusColour(snag.status) }}
            value={snag.status}
            onChange={(e) => {
              const next = (e.target as HTMLSelectElement).value as Status;
              onStatus(snag.id, next);
              onAnnounce?.(format("announce.status", { key: snag.key, status: statusLabel(next) }));
            }}
          >
            {STATUS_ORDER.map((k) => (
              <option key={k} value={k}>
                {statusLabel(k)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        // Read-only, in the same place: the status is still the field a client
        // reads first, and the reason sits beside it rather than in an error
        // after they tried.
        <p class="snag-dk-field" data-status-locked>
          <span class="snag-dk-dim">{format("field.status")}</span>
          <strong>{statusLabel(snag.status)}</strong>
          <span class="snag-dk-dim">{format("field.status.locked")}</span>
        </p>
      )}

      <Assignee snag={snag} {...(assignees && onAssign ? { list: assignees, onAssign } : {})} />

      {/* THE CAPTURE BLOCK — four lines, replacing the one
          that used to say `route · breakpoint · where`.

          At v0 this is always annotation mode: screenshots are v0.1, so the design
          is explicit that "there is no thumbnail and no empty frame — the text
          lines stand alone". Built as the whole block rather than as a
          conditional-empty thumbnail column, because an empty frame is exactly
          what it says not to draw. */}
      <CaptureBlock snag={snag} {...(loadShot ? { loadShot } : {})} />

      {/* The hidden-anchor note, with its override: "Show
          anyway" asks the runtime to scroll to the RECORDED document
          coordinates and draw the ghost there — never a viewport fraction. */}
      {snag.anchorReasons?.includes("hidden") && (
        <p class="snag-dk-moved-note">
          {format("detail.hidden")}{" "}
          <button type="button" class="snag-dk-link" onClick={() => onShowAnyway?.(snag)}>
            {format("detail.hidden.show")}
          </button>
        </p>
      )}

      {/* The anchor note. Conditional, because a settled anchor needs
          no explanation — and at v0, with no screenshot, this sentence plus the
          label is the whole of what an orphaned comment has left to say. */}
      {snag.anchorState !== "anchored" && (
        <p class="snag-dk-moved-note">
          {format(`detail.${snag.anchorState}`, { label: snag.anchor.label })}
          {/* F-04b: name the steps that never ran, beside the verdict they
              could not improve. */}
          {snag.anchorReasons?.includes("budget-exceeded") && ` ${format("detail.unavailable")}`}
        </p>
      )}

      {snag.anchorState !== "anchored" && <AnchorDetails anchor={snag.anchor} />}

      {snag.comments.length > 1 && (
        <ul class="snag-dk-replies-list">
          {snag.comments.slice(1).map((c) => (
            <li key={c.id}>
              <strong>{c.author.name}</strong> <When iso={c.createdAt} />
              {renderMarkdown(c.body ?? "")}
              {(mine(c.author) || canModerate) && (
                <CommentActions
                  body={c.body}
                  {...(mine(c.author) ? { onEdit: (next: string) => onEdit(c.id, next) } : {})}
                  deleteLabel={format("reply.delete")}
                  onDelete={() => onDeleteComment(c.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {replying ? (
        <div class="snag-dk-replybox">
          {member ? (
            <p class="snag-dk-who">
              {format("who.member", { name: member })}{" "}
              <button
                type="button"
                class="snag-dk-link"
                onClick={() => {
                  studio?.signOut();
                  setMember(null);
                }}
              >
                {format("who.signout")}
              </button>
            </p>
          ) : (
            asking && (
              <>
                <input
                  class="snag-input"
                  type="text"
                  autocomplete="name"
                  placeholder={format("who.name")}
                  aria-label={format("who.name")}
                  value={name}
                  onInput={(e) => setName((e.target as HTMLInputElement).value)}
                />
                <input
                  class={`snag-input${badEmail ? " snag-input--bad" : ""}`}
                  type="email"
                  inputMode="email"
                  autocomplete="email"
                  placeholder={format("who.email")}
                  aria-label={format("who.email")}
                  aria-invalid={badEmail ? "true" : undefined}
                  value={email}
                  onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
                />
                {badEmail && <p class="snag-dk-who">{format("who.email.bad")}</p>}
              </>
            )
          )}
          {studio && !member && (
            <p class="snag-dk-who">
              <button type="button" class="snag-dk-link" onClick={signInNow}>
                {format("who.signin")}
              </button>
              {blocked && <span role="status"> {format("who.signin.blocked")}</span>}
            </p>
          )}
          <textarea
            ref={replyRef}
            class="snag-text"
            rows={2}
            enterkeyhint="enter"
            aria-label={format("reply.aria")}
            placeholder={format("reply.placeholder")}
            value={reply}
            onInput={(e) => draft((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                sendReply();
              }
              /**
               * Escape BLURS. It does not discard.
               *
               * The design says so in as many words — "`Esc` blurs and never
               * discards" — and this handler used to call `setReply("")`,
               * which is the exact opposite: a reflex press mid-sentence,
               * the most natural thing in the world when a panel is open,
               * deleted the sentence. It still stops propagation, or the
               * dock's own Escape would close the thread over the top.
               */
              if (e.key === "Escape") {
                e.stopPropagation();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
          />
          <div class="snag-actions">
            <button
              type="button"
              class="snag-cancel"
              onClick={() => {
                // The explicit Cancel is the one control that MAY discard —
                // it is a decision, not a reflex.
                draft("");
                setReplying(false);
              }}
            >
              {format("action.cancel")}
            </button>
            <button
              type="button"
              class="snag-send"
              disabled={!canReply}
              onClick={sendReply}
            >
              {format("reply.send")}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" class="snag-dk-addreply" onClick={() => setReplying(true)}>
          {format("reply.add")}
        </button>
      )}
    </div>
  );
}

function Dock(props: DockProps) {
  const open = props.openId ? props.snags.find((s) => s.id === props.openId) : null;
  const ref = useRef<HTMLElement>(null);

  // Grouped ONCE, here, and the detail walks the flattened result.:
  // prev/next iterates "the same order the list is showing — so triage order and
  // reading order never disagree". Sorting in two places is how they start to.
  //
  // The cluster filter narrows the GROUPS, never the numbering
  // base: pin ordinals are positions among a page's rendered pins, and a
  // filtered list that renumbered them would break "snag three" meaning the
  // same object to two people.
  const shown = props.clusterFilter
    ? props.snags.filter((s) => props.clusterFilter!.includes(s.id))
    : props.snags;
  // The two halves in sequence: the pin-governing quartet narrows what
  // the round IS right now; the list-only quartet narrows what you are
  // reading. Date sorts flatten (grouped only "when sorted By
  // page"), rendered as one header-less group so the walker's "same order
  // the list is showing" needs no second code path.
  const narrowed = listNarrow(
    shown.filter((s) => pinPass(s, props.filter, props.seenAt)),
    props.filter,
    props.route,
    props.seenAt,
  );
  const pipeline = sortSnags(narrowed, props.filter.sort);
  const groups =
    props.filter.sort === "page"
      ? grouped(pipeline, props.route)
      : [{ route: "", here: false, snags: pipeline }];
  const ordered = groups.flatMap((g) => g.snags);

  // The anchored cursor: while the open thread is IN the filtered list the
  // cursor rides it; when a status change drops it out, the last position
  // holds so `next` lands on what would have been its successor.
  const walkAt = useRef(0);
  const iOpen = ordered.findIndex((x) => x.id === props.openId);
  if (iOpen >= 0) walkAt.current = iOpen;

  // `‹ Back` from a row the filter has since hidden lands on the
  // list with one inline notice. Tracked at render time — the transition is
  // "openId became null while the last open thread was absent from ordered".
  const lastOpen = useRef<{ id: string; absent: boolean } | null>(null);
  const [hiddenNote, setHiddenNote] = useState<string | null>(null);
  if (props.openId) {
    lastOpen.current = { id: props.openId, absent: iOpen === -1 };
    if (hiddenNote) setHiddenNote(null);
  } else if (lastOpen.current?.absent && hiddenNote !== lastOpen.current.id) {
    setHiddenNote(lastOpen.current.id);
    lastOpen.current = null;
  }

  /**
   * Keep focus in the panel across view changes.
   *
   * On open, because a panel opened from a button otherwise leaves a keyboard
   * user's focus behind it — and Escape then fires at whatever they left rather
   * than at the thing they just opened. On every push and pop of the stack too,
   * because the control that was activated (a list row, the back button) is
   * destroyed by the very navigation it triggered, dropping focus to the body.
   *
   * Keyed on `openId`, NOT on every render: a repaint must never yank focus out
   * of a reply someone is part-way through typing.
   */
  useEffect(() => {
    ref.current?.focus();
  }, [props.openId]);

  // The fold-back: the reply composer rides above the keyboard
  // while the SHEET HEIGHT does not change — the padding absorbs the lift and
  // the conversation area is what shrinks. Coarse only; kb.ts's mechanics.
  useEffect(() => {
    if (!(window.matchMedia?.("(pointer: coarse)").matches ?? false)) return;
    const el = ref.current;
    return el ? liftOnKeyboard(el) : undefined;
  }, []);

  /**
   * The status chords — `1`–`4` and `R` (v0).
   *
   * This is the studio's triage speed and the reason the walker exists at all:
   * working forty comments through a <select> is forty round trips of
   * click-open-choose-close. With the chords it is forty keystrokes.
   *
   * EDITABLE-CONTEXT DETECTION USES composedPath(), NEVER target — the design
   * is explicit, because `target` is retargeted to the shadow HOST for an event
   * originating inside a host app's own shadow root, which makes a reply
   * textarea indistinguishable from the page behind it. Typing "1" into a reply
   * must not silently change the status of the comment being replied to.
   *
   * IT LIVES ON THE DOCK, NOT ON THE DETAIL, and reads the open snag through a
   * ref. Both halves of that were bugs first. On the detail the listener was
   * bound per mount and per status change, and Preact defers effects by a frame:
   * a key pressed in the frame after a row was clicked reached nothing, and `R`
   * pressed twice inside one frame read a stale "open" the second time and set
   * resolved twice. Here the listener exists for as long as the panel does, and
   * the snag it acts on is whatever the last render says it is — "with the
   * detail open" is a guard on the event, not a lifecycle to race.
   */
  // `can` rides the same ref: a session whose permissions change on a refresh
  // gets inert chords from the next render, not the next mount.
  const live = useRef({ snag: open, onStatus: props.onStatus, can: props.canStatus !== false });
  live.current = { snag: open, onStatus: props.onStatus, can: props.canStatus !== false };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { snag, onStatus, can } = live.current;
      if (!snag || !can) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const editable = e
        .composedPath()
        .some((n) => {
          const el = n as HTMLElement;
          if (!el?.tagName) return false;
          const tag = el.tagName.toLowerCase();
          if (tag === "textarea" || tag === "select") return true;
          if (tag === "input") return !/^(button|submit|checkbox|radio)$/i.test((el as HTMLInputElement).type);
          if (el.isContentEditable) return true;
          return /^(textbox|searchbox|combobox)$/.test(el.getAttribute?.("role") ?? "");
        });
      if (editable) return;

      const n = Number(e.key);
      if (n >= 1 && n <= STATUS_ORDER.length) {
        e.preventDefault();
        onStatus(snag.id, STATUS_ORDER[n - 1]!);
        return;
      }
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        // A TOGGLE, not a set: The design says "Resolved ↔ Active". Pressing it twice
        // is how somebody undoes a mis-hit without reaching for the dropdown.
        onStatus(snag.id, snag.status === "resolved" ? "open" : "resolved");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const coarseD = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return (
    <aside
      ref={ref}
      class="snag-dk"
      role="complementary"
      aria-label={format("dock.aria")}
      tabIndex={-1}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        // Escape steps back up the stack before it closes the dock — losing the
        // whole panel because you wanted to leave one comment is a surprise.
        // (The menu is the rung above this one, but it owns its own state and
        // stops Escape in FilterBar before it ever reaches here.)
        if (props.openId) props.onOpen(null);
        else props.onClose();
      }}
    >
      {/* The scrim: tap dismisses the WHOLE sheet — the chevron is
          up, the scrim is out. z-index:-1 keeps it visually behind the sheet
          it sibling-precedes; touch-action:none scrolls nothing. */}
      {coarseD && <div class="snag-dk-scrim" aria-hidden="true" onClick={props.onClose} />}
      {coarseD && (
        <div
          class="snag-dk-grab"
          aria-hidden="true"
          onPointerDown={(e) => {
            const y0 = e.clientY;
            const el = e.currentTarget as HTMLElement;
            try {
              el.setPointerCapture(e.pointerId);
            } catch {
              /* a synthetic pointer has no capture to take */
            }
            el.onpointermove = (ev) => {
              if (ev.clientY - y0 > 56) {
                el.onpointermove = null;
                props.onClose(); // swipe-down = the scrim's gesture twin
              }
            };
            el.onpointerup = () => (el.onpointermove = null);
          }}
        >
          <span />
        </div>
      )}
      <header class="snag-dk-hd">
        {/* The list's title IS the round when there is more than one: which
            round you are looking at is the first thing the panel answers, and
            a separate bar for it spent a row saying so. A native select keeps
            the keyboard and the screen-reader contract for free; it is styled
            as a title with a chevron. An empty round keeps it too — that is
            the normal state, and the way back to the round holding the work. */}
        {!open && props.rounds && props.rounds.length > 1 && props.onRound ? (
          <span class="snag-dk-roundwrap">
            <select
              class="snag-dk-round"
              aria-label={format("round.label")}
              value={String(props.activeRound ?? "")}
              onChange={(e) => props.onRound!(Number((e.currentTarget as HTMLSelectElement).value))}
            >
              {props.rounds.map((r) => (
                <option value={String(r.number)} key={r.number}>
                  {r.name}
                  {r.closed ? ` ${format("round.closed")}` : ""}
                </option>
              ))}
            </select>
            <svg class="snag-dk-roundcaret" width="10" height="10" viewBox="0 0 8 8" aria-hidden="true">
              <path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" stroke-width="1.4" />
            </svg>
          </span>
        ) : (
          <strong>{format(open ? "dock.title.detail" : "dock.title.list")}</strong>
        )}
        <button
          type="button"
          class="snag-dk-link"
          onClick={props.onClose}
          aria-label={format("dock.close")}
        >
          ✕
        </button>
      </header>
      {/* Keyed by snag: prev/next must not carry a half-typed reply from the
          comment you just left into the one you just arrived at. */}
      {open ? (
        <Detail key={open.id} {...props} snags={ordered} round={props.snags} fallbackCursor={walkAt.current} />
      ) : (
        <List
          {...props}
          groups={groups}
          hiddenNote={hiddenNote}
          onHiddenShow={(id) => {
            setHiddenNote(null);
            props.onOpen(id);
          }}
        />
      )}
    </aside>
  );
}

const W = 360;

const CSS = `
.snag-dk{position:fixed;inset-block:0;inset-inline-end:0;width:${W}px;max-width:100vw;z-index:${LAYER.dock};
  background:${t.bg};color:${t.fg};display:flex;flex-direction:column;
  font:400 13px/1.45 ${t.font};box-shadow:${t.shadow};border-inline-start:1px solid ${t.border};
  pointer-events:auto;overscroll-behavior:contain}
.snag-dk-filters{padding:10px 14px 6px;border-block-end:1px solid ${t.border};display:grid;gap:8px;flex:0 0 auto}
/* The glyph sits INSIDE the field, so the field reads as search at a glance.
   currentColor in the muted token — under a forced palette muted is
   CanvasText, so the glyph follows the system ink with no rule of its own. */
.snag-dk-searchwrap{position:relative;display:flex}
.snag-dk-searchicon{position:absolute;inset-inline-start:9px;top:50%;transform:translateY(-50%);
  color:${t.muted};pointer-events:none}
.snag-dk-search{width:100%;box-sizing:border-box;font-size:12px;padding:6px 8px;padding-inline-start:28px}
.snag-dk-chiphead{display:flex;justify-content:space-between;align-items:center;margin-block-end:-4px}
.snag-dk-chiphead .snag-dk-menutitle{padding:0}
.snag-dk-selectall{font-size:11px;letter-spacing:.06em;text-transform:uppercase;padding:2px 4px;
  margin-inline-end:-4px}
.snag-dk-chips{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.snag-dk-chip{font:500 12px/1.2 ${t.font};color:${t.fg};padding:7px 10px;border-radius:6px;
  border:1px solid ${t.border};background:none;cursor:pointer;text-align:start;display:flex;
  align-items:center;gap:7px;min-width:0;transition:background ${t.motion},border-color ${t.motion}}
.snag-dk-chip:hover{background:${t.hover}}
.snag-dk-chip:focus-visible{outline:2px solid ${t.focus};outline-offset:1px}
.snag-dk-chip[aria-pressed="true"]{font-weight:600}
/* The dot keeps its status colour under a forced palette — it is the one
   place the colour is the point, and the label beside it carries the word. */
.snag-dk-chipdot{flex:0 0 8px;width:8px;height:8px;border-radius:50%;forced-color-adjust:none}
.snag-dk-chiplabel{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.snag-dk-chipn{flex:0 0 auto;color:${t.muted};font-variant-numeric:tabular-nums}
.snag-dk-chip-stray{color:${t.muted};cursor:default}
.snag-dk-chip-stray:hover{background:none}
@media (forced-colors:active){
  .snag-dk-chip[aria-pressed="true"]{border:2px solid Highlight;padding:6px 9px}
}
.snag-dk-menus{display:flex;gap:4px;position:relative;margin-inline-start:-6px}
/* Above the scrim, so with one menu open a click on the OTHER trigger
   switches menus in one click instead of only dismissing. */
.snag-dk-trigger{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:500;
  position:relative;z-index:3}
.snag-dk-menuwrap{position:relative}
/* Both of these sit ABOVE the list, and the numbers are the whole rule.
   .snag-dk-grouphd is a sticky header with z-index:1, and it lives LATER in
   the DOM than these do -- so at equal z-index it won, and an open menu was
   painted over by a thread row. Equal z-index is decided by document order,
   and document order is not what "the menu is on top" means. The scrim goes
   above the list too: clicking a row while a menu is open should dismiss the
   menu, not open that thread.

   Sort and Filter are two menus again (0.1.21), but EXCLUSIVE — one state
   holds which is open — so they never have to be stacked against each other. */
/* Each facet in the Filter menu is a labelled group: who and where, then the
   round's Clear all. */
.snag-dk-menugroup{display:flex;flex-direction:column;gap:1px;padding-bottom:6px;margin-bottom:6px;
  border-bottom:1px solid ${t.border}}
.snag-dk-menugroup-last{padding-bottom:0;margin-bottom:0;border-bottom:0}
.snag-dk-menutitle{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${t.muted};
  padding:2px 8px 4px}
.snag-dk-menubg{position:absolute;inset:-200px -20px -2000px;background:transparent;z-index:2}
.snag-dk-menu{position:absolute;inset-block-start:100%;inset-inline-start:0;z-index:3;min-width:150px;
  background:${t.bg};border:1px solid ${t.border};border-radius:6px;box-shadow:${t.shadow};
  display:grid;padding:4px}
.snag-dk-menu button{font:400 12px/1.3 ${t.font};color:${t.fg};background:none;border:0;
  text-align:start;padding:5px 8px;border-radius:4px;cursor:pointer;display:flex;gap:4px}
.snag-dk-menu button:hover{background:color-mix(in srgb, ${t.fg} 8%, transparent)}
/* The footer is the last row, so its menu grows up rather than down. */
.snag-dk-menus-up{position:relative}
.snag-dk-menu-up{inset-block-start:auto;inset-block-end:100%;margin-block-end:4px}
.snag-dk-menu-form{padding:8px;gap:6px;min-width:224px}
.snag-dk-menu-form label:not(.snag-dk-pageonly){display:grid;gap:2px;font:600 10px/1.4 ${t.font};
  letter-spacing:.05em;text-transform:uppercase;color:${t.muted}}
.snag-dk-menu-form select{font:400 12px/1.3 ${t.font};color:${t.fg};background:${t.bg};
  border:1px solid ${t.border};border-radius:4px;padding:4px}
.snag-dk-pageonly{display:flex;align-items:center;gap:6px;font-size:12px;color:${t.fg};cursor:pointer}
.snag-dk-permaline{margin:6px 0 0;font-size:11px;color:${t.muted};overflow-wrap:anywhere}
.snag-dk-permalabel{font-weight:600}
.snag-dk-permaurl{user-select:all}
/* Focused programmatically on open, so it must not draw a focus ring for it. */
.snag-dk:focus{outline:none}
/* On a coarse pointer the toolbar is a fixed bottom bar in the same corner as
   this sheet. Padding the SHEET (not its scrollers) is what matters: the footer
   holding the export buttons is a sibling pinned to the sheet's bottom edge, so
   padding the list left it underneath the toolbar and completely unreachable.
   --snag-tb-h is published by the toolbar, which knows its own safe-area inset. */
@media (pointer:coarse){
  /* ONE sheet, 82vh for list and detail alike — the sheet never
     grows. The keyboard offset rides the BOTTOM INSET (never the height):
     The fold-back — the sheet lifts, its height does not change, and the
     scrolling region inside is what shrinks. */
  .snag-dk{inset-block-start:auto;inset-inline-start:0;width:auto;height:82vh;border-radius:14px 14px 0 0;
    box-sizing:border-box;
    padding-bottom:max(var(${CSS_VAR.tbH},68px), var(${CSS_VAR.kb},0px));
    padding-inline:env(safe-area-inset-left) env(safe-area-inset-right)}
  .snag-dk-scrim{position:fixed;inset:0;background:#0005;touch-action:none;z-index:-1}
  .snag-dk-grab{display:flex;justify-content:center;padding:10px 0 4px;touch-action:none}
  .snag-dk-grab span{width:36px;height:4px;border-radius:2px;background:${t.border}}
  /* The table: 44px controls, ≥56px rows, on the surface thumbs use. */
  .snag-dk-item{min-height:56px}
  .snag-dk-link{min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center}
  .snag-dk-select{min-height:44px}
  .snag-dk-chip{min-height:44px}
  .snag-dk-search{min-height:44px}
  .snag-dk-round{min-height:44px}
}
@media (pointer:fine){.snag-dk-scrim,.snag-dk-grab{display:none}}
.snag-dk-hd{display:flex;justify-content:space-between;align-items:center;gap:8px;
  padding:12px 14px;border-bottom:1px solid ${t.border};flex:0 0 auto}
/* The SCROLLER is the group wrapper, not the list: with one <ul> per page, a
   scrolling <ul> would give every group its own scrollbar and none of them the
   full height. */
.snag-dk-scroll{overflow-y:auto;flex:1 1 auto}
.snag-dk-list{list-style:none;margin:0;padding:0}
/* Sticky, so the page a row belongs to is never off-screen while you read it —
   which is the whole reason the route moved out of the rows and into a header. */
.snag-dk-grouphd{position:sticky;top:0;z-index:1;margin:0;display:flex;align-items:center;gap:8px;
  padding:7px 14px;font:600 11px/1.45 ${t.font};letter-spacing:.02em;
  background:${t.sunken};border-bottom:1px solid ${t.border}}
/* A URL path is LTR content whatever the page's direction, and its leading "/"
   is a bidi-NEUTRAL character — so under RTL the browser moved it to the other
   end and the header read "demo.html/". Isolate rather than merely set
   direction, or the path would still reorder against the text beside it.
   Found by turning the demo page RTL and looking at it. */
.snag-dk-route{color:${t.fg};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;
  direction:ltr;unicode-bidi:isolate}
/* Not a colour alone: the marker carries the word. */
.snag-dk-grouphd .snag-dk-dim{margin-inline-start:auto;font-weight:400;flex:0 0 auto}
/* The leaves-this-page glyph. Muted until the row is pointed at, so a list that
   is mostly other pages does not read as a column of arrows. */
.snag-dk-goto{flex:0 0 auto;color:${t.muted};font-size:13px;line-height:1}
.snag-dk-dev{flex:0 0 auto;color:${t.muted};display:flex;align-items:center}
.snag-dk-item:hover .snag-dk-goto,.snag-dk-item:focus-visible .snag-dk-goto{color:${t.accent}}
.snag-dk-item{display:flex;gap:10px;align-items:flex-start;width:100%;text-align:start;background:transparent;
  border:0;border-bottom:1px solid ${t.border};color:inherit;font:inherit;padding:11px 14px;cursor:pointer;
  transition:background ${t.motion}}
.snag-dk-item:hover{background:${t.hover}}
.snag-dk-item:focus-visible{outline:2px solid ${t.focus};outline-offset:-2px}
/* The unread dot. The slot is always there and only the paint changes,
   so reading a thread does not shuffle the row it was on. */
.snag-dk-dot{flex:0 0 7px;width:7px;height:7px;border-radius:50%;margin-block-start:8px;
  background:transparent}
.snag-dk-dot--on{background:${t.accent}}
/* The activity pill sits between the filter bar and the list: it is a state of
   the list, not a facet of the menu. */
.snag-dk-newpill{margin-inline-start:auto;font-weight:600;white-space:nowrap}
.snag-dk-newpill[aria-pressed="true"]{background:${t.sunken};border-radius:6px}
.snag-dk-newpill:hover{background:${t.hover}}
.snag-dk-newpill:focus-visible{outline:2px solid ${t.focus};outline-offset:-2px}
.snag-dk-num{flex:0 0 22px;height:22px;border-radius:50% 50% 50% 2px;font-weight:600;
  font-size:11px;line-height:1;display:flex;align-items:center;justify-content:center;box-sizing:border-box}
/* The row's badge IS the pin, at list size — one shape, and the state carried
   by the rings: status colours the fill, anchor state rings it. An orphan takes
   two rings here too, or the list and the page would disagree about the one
   thing this state exists to say. */
/* Ring WEIGHT, not hue and not shape — see pinStyle's note. currentColor is
   the status ink the row already sets inline, so both rings track the fill. */
.snag-dk-num--orphaned{border:2px solid currentColor;box-shadow:inset 0 0 0 2px currentColor}
.snag-dk-num--approximate{border:2px dashed currentColor}
.snag-dk-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.snag-dk-body,.snag-dk-sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.snag-dk-sub{font-size:11px}
.snag-dk-dim{color:${t.muted}}
.snag-dk-moved{color:${t.anchorOrphan};font-weight:600}
.snag-dk-replies{background:${t.surface};border-radius:999px;padding:1px 7px;font-size:11px;flex:0 0 auto}
.snag-dk-empty{padding:28px 16px;text-align:center;flex:1 1 auto}
.snag-dk-empty p{margin:0 0 4px}
.snag-dk-notice{margin:0;padding:11px 14px;font-size:12px;color:${t.muted};
  border-bottom:1px solid ${t.border};flex:0 0 auto}
/* The header's round select, dressed as the title it replaces. */
.snag-dk-roundwrap{position:relative;display:inline-flex;align-items:center;min-width:0;flex:0 1 auto}
.snag-dk-round{appearance:none;-webkit-appearance:none;background:${t.sunken};border:1px solid ${t.border};color:${t.fg};
  font:600 13px/1.45 ${t.font};padding-block:4px;padding-inline:10px 26px;border-radius:6px;
  cursor:pointer;max-width:100%;text-overflow:ellipsis;transition:background ${t.motion}}
.snag-dk-round:hover{background:${t.hover}}
.snag-dk-round:focus-visible{outline:2px solid ${t.focus};outline-offset:1px}
.snag-dk-round option{background:${t.bg};color:${t.fg};font-weight:400}
.snag-dk-roundcaret{position:absolute;inset-inline-end:10px;color:${t.muted};pointer-events:none}
.snag-dk-foot{display:flex;gap:6px;padding:10px 14px;border-top:1px solid ${t.border};flex:0 0 auto}
.snag-dk-link{background:transparent;border:0;color:${t.accent};font:inherit;cursor:pointer;
  padding:4px 6px;border-radius:calc(${t.radius} - 2px);transition:background ${t.motion}}
.snag-dk-link:hover:not(:disabled){background:${t.hover}}
.snag-dk-link:disabled{color:${t.disabled};cursor:not-allowed}
.snag-dk-link:focus-visible{outline:2px solid ${t.focus};outline-offset:1px}
.snag-dk-detail{padding:12px 14px;overflow-y:auto;flex:1 1 auto;display:flex;flex-direction:column;gap:12px}
.snag-dk-detailhd{display:flex;align-items:center;justify-content:space-between;gap:8px}
.snag-dk-nav{display:flex;gap:2px}
.snag-dk-card{background:${t.surface};border-radius:${t.radius};padding:11px}
.snag-dk-meta{display:flex;justify-content:space-between;gap:8px;font-size:12px;margin-bottom:6px}
/* The rendered subset. Tight vertical rhythm — a comment is three sentences,
   not an article — and pre-wrap on paragraphs so a single Enter still shows
   as a line break, which is what somebody pressing it once meant. */
.snag-md{overflow-wrap:anywhere}
.snag-md>*{margin:0}
.snag-md>*+*{margin-block-start:6px}
.snag-md p{white-space:pre-wrap}
.snag-md ul,.snag-md ol{padding-inline-start:20px}
.snag-md li+li{margin-block-start:2px}
/* ui-monospace already resolves to the platform's UI mono — SF Mono on Apple,
   Cascadia on Windows — so naming them again is a stack for engines that do not
   exist inside our support floor. */
.snag-md code{background:${t.sunken};border-radius:3px;padding:1px 4px;font-size:.92em;
  font-family:ui-monospace,monospace}
.snag-md pre{background:${t.sunken};border-radius:${t.radius};padding:8px 10px;overflow-x:auto}
/* The <code> inside a fence must not take the inline chip styling with it. */
.snag-md pre code{background:none;padding:0;font-size:.92em}
.snag-md a{color:${t.accent}}
.snag-dk-field{display:flex;flex-direction:column;gap:4px;font-size:12px}
.snag-dk-select{background:${t.surface};color:inherit;border:2px solid;border-radius:${t.radius};
  padding:7px 9px;font:inherit;min-height:34px}
/* A resolved row, greyed and struck. The strike is what survives a
   greyscale screenshot and a colour-blind reader; the grey alone would not. */
.snag-dk-done{color:${t.muted};text-decoration:line-through}
.snag-dk-meta .snag-dk-num{margin-inline-end:2px}
.snag-dk-cap{background:${t.sunken};border-radius:${t.radius};padding:9px 11px;
  display:flex;flex-direction:column;gap:1px;font-size:12px;overflow-wrap:anywhere}
.snag-dk-cap p{margin:0}
.snag-dk-shot{padding:0;border:1px solid ${t.border};border-radius:calc(${t.radius} - 2px);
  background:none;cursor:zoom-in;overflow:hidden;line-height:0;align-self:flex-start;margin-block-end:6px}
.snag-dk-shot canvas{display:block;max-width:100%}
/* The lightbox covers the VIEWPORT, not the dock: the picture is the point,
   and 142px of it inside a 360px rail is not looking at a screenshot. */
.snag-dk-lightbox{position:fixed;inset:0;z-index:1;background:#000c;display:flex;
  align-items:center;justify-content:center;padding:24px;cursor:zoom-out}
.snag-dk-lightbox canvas{max-width:100%;max-height:100%;object-fit:contain;
  box-shadow:${t.shadow};background:${t.bg}}
.snag-dk-lightclose{position:absolute;inset-block-start:12px;inset-inline-end:16px;color:#fff}
/* The label line is the only one that is a label; the three under it are data. */
.snag-dk-caplabel{font-weight:600;font-size:11px;letter-spacing:.02em;margin-bottom:3px!important}
.snag-dk-capwhy{color:${t.muted};font-size:11px;margin-top:5px!important}
/* The same red the orphan ring uses. One "this is not what it looks like"
   colour in the widget, and the note carries the WORDS as well. */
.snag-dk-moved-note{margin:0;padding:8px 10px;font-size:12px;background:${t.sunken};
  border-inline-start:3px solid ${t.anchorOrphan};border-radius:${t.radius}}
/* The Details. Collapsed by default: the reader who needs a selector is
   debugging, and everyone else is reading a comment. */
.snag-dk-anchor{font-size:12px;border:1px solid ${t.border};border-radius:${t.radius};
  padding:6px 10px;background:${t.sunken}}
.snag-dk-anchor summary{cursor:pointer;color:${t.muted};font-weight:600;list-style:revert}
.snag-dk-anchor dl{margin:8px 0 2px;display:grid;gap:6px}
.snag-dk-anchor dt{color:${t.muted};font-size:11px;letter-spacing:.03em;text-transform:uppercase}
/* user-select:text explicitly — the shadow root's own reset turns it off, and
   selecting the selector IS the interaction (navigator.clipboard is
   secure-context only, so a copy button would fail on a LAN staging site). */
.snag-dk-anchor dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  overflow-wrap:anywhere;user-select:text}
.snag-dk-replies-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.snag-dk-replies-list li{background:${t.sunken};border-radius:${t.radius};padding:9px;overflow-wrap:anywhere}
/* Edit and Delete, behind one ellipsis.
   They used to rest at opacity:0 and appear on :hover or :focus-within. The
   restraint was right — a panel showing two destructive-looking words beside
   every line reads as a settings screen — but a touch device has no hover, so
   on a phone they were invisible and merely still tappable. The ellipsis keeps
   the quiet and is a control you can see. */
.snag-dk-acts{display:flex;gap:2px;margin-top:6px}
.snag-dk-act{background:transparent;border:0;color:${t.muted};font:inherit;font-size:11px;cursor:pointer;
  padding:3px 6px;border-radius:calc(${t.radius} - 3px);transition:background ${t.motion},color ${t.motion}}
.snag-dk-more{font-size:14px;line-height:1;letter-spacing:1px}
.snag-dk-act:hover{background:${t.hover};color:inherit}
.snag-dk-act:focus-visible{outline:2px solid ${t.focus};outline-offset:1px}
.snag-dk-act--danger:hover{color:${t.anchorOrphan}}
.snag-dk-menu .snag-dk-act--danger{color:${t.fg}}
.snag-dk-menu .snag-dk-act--danger:hover{color:${t.anchorOrphan}}
/* Armed. The colour is the same red the orphan ring uses — there is one "this
   is not reversible" colour in the widget, and inventing a second would make
   both mean less. */
.snag-dk-armed{color:${t.anchorOrphan};font-weight:600}
.snag-dk-clear{margin-inline-start:auto}
.snag-dk-menu .snag-dk-clear{margin-inline-start:0}
.snag-dk-editbox{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.snag-dk-addreply{background:transparent;border:1px dashed ${t.border};color:${t.muted};
  border-radius:${t.radius};padding:9px;font:inherit;cursor:pointer;text-align:start;
  transition:border-color ${t.motion},color ${t.motion}}
.snag-dk-addreply:hover{border-color:${t.accent};color:inherit}
.snag-dk-replybox{display:flex;flex-direction:column;gap:8px}
.snag-dk-who{margin:0;font-size:11px;color:${t.muted}}
.snag-dk-who .snag-dk-link{padding:0;font-size:inherit;text-decoration:underline}
`;

export interface DockHandle {
  update(props: DockProps): void;
  close(): void;
}

/**
 * Mount the dock into the widget's shadow root.
 *
 * Publishes its width as `--snag-dock-w` on the shadow HOST, which the toolbar's
 * fine-pointer rule reads: the default toolbar corner is bottom-right, exactly
 * where the dock lands, and a toolbar floating over the export buttons is the
 * kind of collision that only shows up on screen. Custom properties inherit
 * through the shadow boundary and survive the toolbar's `:host{all:initial}`.
 */
export function openDock(root: ShadowRoot, props: DockProps, parent?: Element): DockHandle {
  const doc = root.ownerDocument ?? document;
  adopt(root, "form", FORM_CSS);
  adopt(root, "dock", CSS);

  const host = doc.createElement("div");
  (parent ?? root).appendChild(host);

  const coarse = doc.defaultView?.matchMedia?.("(pointer: coarse)").matches ?? false;
  const shift = (on: boolean): void => {
    const el = root.host as HTMLElement;
    // CSS_VAR.dockW, not the literal: The design forbids a hard-coded token in
    // src/, and the toolbar reads the same name from the same registry entry —
    // a rename that touched one and not the other would put the toolbar back
    // underneath the dock's export buttons.
    if (on && !coarse) el.style.setProperty(CSS_VAR.dockW, `${W}px`);
    else el.style.removeProperty(CSS_VAR.dockW);
  };
  shift(true);

  const paint = (p: DockProps): void => {
    render(<Dock {...p} />, host);
  };
  paint(props);

  return {
    update: paint,
    close() {
      shift(false);
      render(null, host); // let Preact unmount cleanly before the node goes
      host.remove();
    },
  };
}
