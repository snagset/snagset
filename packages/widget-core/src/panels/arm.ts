import { useState, useEffect } from "preact/hooks";

/**
 * The two-press arm — the idiom, in one place.
 *
 * "The first click arms it to *Sure?* for 3 s." The spec specifies it for
 * *Clear all* and this codebase reuses it for every destructive control rather
 * than inventing a confirm dialog per action: one idiom for destruction across
 * the product, no modality, and nothing that can be dismissed by accident into
 * a loss.
 *
 * It lived twice — the dock's `Danger` button and the composer's dismiss — and
 * the two copies had already started to differ in which of them re-focused
 * afterwards. Two implementations of a rule about not losing work is one
 * implementation too many.
 *
 * THE DISARM IS THE POINT, not tidiness: a control left armed by a stray click
 * is a landmine for the next click that lands anywhere near it, and three
 * seconds is long enough to mean it and short enough to forget.
 */
export function useArm(
  onConfirm: () => void,
  guard?: () => boolean,
  /** Called when the press ARMS rather than fires. The composer puts the caret
   *  back in the textarea, so the reviewer whose ✕ has just turned into a
   *  question is typing again the moment they ignore it. */
  onArm?: () => void,
): { armed: boolean; press(): void } {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  return {
    armed,
    press() {
      // `guard` says whether there is anything worth protecting. The composer
      // passes "does it hold words" — arming a control that would destroy an
      // empty form is how a two-press idiom stops meaning anything.
      if (armed || (guard && !guard())) {
        setArmed(false);
        onConfirm();
        return;
      }
      setArmed(true);
      onArm?.();
    },
  };
}
