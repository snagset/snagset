/**
 * This build's id — `<release>+<content hash>` — for the `?cv=` and for
 * `Snagset.version`. One source for the stub, the runtime and the chunk
 * loader, so the three can no longer disagree by being edited separately.
 *
 * The value below is what source-level consumers see — the playground mounts
 * the runtime from source, and the unit tests import it. In the artefacts it
 * is never this: vite.config.ts's `buildId()` plugin replaces this module with
 * one exporting `<release>+~~~~~~`, and `scripts/build-id.mjs` writes the
 * content hash over the tildes once every pass has finished. An ordinary
 * module rather than a `define`,: no identifier only the build can
 * see.
 */
export const VERSION: string = "0.0.0";
