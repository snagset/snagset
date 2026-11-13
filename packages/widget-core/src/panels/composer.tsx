import { render } from "preact";
import { useState, useRef, useEffect } from "preact/hooks";
import { DISCLOSURE_KEY, CSS_VAR, hostAttr } from "@snagset/types/names";
import { readIdentity, writeIdentity, type Identity } from "../storage/identity.ts";
import { liftOnKeyboard } from "./kb.ts";
import { adopt, FORM_CSS } from "./style.ts";
import { useArm } from "./arm.ts";
import { format, count } from "../strings/panels.ts";
import { LAYER, t } from "../runtime/theme.ts";
import { signIn } from "./signin.ts";
import type { MemberSession } from "../storage/types.ts";

/**
 * The composer — name once, text, send.
 *
 * Deliberately the whole of it. Attachments were moved OUT of pin time in the
 * fold-back: putting a file picker in the one flow whose entire value is that it
 * takes four seconds was validated against a running artefact and rejected. They
 * live in the detail view instead.
 *
 * Preact, and therefore in `snag.panels.js` — never the runtime chunk.
 */

export interface ComposerProps {
  /** Viewport point to open beside — the click that created the pending snag. */
  at: { x: number; y: number };
  /** What was pinned, in words. Shown so the reviewer can see they hit the right thing. */
  label: string;
  onSend(body: string, author: string, email?: string): void;
  onCancel(): void;
  /** ▲ parent / ▼ child in the sheet header — the touch
   *  face of the [ / ] widen/narrow primitive. Coarse pointers only. */
  onRetarget?(dir: "up" | "down"): void;
  /** Mobile screenshots are OPT-IN per comment. The
   *  checkbox reports here; absent handler = no checkbox (fine pointers,
   *  or screenshots off — absent, never disabled). */
  onShotOptIn?(want: boolean): void;
  /**
   * Every keystroke, so nothing can forget to save (F-12).
   *
   * The composer does NOT own the storage key — the runtime does, because only
   * it knows the route and the anchor. This is the one hook, and it is called
   * on input rather than on a timer: a debounce is a window in which a reload
   * loses the last thing typed, and the whole point is that there is no such
   * window.
   */
  onDraft?(body: string, author: string, email?: string): void;
  /** Words already waiting, from a previous page load. */
  initialBody?: string;
  /**
   * And the name that was typed beside them.
   *
   * The name is only written to `snag:identity` on SEND — "asked once, then
   * remembered" is about a finished comment, not an abandoned one. So a restored
   * draft had no name, `canSend` was false, and Send sat disabled on a composer
   * full of the reviewer's own words with nothing to explain why.
   */
  initialName?: string;
  /** …and the address, for the same reason. */
  initialEmail?: string;
  /**
   * Whether console/network capture is CONFIGURED on for this project — the
   * one-time disclosure names the categories that are on, and the
   * composer cannot know; the runtime reads the config.
   */
  crumbsOn?: boolean;
  /**
   * A TEXT pick's quoted words — shown above the
   * textarea, truncated to 140 chars and expandable, so the reviewer sees
   * what the comment will hang on. Already through the label gates upstream.
   */
  quote?: string;
  /** Screenshots configured on — the disclosure's third sentence
   *  switches from "none taken" to the A11 accuracy sentence. */
  shotsOn?: boolean;
  /** The API origin comments are sent to, or undefined for a local-only
   *  install. Decides WHICH retention sentence the disclosure shows. */
  serverHost?: string;
  /**
   * "Sign in with Snagset", on a server-backed install only. `member`
   * is the signed-in studio member's name, or null; `adopt` stores the
   * session the dashboard popup posts back, `signOut` drops it. The popup
   * itself is this chunk's (`signin.ts`), so the runtime pays nothing for it.
   */
  studio?: {
    host: string;
    uid: string;
    env?: string | undefined;
    member: string | null;
    adopt(b: MemberSession): void;
    signOut(): void;
  };
  /** The name of the round this comment will land in, given only when
   *  the reviewer is looking at a CLOSED round and so it lands elsewhere. */
  roundNote?: string;
}

