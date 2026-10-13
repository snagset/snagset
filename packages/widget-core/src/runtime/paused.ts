import { adopt, t } from "./theme.ts";
import { format } from "../strings/runtime.ts";

/**
 * "A dialog is open — review mode is paused", the row.
 *
 * ── WHY THIS IS A `<dialog>` AND NOT THE NOTICE WE ALREADY HAVE ──
 *
 * `showModal()` does not merely raise the host's dialog into the top layer. It
 * marks **everything else in the document inert**, including other top-layer
 * elements that are not its descendants (the A4 corrigendum). Our toolbar,
 * shield and composer keep painting above it and receive no pointer or keyboard
 * events at all — so `createNotice`'s toast would be perfectly visible and
 * perfectly dead, and its Close button would not close.
 *
 * Spells out the only escape: *"One notice inside our own
 * `dialog.showModal()` — a modal opened AFTER the host's is the topmost and
 * therefore the interactive one."* Inertness is decided by top-layer order, so
 * being second is the entire mechanism.
 *
 * ── WHY IT IS WORTH THE BYTES ──
 *
 * Detection, pausing and auto-resume were all built; the sentence explaining it
 * was tagged v0.1 and left out. What a reviewer actually experienced was a
 * toolbar that silently stopped working the moment a confirmation appeared —
 * reported twice from real use before this was written, both times as "the
 * modal is still an issue", which is what a widget with no voice sounds like.
 *
 * The pause is correct and stays correct: pinning inside a native modal is out
 * of scope through v1 (A4), because the only known fix is
 * re-parenting our root into the open dialog, which invalidates every pin rect
 * at exactly the moment somebody is trying to comment. So this notice does not
 * apologise for a bug — it explains a boundary, and says the two things a
 * person needs: how to carry on, and that the thing they just tried is not
 * coming in a later click.
 */

const CSS = `
/* pointer-events:auto is NOT decoration. The shadow host carries
   pointer-events:none so the page underneath stays clickable, and every surface
   of ours turns it back on for itself. Without it this dialog was modal,
   visible, correctly worded — and its Close button could not be clicked,
   because the host's value inherited straight through. Caught by the E2E, which
   is the only reason it is not in the build. */
.snag-paused{border:0;padding:0;background:transparent;pointer-events:auto;
  max-width:min(420px,calc(100vw - 32px))}
.snag-paused::backdrop{background:rgb(0 0 0 / .28)}
.snag-paused-box{background:${t.bg};color:${t.fg};border:1px solid ${t.border};
  border-inline-start:3px solid ${t.accent};border-radius:${t.radius};box-shadow:${t.shadow};
  padding:14px 16px;font:400 13px/1.45 ${t.font};display:flex;flex-direction:column;gap:12px}
.snag-paused p{margin:0}
.snag-paused-actions{display:flex;justify-content:flex-end}
.snag-paused button{appearance:none;font:inherit;cursor:pointer;border:0;font-weight:600;
  border-radius:calc(${t.radius} - 2px);padding:6px 14px;min-height:30px;
  background:${t.accent};color:${t.onAccent}}
.snag-paused button:focus-visible{outline:2px solid ${t.focus};outline-offset:2px}
`;

export interface PausedNotice {
  show(): void;
  hide(): void;
  destroy(): void;
}

export function createPausedNotice(root: ShadowRoot, parent?: Element): PausedNotice {
  const doc = root.ownerDocument ?? document;
  adopt(root, "paused", CSS);

  const el = doc.createElement("dialog");
  el.className = "snag-paused";
  // A modal <dialog> with no accessible name is an axe violation
  // (aria-dialog-name) and, worse, announces as just "dialog" — the sentence
  // inside is the name it should carry.
  el.setAttribute("aria-label", format("paused.dialog"));

  const box = doc.createElement("div");
  box.className = "snag-paused-box";
  // `status`, not `alert`: The design names it, and it is the right one — nothing
  // has gone wrong, and a reviewer who is mid-sentence in a screen reader
  // should hear this when they next pause rather than have it cut across them.
  box.setAttribute("role", "status");

  const text = doc.createElement("p");
  text.textContent = format("paused.dialog");

  const actions = doc.createElement("div");
  actions.className = "snag-paused-actions";
  const close = doc.createElement("button");
  close.type = "button";
  close.textContent = format("paused.close");
  close.addEventListener("click", () => hide());

  actions.append(close);
  box.append(text, actions);
  el.append(box);

  let shown = false;

  function show(): void {
    if (shown) return;
    // NOT appended until there is something to say — the rule, and the
    // reason the shield, highlight and hint are attached rather than hidden.
    (parent ?? root).appendChild(el);
    try {
      el.showModal();
      shown = true;
    } catch {
      // `showModal()` throws if the dialog is already modal, and on an engine
      // without the top layer it may not exist at all. A visible-but-inert
      // notice still says the true thing, so fall back to showing it rather
      // than to saying nothing.
      el.setAttribute("open", "");
      shown = true;
    }
  }

  function hide(): void {
    if (!shown) return;
    shown = false;
    try {
      el.close();
    } catch {
      el.removeAttribute("open");
    }
    el.remove();
  }

  // Esc closes a modal dialog natively and fires `close` without going through
  // `hide()` — so the element would stay in the tree with `shown` still true,
  // and the next pause would find nothing to show. This is the one path that
  // must not be left to the button.
  el.addEventListener("close", () => {
    shown = false;
    el.remove();
  });

  return {
    show,
    hide,
    destroy() {
      hide();
      el.remove();
    },
  };
}
