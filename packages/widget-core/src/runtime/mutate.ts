/**
 * The page changed shape, plan task 27 (v0).
 *
 * Until this existed, a pin's ANCHOR STATE could not change without a reload.
 * `refresh()` ran at mount and on a route change and nowhere else, so an element
 * deleted under a live pin left that pin sitting at its last position, still
 * saying `anchored`, until somebody pressed F5. Asks for `orphaned`
 * "within 2 sync cycles"; what we had was "within one page load".
 *
 * Found by dogfooding, three separate ways in one session — a rebuild swap, a
 * deliberate DOM churn page, and a portal being closed — which is a fair
 * description of how absent work hides from a review that only reads what is
 * there.
 *
 * ── WHY `childList` AND NOTHING ELSE ──
 *
 * The design is explicit and gives its reason: attribute churn — class toggles from
 * hover, focus, animation libraries, `data-state` on headless components — is by
 * far the highest-frequency mutation source on a real application and almost
 * never invalidates an anchor, because the selector policy already excludes
 * state classes. `childList` covers unmount, remount and reorder, which are the
 * mutations that actually break anchors. Full attribute observation is 10–100×
 * the callback volume on the main thread of every page a client visits.
 *
 * ── THE CALLBACK DOES NO DOM WORK ──
 *
 * Again: it marks the page dirty and returns. Everything else happens on a
 * debounce, because the observer fires inside the host application's own layout
 * work and anything expensive here is charged to them.
 */

/** The normal cadence, and the one it backs off to under a storm. */
const QUIET_MS = 120;
const STORM_MS = 1000;

/** The circuit-breaker: batches per rolling second, and how long it lasts. */
const STORM_BATCHES = 200;
const CALM_MS = 10_000;

export interface MutationWatch {
  destroy(): void;
}

export function watchMutations(
  doc: Document,
  win: Window,
  onChanged: () => void,
): MutationWatch {
  // `Window` does not carry MutationObserver in lib.dom, and the global is the
  // one the document actually belongs to — a widget mounted into another
  // document must not construct one from ours.
  const MO = (win as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (typeof MO !== "function") return { destroy: () => {} };

  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let rerun = false;

  // The storm breaker's own state. `batches` is what the observer increments;
  // `stormUntil` is how long the slow cadence lasts once it has tripped.
  let batches = 0;
  let windowStart = now();
  let stormUntil = 0;

  function now(): number {
    // `performance.now()` rather than Date: monotonic, and immune to a host
    // page moving the wall clock.
    return win.performance?.now?.() ?? 0;
  }

  const observer = new MO(() => {
    // ZERO DOM WORK HERE. This runs inside the host application's own
    // layout and paint; anything expensive is charged to them.
    dirty = true;
    batches++;
    schedule();
  });

  function cadence(): number {
    const t = now();
    if (t - windowStart >= 1000) {
      // A rolling second closed. More than the threshold means back off, and
      // the calm period restarts from every busy second rather than from the
      // first — so a page that is continuously busy stays slow.
      if (batches > STORM_BATCHES) stormUntil = t + CALM_MS;
      batches = 0;
      windowStart = t;
    }
    return t < stormUntil ? STORM_MS : QUIET_MS;
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(run, cadence());
  }

  function run(): void {
    timer = null;
    if (!dirty) return;
    // RE-ENTRANCY: only one pass may be in flight. A trigger arriving
    // mid-pass sets `rerun` and the current pass finishes — cancelling it
    // half-way would leave states partly applied, which is the one outcome
    // worse than being a beat late.
    if (inFlight) {
      rerun = true;
      return;
    }
    dirty = false;
    inFlight = true;
    try {
      onChanged();
    } finally {
      inFlight = false;
      if (rerun) {
        rerun = false;
        dirty = true;
        schedule();
      }
    }
  }

  observer.observe(doc.documentElement, { childList: true, subtree: true });

  return {
    destroy() {
      observer.disconnect();
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