/**
 * WHO IS LEAVING THIS — asked once, then remembered.
 *
 * `{name, email?}`, and the email is "a display courtesy and a notification
 * address, self-declared and unverified. It never gates access, never
 * authorises an action, and is never treated as proof of who someone is"
 * The hard requirement it serves is the one above it in the same
 * section: **no reviewer of any tier ever creates an account** to leave a
 * comment. So this is a text field, and it is optional.
 *
 * The value lives in `storage/identity.ts`, which owns `snag:identity`
 * outright. This file used to own it too, with a different shape, and the two
 * quietly overwrote each other — see that module's header.
 */
/**
 * Deliberately not an RFC-grade pattern.
 *
 * The field is optional and unverified, so the only thing worth catching is the
 * typo that makes a notification silently never arrive — a missing `@`, a
 * missing dot, a trailing space. Anything stricter starts rejecting addresses
 * that work, and rejecting a real person's real address on a form they were
 * told they could skip is a worse outcome than storing one that bounces.
 */
/** The comment-body cap, and the point at which it becomes worth saying. */
const BODY_MAX = 10_000;
const BODY_WARN = 9_000;

const looksLikeEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/**
 * The one-time disclosure's session fallback.
 *
 * The acknowledgement lives in `snag:disclosure:v1`. Where storage
 * is denied (F6 — private-mode Safari writes throw), the boolean lives here
 * instead, so the screen shows once per SESSION rather than once per project —
 * degraded in the right direction. A screen that re-shows on every pin because
 * a write failed silently is exactly the fortieth-read noise cut.
 */
let ackThisSession = false;

function readAck(): boolean {
  if (ackThisSession) return true;
  try {
    return localStorage.getItem(DISCLOSURE_KEY) === "1";
  } catch {
    return false;
  }
}

