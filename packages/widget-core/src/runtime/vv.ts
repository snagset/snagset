/**
 * The visual-viewport choreography.
 *
 * Widget CHROME (toolbar, sheets, notices) glues to the VISUAL viewport;
 * pins stay in LAYOUT-viewport coordinates and scale with the page — the
 * split, stated there explicitly, which is why this is applied to
 * registered chrome elements and never to a pin layer. (drew one
 * `part="fixed"` tree holding both; translating that tree would drag the
 * dynamic pin tier into visual-viewport space and displace every pin that
 * mirrors a host `position:fixed` element. Governs the UX split, so
 * the deviation .1's tree is deliberate and recorded here.)
 *
 * The write pass is the, verbatim: `translate` by the visual viewport's
 * offsets, `width`/`height` to its size — the only way bottom-anchored UI
 * stays inside the visible area under pinch-zoom AND while a collapsing
 * mobile URL bar mis-sizes `100vh`. We deliberately do NOT compensate
 * `vv.scale` ("Rejected: full 1/scale compensation") — chrome scales
 * with the page like everything else; what it must not do is drift off
 * screen.
 *
 * One rAF-coalesced pass, bound to vv `resize` + `scroll`, both passive.
 * `onScale` feeds the ≥1.2 toolbar puck without a second listener.
 */
/** Glue THE chrome layer to the visual viewport. One element by design —
 *  everything vv-anchored lives inside it. Returns the un-glue. */
export function glueChrome(win: Window, el: HTMLElement, onScale?: (scale: number) => void): () => void {
  const vv = win.visualViewport;
  let frame = 0;
  const apply = (): void => {
    frame = 0;
    if (!vv) return;
    const x = vv.offsetLeft;
    const y = vv.offsetTop;
    el.style.translate = x || y ? `${x}px ${y}px` : "";
    el.style.width = `${vv.width}px`;
    el.style.height = `${vv.height}px`;
    onScale?.(vv.scale);
  };
  const schedule = (): void => {
    if (!frame) frame = win.requestAnimationFrame(apply);
  };
  vv?.addEventListener("resize", schedule, { passive: true });
  vv?.addEventListener("scroll", schedule, { passive: true });
  schedule();
  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    vv?.removeEventListener("resize", schedule);
    vv?.removeEventListener("scroll", schedule);
  };
}
