import { CSS_VAR } from "@snagset/types/names";
import { adopt, LAYER, t } from "./theme.ts";
import { format, type StringKey } from "../strings/runtime.ts";

/**
 * The degraded-state notice (the F-tier).
 *
 * VANILLA, and that is the whole point: the notice that explains "the comment
 * UI failed to load" cannot itself be built with the UI framework that failed
 * to load. It lives in the runtime chunk, in the existing shadow root — never a
 * second host, because asserts exactly one `[data-snag-root]` throughout
 * the failure.
 *
 * The copy rules: no error blames the reviewer, every error names what
 * failed AND what to do next, and no internal id or stack reaches the copy —
 * those go to the console behind the product prefix.
 */

const CSS = `
/* left:50% + translateX(-50%) is CENTRING, not direction — 50% from either edge
   is the same point, so this needs no logical form (governs layout that
   flips, and a centred toast does not). NOTE: no backticks in here. This is
   inside a template literal, and a CSS comment containing one closes the
   string — which has now happened twice. */
.snag-notice{position:fixed;left:50%;transform:translateX(-50%);
  bottom:calc(24px + var(${CSS_VAR.tbH}, 56px));z-index:${LAYER.notice};max-width:min(420px,calc(100vw - 24px));
  background:${t.bg};color:${t.fg};border:1px solid ${t.border};border-inline-start:3px solid ${t.anchorOrphan};
  border-radius:${t.radius};box-shadow:${t.shadow};padding:12px 14px;pointer-events:auto;
  font:400 13px/1.45 ${t.font};display:flex;flex-direction:column;gap:10px}
@media (pointer:coarse){.snag-notice{bottom:calc(12px + var(${CSS_VAR.tbH}, 64px))}}
.snag-notice p{margin:0}
.snag-notice-actions{display:flex;gap:6px;justify-content:flex-end}
.snag-notice button{appearance:none;font:inherit;cursor:pointer;border-radius:calc(${t.radius} - 2px);
  padding:6px 12px;min-height:30px;border:0;transition:background ${t.motion}}
.snag-notice-retry{background:${t.accent};color:${t.onAccent};font-weight:600}
.snag-notice-dismiss{background:transparent;color:${t.muted}}
.snag-notice-dismiss:hover{background:${t.hover};color:inherit}
.snag-notice button:focus-visible{outline:2px solid ${t.focus};outline-offset:2px}
`;

/**
 * The one action a notice may offer, named by the thing it does.
 *
 * It started as `onRetry` alone, which was right while F-04 was the only
 * failure with a notice. F-01 offers **Export** and F-02 offers **Export &
 * clear** — neither is a retry, and labelling them "Retry" would be a lie about
 * what the button does to a reviewer's data.
 */
export interface NoticeAction {
  label: StringKey;
  run(): void;
}

export interface Notice {
  /** `params` fills the key's `{placeholders}` — a notice whose sentence names
   *  the thing it is about ("that Snag couldn't be sent") reads as written FOR
   *  the reader, and the vocabulary is the, not this module's. */
  show(key: StringKey, action?: NoticeAction, params?: Record<string, string | number>): void;
  hide(): void;
  visible(): boolean;
  destroy(): void;
}

export function createNotice(root: ShadowRoot, parent?: Element): Notice {
  const doc = root.ownerDocument ?? document;
  const win = doc.defaultView ?? window;
  adopt(root, "notice", CSS);

  const el = doc.createElement("div");
  el.className = "snag-notice";
  // `alert`, not `status`: this interrupts a thing the reviewer just tried to
  // do, so it should be announced rather than queued behind whatever else the
  // live region was saying.
  el.setAttribute("role", "alert");
  el.hidden = true;

  const text = doc.createElement("p");
  const actions = doc.createElement("div");
  actions.className = "snag-notice-actions";

  const dismiss = doc.createElement("button");
  dismiss.type = "button";
  dismiss.className = "snag-notice-dismiss";
  dismiss.textContent = format("action.dismiss");
  dismiss.addEventListener("click", () => hide());

  const act = doc.createElement("button");
  act.type = "button";
  act.className = "snag-notice-retry";

  actions.append(dismiss, act);
  el.append(text, actions);
  // NOT appended until there is something to say. Names the shield, the
  // highlight and the hint; this is the same rule and the same reason — a
  // dormant `role="alert"` region in a client's page is a node they can find
  // and we cannot justify. A widget that has nothing to tell you should not be
  // in the tree telling you nothing.

  let action: NoticeAction | undefined;
  act.addEventListener("click", () => {
    hide();
    action?.run();
  });

  let pending = 0;

  function hide(): void {
    if (pending) win.cancelAnimationFrame(pending);
    pending = 0;
    el.hidden = true;
    el.remove();
  }

  return {
    show(key, next, params) {
      action = next;
      act.hidden = !next;
      if (next) act.textContent = format(next.label);
      el.hidden = false;
      // ATTACHED EMPTY, THEN FILLED. `role="alert"` is a live region, and a
      // live region inserted with its text already in it is announced by most
      // screen readers and not by all — whereas a mutation inside a region that
      // is already in the tree is announced by every one of them. Detaching the
      // notice when it has nothing to say (above) would otherwise have quietly
      // traded an accessibility guarantee for a node count.
      //
      // One frame, which nobody sees, and `pending` guards a second show()
      // arriving inside it — the last message wins rather than the first.
      text.textContent = "";
      (parent ?? root).appendChild(el);
      const say = format(key, params);
      if (pending) win.cancelAnimationFrame(pending);
      pending = win.requestAnimationFrame(() => {
        pending = 0;
        text.textContent = say;
      });
    },
    hide,
    visible: () => el.isConnected && !el.hidden,
    destroy() {
      el.remove();
    },
  };
}
