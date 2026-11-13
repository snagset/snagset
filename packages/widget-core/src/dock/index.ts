/**
 * snag.dock.js — the dock, as its own lazy artefact (funded).
 *
 * The dock was 7.4 kB gz of the panels chunk — 40% of it — and it opens ON
 * DEMAND: a reviewer who pins and never opens the list paid for it inside the
 * 40 000-byte activation envelope anyway. Splitting it is the designated
 * lever, taken here to fund the residency move (the redaction
 * predicates into the runtime), which the envelope could not otherwise absorb.
 *
 * The costs priced, honoured: the reviewer who DOES open the dock pays a
 * second fetch — softened by the runtime warming this chunk whenever the round
 * has pins — and, since the decision made chunks self-contained, this artefact bundles
 * its OWN Preact copy (as amended by that decision): lazy bytes cost
 * the envelope nothing, and a baked cross-chunk specifier was the mechanism
 * that died of module-map poisoning.
 */
export { openDock } from "../panels/dock.tsx";
export type { DockProps, DockHandle } from "../panels/dock.tsx";
// Dock GEOMETRY, exported by the dock: scrollToSnag measures the dock's own
// box to find the visible strip. It rode the panels chunk as part
// of the dead pre- cross-chunk surface — 1.2 KB of the activation envelope
// for a function only usable once THIS chunk is open.
export { scrollToSnag, visibleStrip } from "../panels/scroll.ts";
