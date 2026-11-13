import { CSS_VAR } from "@snagset/types/names";

/**
 * The keyboard lift, extracted for its second consumer: the
 * composer sheet AND the dock's reply composer both need `--snag-kb` — the
 * on-screen keyboard's height as the visual viewport reports it — published
 * where their CSS can spend it. A SOURCE module: each chunk bundles
 * its own copy; the var is set per surface because `:host{all:initial}`
 * severs inheritance, so there is no shared element to publish it on.
 *
 * The mechanics the comment in composer.tsx used to carry: clamped at zero
 * (some iOS builds leave `offsetTop` dirty after dismissal), rAF-coalesced
 * (vv `scroll` fires continuously while the keyboard animates), and a 300 ms
 * `focusout` recompute because iOS does not reliably fire a vv `resize` when
 * the Done key dismisses (the number).
 */
export function liftOnKeyboard(box: HTMLElement): (() => void) | undefined {
  const vv = window.visualViewport;
  if (!vv) return undefined;
  let frame = 0;
  let timer = 0;
  const measure = (): void => {
    frame = 0;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    box.style.setProperty(CSS_VAR.kb, `${kb}px`);
  };
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  const onFocusOut = (): void => {
    clearTimeout(timer);
    timer = window.setTimeout(measure, 300);
  };
  measure();
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  window.addEventListener("orientationchange", schedule);
  box.addEventListener("focusout", onFocusOut);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(timer);
    vv.removeEventListener("resize", schedule);
    vv.removeEventListener("scroll", schedule);
    window.removeEventListener("orientationchange", schedule);
    box.removeEventListener("focusout", onFocusOut);
  };
}