function Composer({
  at,
  label,
  onSend,
  onCancel,
  onRetarget,
  onShotOptIn,
  onDraft,
  initialBody,
  initialName,
  initialEmail,
  crumbsOn,
  quote,
  roundNote,
  shotsOn,
  serverHost,
  studio,
}: ComposerProps) {
  const known = readIdentity();
  const [name, setName] = useState(known.name || (initialName ?? ""));
  /**
   * Who the studio member is, when one is signed in — and then the
   * name and email are not asked: the account answers both, and the comment
   * is written under the member's studio row by the session itself. The
   * typed guest name above stays untouched in storage, so signing out puts
   * back exactly the person this browser was before.
   */
  const [member, setMember] = useState(studio?.member ?? null);
  const [blocked, setBlocked] = useState(false);
  const signInNow = (): void => {
    if (!studio) return;
    setBlocked(false);
    // Synchronously inside the click — `signIn` opens the popup before its
    // first await, which is what keeps it a user-initiated window.
    void signIn(studio.host, studio.uid, studio.env).then((b) => {
      if (b === "blocked") return setBlocked(true);
      if (!b) return;
      studio.adopt(b);
      setMember(b.reviewer.name);
      bodyRef.current?.focus();
    });
  };
  const [email, setEmail] = useState(known.email ?? initialEmail ?? "");
  const [body, setBody] = useState(initialBody ?? "");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Asked once and never again on this browser — so the two fields appear
  // together or not at all, and the condition is read ONCE at mount rather than
  // per render. Reading it live meant the pair vanished mid-typing the moment a
  // name was saved.
  const [asking] = useState(!known.name);

  /**
   * The ONE-TIME DISCLOSURE (mandatory v0.1) — shown once
   * reviewer per project, at the first pin, before the first send, and never
   * again. One screen, four sentences: what every comment carries, whether
   * console/network capture is on, that no screenshot is taken in this
   * release, and where the words go. Read ONCE at mount, like `asking` above
   * and for the same reason.
   */
  const [disclosed, setDisclosed] = useState(readAck);
  const ackRef = useRef<HTMLButtonElement>(null);
  const ack = (): void => {
    ackThisSession = true;
    try {
      localStorage.setItem(DISCLOSURE_KEY, "1");
    } catch {
      /* F6 — the session flag above carries it */
    }
    setDisclosed(true);
  };

  // Focus where the reviewer has work to do: the acknowledgement while the
  // disclosure is up, then the name only the first time. FINE POINTERS ONLY
  // on touch, focusing a field mid-open raises the
  // on-screen keyboard over a sheet still finding its place — the reviewer
  // taps the field they want and the keyboard rises for a settled layout.
  const coarseC = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const born = useRef(performance.now()).current;
  useEffect(() => {
    if (coarseC) return;
    // Re-clamp from the REAL box, on BOTH axes.
    //
    // Vertically because the opening clamp guesses a form-sized height and the
    // content decides otherwise: the disclosure screen is nearly twice that and
    // its "Got it" sat below the fold on a lower-half pick, and a text
    // anchor's quote block adds another 100px on top of the form.
    //
    // Horizontally because the width was a constant that lied — see the
    // border-box note in the CSS. That is fixed at its source, so this axis
    // should now never fire; it is here because "should never" is the reason
    // the vertical one was needed, and a composer whose Post button is
    // off-screen is a comment that does not get written.
    const box = boxRef.current;
    const b = box?.getBoundingClientRect();
    if (box && b) {
      if (b.bottom > innerHeight - 8) box.style.top = `${Math.max(8, innerHeight - b.height - 8)}px`;
      if (b.right > innerWidth - 8) box.style.left = `${Math.max(8, innerWidth - b.width - 8)}px`;
    }
    if (!disclosed) {
      ackRef.current?.focus();
      return;
    }
    (asking && !member ? nameRef : bodyRef).current?.focus();
  }, [disclosed]);

  /**
   * THE ON-SCREEN KEYBOARD.
   *
   * `position: fixed; bottom: 0` does not work on iOS: Safari resizes the
   * VISUAL viewport and leaves the layout viewport alone, so a bottom-anchored
   * surface ends up underneath the keyboard — with the field being typed into
   * off-screen. The `interactive-widget` viewport-meta key lives in the HOST
   * page's `<meta>` and A3 forbids us touching it; the `VirtualKeyboard` API is
   * Chromium-only. So the height is measured, not asked for.
   *
   * The measurement is `innerHeight - vv.height - vv.offsetTop`, CLAMPED AT
   * ZERO, and the clamp is not defensive tidiness: some iOS builds do not reset
   * `offsetTop` to 0 after the keyboard closes, which makes the expression go
   * negative and would push the sheet down off the screen.
   *
   * Published as a custom property rather than an inline `margin-bottom`, so
   * the CSS can decide what to do with it — here, `max()` against the toolbar's
   * own height, because with the keyboard up the toolbar is behind it and
   * stacking both offsets would float the sheet in mid-air.
   *
   * The `focusout` recompute exists because iOS does not reliably fire a
   * visualViewport `resize` when the keyboard is dismissed by the Done key; 300
   * ms is the number.
   */
  useEffect(() => {
    const box = boxRef.current;
    // No visualViewport (or no box): the CSS alone still puts the sheet above
    // the toolbar — a worse experience with a keyboard open and a working one
    // without, which beats the showModal() fallback that would make us
    // inert under our own dialog pause. Mechanics in kb.ts.
    if (!box) return;
    return liftOnKeyboard(box);
  }, []);



  // A typo'd address blocks; an EMPTY one never does. The hard
  // requirement is that nobody creates an account to leave a comment, and a
  // required contact field is an account in everything but name.
  const badEmail = email.trim().length > 0 && !looksLikeEmail(email);
  const canSend = body.trim().length > 0 && (!!member || (name.trim().length > 0 && !badEmail));

  function send(): void {
    if (!canSend) return;
    // A member's name is the account's; it is not this browser's guest name
    // and must not overwrite it.
    if (member) return onSend(body.trim(), member);
    const id: Identity = {
      name: name.trim(),
      ...(email.trim() ? { email: email.trim() } : {}),
    };
    writeIdentity(id);
    onSend(body.trim(), id.name, id.email);
  }

  /**
   * Rung 5 of the Esc stack: "close it and discard the pending
   * selection (with the confirm dialog if the body is non-empty)".
   *
   * The confirm is `useArm` — the two-press idiom, shared with every
   * destructive control in the dock. The guard is what makes the empty case
   * right: a composer nobody typed into closes on the first press.
   */
  const { armed: arming, press: cancel } = useArm(onCancel, () => body.trim().length > 0, () =>
    bodyRef.current?.focus(),
  );

  /** One way in, so the draft and the field cannot disagree. */
  const type = (next: string): void => {
    setBody(next);
    onDraft?.(next, name, email);
  };

  // Placement: beside the click, clamped into the viewport. A composer that
  // opens off-screen is a comment that never gets written.
  //
  // ON A COARSE POINTER THIS IS IGNORED — the CSS makes the composer a bottom
  // sheet in one fixed place instead. Found on a real phone in the first hour
  // of dogfooding: placed beside the tap it lands somewhere different every
  // time, and near the right edge the Send button was clipped off the screen.
  // A control whose position depends on where you last touched is a control you
  // have to look for, on the device where looking costs the most.
  const W = 300;
  const left = Math.min(Math.max(8, at.x + 14), innerWidth - W - 8);
  const top = Math.min(Math.max(8, at.y + 14), innerHeight - 198);

  return (
    <>
      {/* The scrim — dismissal by tap (armed while words exist, C8), zero
          scrolling by construction (touch-action:none). aria-hidden: the ✕
          is the accessible dismissal; the scrim duplicates it for thumbs. */}
      {coarseC && (
        <div
          class="snag-scrim"
          aria-hidden="true"
          onClick={() => {
            // The derived tap that OPENED this composer is chased by the
            // browser's compatibility click, which lands here ~30 ms later
            // and was dismissing the composer it had just asked for.
            if (performance.now() - born > 400) cancel();
          }}
        />
      )}
      <div
      ref={boxRef}
      class="snag-composer"
      role="dialog"
      aria-label={format("composer.aria")}
      style={{ left: `${left}px`, top: `${top}px`, width: `${W}px` }}
      onKeyDown={(e: KeyboardEvent) => {
        // Esc closes; Cmd/Ctrl+Enter sends — the two chords people try first.
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          send();
        }
      }}
    >
      {/* The context line — `On "<label>"`, one line, no tag name and no
          pixel dimensions. The dismiss sits at its trailing edge rather than
          beside Send: see the note on the actions row below. */}
      {/* The grabber — 36×4 visual in a 44px hit strip; the swipe-down
          handle. Pointer events, not touch listeners: nothing in
          the widget may register a touch handler that could cancel. */}
      {coarseC && (
        <div
          class="snag-grab"
          aria-hidden="true"
          onPointerDown={(e) => {
            // Swipe-down dismisses the sheet — pointer capture, so
            // one move handler and no cleanup bookkeeping. Passive by nature:
            // pointer events cancel nothing.
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
                cancel(); // two-press armed while words exist (C8)
              }
            };
            el.onpointerup = () => (el.onpointermove = null);
          }}
        />
      )}
      <div class="snag-head">
        {/* ▲ parent / ▼ child: correct the pick without
            re-aiming a thumb. The header line grows the pair on touch. */}
        {coarseC && onRetarget && disclosed && (
          <span class="snag-step">
            <button type="button" aria-label={format("composer.parent")} onClick={() => onRetarget("up")}>
              {"\u25B2"}
            </button>
            <button type="button" aria-label={format("composer.child")} onClick={() => onRetarget("down")}>
              {"\u25BC"}
            </button>
          </span>
        )}
        <p class="snag-target" title={label}>
          {label}
        </p>
        <button
          type="button"
          class={`snag-dismiss${arming ? " snag-armed" : ""}`}
          aria-label={arming ? format("composer.discard.sure") : format("action.cancel")}
          title={arming ? format("composer.discard.sure") : format("action.cancel")}
          onClick={cancel}
        >
          {arming ? format("action.discard") : "\u2715"}
        </button>
      </div>

      {/* The one-time disclosure replaces the FORM, not the dialog: the head
          stays, so the reviewer can still see what they pinned and still leave
          through the ✕. Four sentences, then the composer they asked for —
          this screen is the replacement for the per-send panel cut,
          and it must never be seen twice. */}
      {!disclosed && (
        <div class="snag-disclose">
          <p class="snag-disclose-title">{format("disclosure.title")}</p>
          <p>{format("disclosure.always")}</p>
          <p>{format(crumbsOn ? "disclosure.crumbs.on" : "disclosure.crumbs.off")}</p>
          {/* The A11 accuracy corrigendum, verbatim (00 foundations): the
              absolute "never captured" claim is false once a screenshot
              exists, and this is the sentence that replaces it — extracted
              from the spec source by the test, brand and attribute composed
              so no literal token lives in the catalogue. */}
          <p>
            {shotsOn
              ? format("disclosure.screenshot.on", { maskAttr: hostAttr("mask") })
              : format("disclosure.screenshot.off")}
          </p>
          <p>
            {serverHost
              ? format("disclosure.retention.server", { host: serverHost })
              : format("disclosure.retention")}
          </p>
          <div class="snag-actions">
            <button type="button" ref={ackRef} class="snag-send snag-primary" onClick={ack}>
              {format("disclosure.ack")}
            </button>
          </div>
        </div>
      )}

      {/* Signed in, the account is the identity — one line saying so,
          and the way out of it, where the two fields would be. */}
      {disclosed && member && (
        <p class="snag-member">
          {format("composer.member", { name: member })}{" "}
          <button
            type="button"
            class="snag-link"
            onClick={() => {
              studio?.signOut();
              setMember(null);
            }}
          >
            {format("composer.signout")}
          </button>
        </p>
      )}

      {/* Asked once, then remembered — name AND email, above the body, on the
          first comment only. "A guest identity is same browser"
          is all v0 can honestly claim; v1's review link carries a real one. */}
      {disclosed && asking && !member && (
        <>
          <input
            ref={nameRef}
            class="snag-input"
            type="text"
            placeholder={format("composer.name")}
            aria-label={format("composer.name")}
            value={name}
            onInput={(e) => {
              const next = (e.target as HTMLInputElement).value;
              setName(next);
              // Whichever field was last touched is the one a reload puts back.
              if (body.trim()) onDraft?.(body, next, email);
            }}
          />
          <input
            class={`snag-input${badEmail ? " snag-input--bad" : ""}`}
            // `type="email"` for the phone keyboard, not for the validation —
            // the browser's own is stricter than we want and its bubble is a
            // modal we do not control. `novalidate` behaviour by construction:
            // there is no <form> around this.
            type="email"
            inputMode="email"
            autocomplete="email"
            placeholder={format("composer.email")}
            aria-label={format("composer.email")}
            aria-invalid={badEmail ? "true" : undefined}
            aria-describedby={badEmail ? "snag-email-note" : undefined}
            value={email}
            onInput={(e) => {
              const next = (e.target as HTMLInputElement).value;
              setEmail(next);
              if (body.trim()) onDraft?.(body, name, next);
            }}
          />
          {badEmail && (
            // Says what is wrong AND the way out, because the way out is the
            // part people do not expect: this field was always optional.
            <p class="snag-note" id="snag-email-note">
              {format("composer.email.bad")}
            </p>
          )}
        </>
      )}
      {/* Offered whenever nobody is signed in, not only beside the two fields:
          a member who once typed a guest name here is never asked again, and
          would otherwise never see the way to be themselves. */}
      {disclosed && studio && !member && (
        <p class="snag-member">
          <button type="button" class="snag-link" onClick={signInNow}>
            {format("composer.signin")}
          </button>
          {blocked && <span role="status"> {format("composer.signin.blocked")}</span>}
        </p>
      )}

      {/* The quoted words the pin will hang on: 140 chars,
          then an expand — a two-paragraph quote must be inspectable without
          swallowing the composer it sits in. */}
      {/* Scrollable rather than expandable-by-control: the quote is CONTEXT,
          and the max-height CSS line does what a button, a state and two
          catalogue entries were doing. */}
      {disclosed && quote && <blockquote class="snag-quote">{quote}</blockquote>}
      {disclosed && roundNote && <p class="snag-member">{format("composer.round.closed", { round: roundNote })}</p>}

      {disclosed && (
      <textarea
        ref={bodyRef}
        class="snag-text"
        placeholder={format("composer.body.placeholder")}
        aria-label={format("composer.body")}
        // The cap, enforced by the FIELD rather than by a validator on send.
        // A limit that only speaks at submit time is a limit that discards work
        // somebody has already done; `maxlength` simply stops accepting more,
        // and the counter below has been warning for a thousand characters by
        // then.
        maxLength={BODY_MAX}
        rows={3}
        // Enter is a newline; submission on touch is the button.
        enterkeyhint="enter"
        value={body}
        onInput={(e) => {
          const el = e.target as HTMLTextAreaElement;
          // Auto-grow to five lines, then scroll internally.
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
          type(el.value);
        }}
      />
      )}

      {/* ONE FULL-WIDTH BUTTON, AND NO CANCEL BESIDE IT.
          Draws the composer with exactly this and nothing else, and a
          side-by-side Cancel was ours rather than the spec's. Two same-sized
          adjacent buttons are a desktop affordance; under a thumb they are a
          coin toss, and one of the two outcomes destroys what was just typed.
          Dismissal is the small ✕ in the header — far away, deliberately
          smaller, and it still asks before taking words (Esc stack rung 5). */}
      {/* "a counter appears at 9 000". Silent until then — a live
          character count on a three-sentence comment is an invigilator, and the
          number only becomes information when running out is a real prospect. */}
      {disclosed && body.length >= BODY_WARN && (
        <p class={`snag-note${body.length >= BODY_MAX ? "" : " snag-dim"}`} aria-live="polite">
          {format("composer.chars", { n: count(BODY_MAX - body.length) })}
        </p>
      )}

      {/* Mobile screenshots are opt-in per comment — a
          checkbox, OFF by default, ABSENT (not disabled) when screenshots
          are off for the project: the handler simply is not passed then. */}
      {disclosed && coarseC && onShotOptIn && (
        <label class="snag-shotopt">
          <input type="checkbox" onChange={(e) => onShotOptIn((e.currentTarget as HTMLInputElement).checked)} />{" "}
          {format("composer.shot")}
        </label>
      )}
      {disclosed && (
        <div class="snag-actions">
          <button type="button" class="snag-send snag-primary" disabled={!canSend} onClick={send}>
            {format("action.post")}
          </button>
        </div>
      )}
      </div>
    </>
  );
}

