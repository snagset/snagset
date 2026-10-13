// snag.panels.js — the Preact UI chunk: the composer, and the dock that holds
// the list and the detail view. Reached only through a dynamic import from the
// runtime, on first use.
//
// Preact lives HERE and nowhere else. The runtime core stays vanilla so
// its whole 20 KB is available to the shield, the hit test, the position engine
// and the anchor core — and so a reviewer who never opens a panel never pays
// for a UI framework.
export { openComposer } from "./composer.tsx";
export type { ComposerProps, ComposerHandle } from "./composer.tsx";
// The dock moved to its own lazy artefact (snag.dock.js). Its
// types stay importable from here for the runtime's signatures; the CODE is
// reached through loadChunk("dock").
export type { DockProps, DockHandle } from "./dock.tsx";

/* The pre- "cross-chunk surface for snag.dock.js" stood here — Preact,
 * hooks, style, arm, markdown, strings and scroll re-exports for a dock that
 * imported them by baked `./snag.panels.js` specifier. Killed the
 * mechanism (module-map poisoning; the dock bundles its own copies) and the
 * revert left the surface behind, shipping ~1.3 KB gz of the activation
 * envelope that nothing could reach. Found by the envelope
 * re-derivation's per-module byte map. scrollToSnag moved to the dock's own
 * entry, which is the chunk whose geometry it measures.
 */
