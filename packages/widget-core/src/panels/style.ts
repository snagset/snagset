import { t } from "../runtime/theme.ts";

/**
 * Shared panel styling.
 *
 * Every panel paints into the SAME shadow root, so a class name is global
 * across the widget and a stylesheet is only present if the panel that owns it
 * has been opened. Both of those bit us: the dock's list row was `.snag-row`,
 * which the toolbar already uses for its own flex row, and the dock's reply box
 * reused the composer's `.snag-text` — correct-looking until the dock was
 * opened first, at which point the composer's stylesheet did not exist yet and
 * the textarea rendered unstyled.
 *
 * So: form controls live here, installed by whichever panel opens first, and
 * every panel-private class carries its own prefix (`snag-dk-` for the dock).
 */

export { adopt } from "../runtime/theme.ts";

/** Text inputs and the Cancel/Send pair — shared by the composer and the dock. */
export const FORM_CSS = `
.snag-input,.snag-text{width:100%;box-sizing:border-box;background:${t.surface};color:inherit;
  border:1px solid ${t.border};border-radius:${t.radius};padding:8px;font:inherit;resize:vertical}
/* 16px on coarse pointers: anything smaller makes iOS Safari zoom the page on
   focus, which throws the reviewer out of the flow they are mid-way through. */
@media (pointer:coarse){.snag-input,.snag-text{font-size:16px}}
.snag-input:focus,.snag-text:focus{outline:2px solid ${t.focus};outline-offset:1px;border-color:transparent}
/* Never colour alone — the border says something is wrong and the
   note beside it says what, so this reads the same in greyscale. */
.snag-input--bad{border-color:${t.anchorOrphan}}
.snag-note{margin:-2px 0 0;color:${t.anchorOrphan};font-size:11px;line-height:1.35}
/* The same note, quiet: a count that is merely approaching a limit is
   information, not a problem, and it should not wear the colour that means one
   until it is one. */
.snag-note.snag-dim{color:${t.muted}}
.snag-actions{display:flex;justify-content:flex-end;gap:6px}
.snag-actions button{appearance:none;border:0;border-radius:calc(${t.radius} - 1px);padding:7px 13px;
  font:inherit;cursor:pointer;min-height:32px;transition:background ${t.motion}}
.snag-cancel{background:transparent;color:${t.muted}}
/* The armed state of Esc-stack rung 5, matching the dock's own arm exactly —
   one idiom for destruction across the product, not two that look similar. */
.snag-armed{color:${t.anchorOrphan};font-weight:600}
.snag-cancel:hover{background:${t.hover};color:inherit}
.snag-send{background:${t.accent};color:${t.onAccent};font-weight:600}
.snag-send:disabled{opacity:.45;cursor:not-allowed}
.snag-actions button:focus-visible{outline:2px solid ${t.focus};outline-offset:2px}
`;