const CSS = `
/* BORDER-BOX, and it is load-bearing rather than housekeeping. The component
   writes width:300px inline and clamps its own left against that number; under
   content-box the rendered box was 326px (300 + 12px padding + 1px border, both
   doubled), so a pick near the right edge placed the card 26px wider than the
   arithmetic that had just decided it fitted — 18px of it off-screen, measured.
   Reported from the dogfood as the comment box not being inside the viewport. */
.snag-composer{position:fixed;box-sizing:border-box;z-index:${LAYER.composer};background:${t.bg};color:${t.fg};
  border:1px solid ${t.border};border-radius:calc(${t.radius} + 4px);padding:12px;box-shadow:${t.shadow};
  pointer-events:auto;font:400 13px/1.45 ${t.font};display:flex;flex-direction:column;gap:8px}
.snag-head{display:flex;align-items:center;gap:8px}
.snag-target{margin:0;flex:1 1 auto;min-width:0;color:${t.muted};font-size:11px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* Quiet by default and never the same weight as the primary — this is the
   control that throws work away, and it should read as an exit rather than as
   the other half of a choice. */
.snag-dismiss{flex:0 0 auto;appearance:none;border:0;background:transparent;color:${t.muted};
  font:inherit;font-size:12px;line-height:1;padding:6px;margin:-6px -4px -6px 0;
  border-radius:calc(${t.radius} - 2px);cursor:pointer}
.snag-dismiss:hover{color:${t.fg};background:${t.hover}}
.snag-dismiss:focus-visible{outline:2px solid ${t.focus};outline-offset:1px}
/* Armed, it stops being an icon and says the word — the same idiom as the
   dock's deletes, in the same colour. */
.snag-dismiss.snag-armed{color:${t.anchorOrphan};font-weight:600;font-size:11px}
/* The one-time disclosure: quiet body copy, no chrome of its own — it borrows
   the composer's card because it IS the composer's first screen, not a modal
   above one. */
.snag-disclose{display:flex;flex-direction:column;gap:6px}
.snag-disclose p{margin:0;font-size:12px;line-height:1.5;color:${t.fg}}
.snag-disclose .snag-disclose-title{font-weight:600;font-size:12px}
.snag-disclose p:not(.snag-disclose-title){color:${t.muted}}
/* The line: who is signed in, or the offer to sign in. A link-styled
   button, quiet, because for a client it is not addressed to them. */
.snag-member{margin:0;font-size:11px;color:${t.muted}}
.snag-link{appearance:none;border:0;background:none;padding:0;font:inherit;color:${t.fg};
  text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.snag-link:focus-visible{outline:2px solid ${t.focus};outline-offset:1px}
/* The text pick's quote: visibly a quotation, visually quiet. Line-height and
   radius inherit from the composer card — restating them is wire weight. */
.snag-quote{margin:0;padding:6px 10px;border-inline-start:3px solid ${t.accent};
  background:${t.surface};font-size:12px;color:${t.muted}}
/* The one primary action, full width. Draws the composer with exactly
   this: name once, text, send. */
.snag-actions .snag-primary{flex:1 1 auto;justify-content:center;padding-block:10px;font-weight:600}
/* THE BOTTOM SHEET.

   One place, every time. Placed beside the tap it landed somewhere different on
   every comment and clipped its own Send button against the right edge — and on
   a phone the composer is the surface you look at longest, so it is the one that
   must not move.

   The inline left/top/width the component computes are overridden here
   rather than branched on in JS, because the media query is what actually knows
   which pointer is in use and it re-evaluates on its own if that changes.

   The bottom offset is a max(), not a sum. --snag-tb-h is the toolbar's height;
   --snag-kb is the keyboard's, measured from visualViewport. With the keyboard
   up the toolbar is BEHIND it, so adding the two would float the sheet a
   toolbar's height above where it belongs. */
@media (pointer:coarse){
  .snag-composer{
    left:0!important;right:0;top:auto!important;width:auto!important;
    inset-block-end:max(var(${CSS_VAR.tbH},68px), var(${CSS_VAR.kb},0px));
    border-radius:14px 14px 0 0;border-inline:0;border-block-end:0;
    padding:14px 16px calc(16px + env(safe-area-inset-bottom));gap:10px;
    /* Only the box-shadow lifts it off the page — no transform, because a
       transformed ancestor makes position:fixed descendants position against
       IT rather than the viewport, and the pin layer's dynamic tier is exactly
       that kind of descendant. */
    box-shadow:0 -8px 32px rgb(0 0 0 / 28%)}
  /* 44 px of thumb, and nothing beside it to hit by mistake. */
  .snag-composer .snag-primary{min-height:48px;font-size:15px}
  .snag-composer .snag-dismiss{padding:10px;margin:-10px -6px -10px 0;font-size:14px}
  /* Roomier than the desktop textarea: this is the field the whole product
     exists to fill in, and it is being typed into with thumbs. */
  .snag-composer .snag-text{min-height:88px}
  .snag-composer{overscroll-behavior:contain;
    padding-inline:calc(16px + env(safe-area-inset-left)) calc(16px + env(safe-area-inset-right))}
  /* The scrim: touch-action:none — a gesture starting on it
     scrolls NOTHING, no event cancelled, no listener registered. */
  .snag-scrim{position:fixed;inset:0;background:#0005;touch-action:none;pointer-events:auto}
  /* 36×4 visual bar drawn as a background gradient inside a 44px hit strip. */
  .snag-grab{margin:-14px 0 -8px;padding:12px 0;touch-action:none;pointer-events:auto;
    background:linear-gradient(${t.border} 0 0) 50%/36px 4px no-repeat}
  .snag-step{display:flex;gap:2px}
  .snag-step button{min-width:44px;min-height:44px;background:none;border:1px solid ${t.border};
    border-radius:8px;color:${t.fg}}
  .snag-shotopt{display:flex;align-items:center;gap:8px;min-height:44px}
}
/* "Not now" — the answer to a pin clicked while this holds typed words.
   The draft is the thing being protected, so the feedback must not touch it. */
@keyframes snag-pulse{50%{transform:scale(1.04)}}
.snag-pulse{animation:snag-pulse 500ms ease-in-out}
/* Reduced motion gets the same message as an outline. Asserts an empty
   getAnimations() under reduce, so the animation must be gone, not merely
   shortened to 0ms — a 0ms animation is still an animation. */
@media (prefers-reduced-motion:reduce){
  .snag-pulse{animation:none;outline:2px solid ${t.focus};outline-offset:3px}
}
`;

