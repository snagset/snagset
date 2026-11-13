/**
 * The yield primitive and the slicing rule.
 *
 * Every rule in this file exists because of Hypothesis client issue #3919: an
 * anchoring path that was `async` in signature but never actually yielded
 * froze pages for 10+ seconds. The primitive is `MessageChannel`, not
 * `setTimeout(0)` (no 4 ms clamp, same queue position the scheduler polyfills
 * use), with `scheduler.yield()` when the engine has it — `requestIdleCallback`
 * is not an option on our Safari 16.4 floor.
 *
 * ONE SOURCE FILE, bundled by every chunk that loops unboundedly: the
 * text index build, the ARIA sweep, the fuzzy windows. `SLICE_MS = 4` is
 * derived, not invented — pin position sync owns 4 ms of every
 * frame and no anchoring task may exceed 16, so a 4 ms slice sits four times
 * inside the hard ceiling with the frame's other work still funded.
 */

declare const scheduler: unknown;

export const SLICE_MS = 4;

interface SchedulerLike {
  yield(): Promise<void>;
}

export const yieldToMain: () => Promise<void> =
  typeof scheduler !== "undefined" && "yield" in (scheduler as unknown as SchedulerLike)
    ? () => (scheduler as unknown as SchedulerLike).yield()
    : () =>
        new Promise<void>((r) => {
          const { port1, port2 } = new MessageChannel();
          port1.onmessage = () => {
            port1.close();
            r();
          };
          port2.postMessage(0);
        });

/** Run units, yielding whenever a slice's 4 ms is spent. */
export async function sliced<T>(units: Iterable<() => T>, sliceMs = SLICE_MS, out: T[] = []): Promise<T[]> {
  let t = performance.now();
  for (const unit of units) {
    out.push(unit());
    if (performance.now() - t >= sliceMs) {
      await yieldToMain();
      t = performance.now();
    }
  }
  return out;
}