export interface ComposerHandle {
  close(): void;
  /** Does it hold words somebody would mind losing? */
  hasText(): boolean;
  /** Say "not now" without taking the draft — one pulse, static under reduce. */
  pulse(): void;
  /** The ▲/▼ steppers re-aimed the pick — surgical text swap, never a
   *  re-render (a re-render replaces the textarea and takes the caret). */
  setLabel(label: string): void;
}

/** Mount the composer into the widget's shadow root. */
export function openComposer(root: ShadowRoot, props: ComposerProps, parent?: Element): ComposerHandle {
  const doc = root.ownerDocument ?? document;
  adopt(root, "form", FORM_CSS);
  adopt(root, "composer", CSS);
  const host = doc.createElement("div");
  (parent ?? root).appendChild(host);

  const close = (): void => {
    render(null, host); // let Preact unmount cleanly before the node goes
    host.remove();
  };

  /**
   * Read straight off the DOM node, not off Preact state.
   *
   * The caller is the pin-click handler in the runtime chunk, which has no
   * access to this component's state and must not force a render to ask — and a
   * re-render of the composer is exactly what forbids, because it replaces
   * the `<textarea>` and takes the caret with it.
   */
  const field = (): HTMLTextAreaElement | null => host.querySelector(".snag-text");
  const hasText = (): boolean => (field()?.value ?? "").trim().length > 0;

  const pulse = (): void => {
    const el = host.firstElementChild as HTMLElement | null;
    if (!el) return;
    // The class is removed on the next frame after the animation would have
    // ended, so a second pin click pulses again rather than doing nothing.
    el.classList.remove("snag-pulse");
    void el.offsetWidth; // restart the animation — a reflow is the only way
    el.classList.add("snag-pulse");
    setTimeout(() => el.classList.remove("snag-pulse"), 600);
  };

  render(
    <Composer
      {...props}
      // ARITY THREE, and it was two: the wrapper dropped the email silently, so
      // `snag:identity` held the address a reviewer typed and every comment they
      // wrote was attributed without one. A feature that is absent looks like a
      // feature that is bad — you type it all week and get nothing.
      onSend={(b, a, e) => {
        props.onSend(b, a, e);
        close();
      }}
      onCancel={() => {
        props.onCancel();
        close();
      }}
    />,
    host,
  );

  return {
    close,
    hasText,
    pulse,
    setLabel(label) {
      const el = host.querySelector(".snag-target") as HTMLElement | null;
      if (el) {
        el.textContent = label;
        el.title = label;
      }
    },
  };
}
