import { CSS_VAR, cssRef, THEME_ATTR } from "@snagset/types/names";
import { STATUS } from "../storage/types.ts";

/**
 * The design tokens, the stylesheet installer, and theme selection.
 *
 * Everything the widget draws reads a `--snag-*` custom property. The host page
 * CANNOT set them on `:root` — `:host { all: initial }` severs inheritance into
 * the shadow root, and that is the point. Host theming goes through
 * config instead, written onto our own host element.
 */

/** `t.bg` → `var(--snag-bg)`. Derived, so a rename moves the public theming API. */
export const t = Object.fromEntries(
  Object.keys(CSS_VAR).map((k) => [k, cssRef(k as keyof typeof CSS_VAR)]),
) as Record<keyof typeof CSS_VAR, string>;

/**
 * The four status colours, exposed as custom properties because obliges
 * it — and GENERATED from the one STATUS table rather than restated, so each
 * literal still occurs exactly once in the source.
 *
 * Deliberately absent from the dark block: The design forbids a per-surface
 * palette, and a theme is a surface. Status must mean the same thing in both.
 */
const statusTokens = Object.entries(STATUS)
  .map(([key, s]) => `  ${CSS_VAR[`status${key[0]!.toUpperCase()}${key.slice(1)}` as keyof typeof CSS_VAR]}:${s.colour};`)
  .join("\n");

/**
 * Rule 1 is `all: initial` ALONE and rule 2 carries the tokens — never merged.
 * `all` resets every property declared before it *in the same rule*, so a single
 * combined block silently wipes the custom properties it appears to define
 * theme.test.ts asserts the two-rule shape on the string.
 */
export const TOKENS_CSS = `
:host{all:initial}
/* Setting the .hidden PROPERTY is a no-op the moment a class sets an author
   display, because an author declaration beats the UA stylesheet's
   [hidden]{display:none}. The degraded-state notice shipped exactly that way —
   display:flex — so it sat on a client's page permanently and empty, on pages
   where nothing had failed. Every DOM assertion passed, because they all read
   the property rather than what was on screen. One rule fixes the whole class
   of it, rather than a companion selector per component that the next
   component will forget. */
[hidden]{display:none!important}
:host{
  display:block;
  font:400 14px/1.45 ${t.font};
  color:${t.fg};
  ${CSS_VAR.font}:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  /* One accent across both surfaces. The widget used to carry #5b5bd6
     and the dashboard #2b53d8 — two brand blues, each picked for contrast on
     its own ground at a different time, recorded as design-divergence #1. */
  ${CSS_VAR.accent}:#2a51b8;
  ${CSS_VAR.bg}:#fefdfc;
  ${CSS_VAR.fg}:#181716;
  /* #6b7280 measured 4.28:1 on --snag-surface — under 4.5 for the small text
     that uses it most (the 11px navigator counter, the dock's dim spans), and
     the design admits no exemption for "nearly". Re-solved for the warm
     ground against the HOVER tint, which is the worst of the three: 5.06 on
     surface, 5.73 on bg, 4.89 on hover — margin rather than a pass by a hair,
     because a token this close to the line fails again on the next tint. */
  ${CSS_VAR.muted}:#666564;
  ${CSS_VAR.border}:#e4e3e0;
  ${CSS_VAR.radius}:8px;
  ${CSS_VAR.shadow}:0 6px 24px -4px rgb(0 0 0 / .18);
  ${CSS_VAR.z}:2147483647;
  ${CSS_VAR.motion}:160ms;
  /* Derived with color-mix() from bg/fg/accent/muted, so they need NO dark
     override: custom properties substitute lazily, so flipping the four theme
     tokens below re-derives every one of these for free. That is why a second
     palette does not exist — there is only one, and one set of deltas.
     on-accent used to sit in this list and is NOT computed — a literal ink
     picked to contrast the accent, which therefore cannot re-derive from a
     flip. It moved to the theme group when dark mode turned out to be
     shipping white on a lightened accent at 3.0:1. */
  ${CSS_VAR.surface}:color-mix(in srgb, ${t.fg} 6%, ${t.bg});
  ${CSS_VAR.sunken}:color-mix(in srgb, ${t.fg} 3%, ${t.bg});
  /* 11% put accent-coloured link text at 4.26:1 on a hovered row
     .1 item 7's 4.5. 8% clears it at 4.53 and still reads as a hover. */
  ${CSS_VAR.hover}:color-mix(in srgb, ${t.fg} 8%, ${t.bg});
  ${CSS_VAR.onAccent}:#fff;
  ${CSS_VAR.focus}:color-mix(in srgb, ${t.accent} 62%, ${t.fg});
  ${CSS_VAR.disabled}:color-mix(in srgb, ${t.muted} 52%, ${t.bg});
${statusTokens}
  /* Anchor state is a DIFFERENT axis from status: status owns the pin's fill,
     anchor state owns its border and its SHAPE. Red rather than the
     spec's original amber, because amber is also STATUS.progress and the ring
     disappeared on it. Red is unused by the status palette, so it collides with
     nothing — and the shape change means it never has to carry the state alone. */
  ${CSS_VAR.anchorOrphan}:#DC2626;
}
:host([${THEME_ATTR}="dark"]){
  /* The accent is a TEXT colour as often as a fill (every dock link uses it),
     and the old #5b5bd6 on a dark ground was 2.4:1 — every link in the panel
     failed in dark mode, which no test caught until the axe sweep
     ran against a genuinely dark tree. The shared accent lightens to #8aafff
     for the same reason: 7.83 on bg, 6.33 on the hover tint. */
  ${CSS_VAR.accent}:#8aafff;
  /* …and its INK moves with it. A light accent is a fill as well as a text
     colour (the pressed toolbar segment, the add-mode chip), and white on a
     lightened accent is ~3:1 — fixing the link colour alone would trade one
     failure for another. Dark ink on #8aafff measures 7.83:1. */
  ${CSS_VAR.onAccent}:#1d1c1a;
  ${CSS_VAR.bg}:#1d1c1a;
  ${CSS_VAR.fg}:#f0eeec;
  ${CSS_VAR.muted}:#9a9997;
  ${CSS_VAR.border}:#2d2c2b;
  ${CSS_VAR.shadow}:0 6px 24px -4px rgb(0 0 0 / .6);
}
/* One token carries reduced motion, so no component needs its own media query
   and (no animations in the shadow root) holds by construction. */
@media (prefers-reduced-motion:reduce){:host{${CSS_VAR.motion}:0ms}}
/* FORCED COLORS (v0.1) — the same one-token trick, for the
   same reason: every surface reads these, so redefining them here is the whole
   implementation. Under a forced palette all fills become SYSTEM colours and
   state is carried entirely by text. The four status fills are deliberately
   NOT overridden here: the UA already replaces every painted colour under a
   forced palette, so restating them would be four declarations buying
   nothing. What the text carries is the number and the status name — which
   the design required anyway, colour never being the only signal. forced-color-adjust:none is
   applied on the pin alone, where the design puts it — a numeral painted
   in ButtonText on a ButtonFace pin is otherwise unreadable. */
@media (forced-colors:active){
  :host{
    /* muted → CanvasText, NOT GrayText. GrayText is the system's DISABLED
       ink; spending it on secondary text paints live controls (the reply's
       edit/delete) as unavailable. --snag-disabled keeps GrayText, which is
       where it belongs — and losing the muted/normal distinction is what
       the design asks for anyway: state carried by text, not by colour. */
    ${CSS_VAR.bg}:Canvas;${CSS_VAR.fg}:CanvasText;${CSS_VAR.muted}:CanvasText;
    ${CSS_VAR.border}:CanvasText;${CSS_VAR.accent}:Highlight;${CSS_VAR.onAccent}:HighlightText;
    /* hover stays CANVAS, not Highlight: accent resolves to Highlight too, so
       a hovered accent-coloured link was Highlight ON Highlight — invisible to
       the very users this mode exists for. Under a forced palette the UA draws
       its own hover and focus indication; ours must not fight it. */
    ${CSS_VAR.surface}:Canvas;${CSS_VAR.sunken}:Canvas;${CSS_VAR.hover}:Canvas;
    ${CSS_VAR.focus}:Highlight;${CSS_VAR.disabled}:GrayText;${CSS_VAR.shadow}:none;
    ${CSS_VAR.anchorOrphan}:CanvasText;
  }
  .snag-pin{border-color:CanvasText!important;color:CanvasText!important;forced-color-adjust:none}
}
`;

/**
 * The internal layer ladder — small integers, deliberately.
 *
 * Every surface used to be written as `calc(var(--snag-z) - n)`, and in FIREFOX
 * that silently did nothing: `--snag-z` is 2147483647, z-index arithmetic is
 * evaluated in single precision, and INT_MAX is past the point where float32 can
 * represent consecutive integers — so `calc(z - 1)`, `calc(z - 2)` and
 * `calc(z - 3)` all computed to 2147483647. The whole ladder collapsed to a tie
 * and DOM insertion order decided it, which put the shield over the pins and
 * turned a pin click in `add` into a duplicate comment.
 *
 * It does not need the arithmetic at all. host.ts gives the shadow host
 * `isolation: isolate`, so everything in here is already sealed into its own
 * stacking context and only ever competes with its siblings. `--snag-z` stays
 * exactly where it belongs — on the HOST, where it is the one number that has to
 * beat the client's page, and where it remains the public knob the design makes it.
 *
 * The ladder, bottom to top, and why each rung is where it is:
 *
 *   1 shield     under everything of ours, over everything of the host's
 *   2 highlight  the `add` outline, drawn over the shield that takes the clicks
 *   3 pins       ABOVE the shield, so tapping a pin READS it
 *   4 chip       the `add` label, over the pin it may overlap
 *   5 dock       the panel
 *   6 notice     an alert must not be covered by the panel it is announcing
 *   7 toolbar    always reachable; it is how you leave every state
 *   8 composer   whatever you are typing into wins
 *
 * Written as one block rather than per-key JSDoc because esbuild preserves
 * JSDoc on object properties, and 437 bytes of it was reaching the wire.
 */
export const LAYER = {
  shield: 1,
  highlight: 2,
  pins: 3,
  chip: 4,
  dock: 5,
  notice: 6,
  toolbar: 7,
  composer: 8,
} as const;

const installed = new WeakMap<ShadowRoot, Set<string>>();

/**
 * Install a stylesheet once per shadow root, keyed by id.
 *
 * Constructable stylesheets first: no `<style>` tag means nothing for
 * a strict `style-src` to reject, which is A7. The `<style>` fallback is the
 * F3 ladder — it works, it just costs the host a CSP allowance, which is
 * why it is not the primary path.
 *
 * Insertion order is cascade order, and the token sheet is installed first by
 * mount(), so no component sheet can precede the tokens it consumes.
 */
export function adopt(root: ShadowRoot, id: string, css: string): void {
  let ids = installed.get(root);
  if (!ids) installed.set(root, (ids = new Set()));
  if (ids.has(id)) return;
  ids.add(id);

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    return;
  } catch {
    /* no constructable stylesheets, or replaceSync threw — take the ladder */
  }
  const doc = root.ownerDocument ?? document;
  const el = doc.createElement("style");
  el.setAttribute(`data-snag-${id}`, "");
  el.textContent = css;
  root.appendChild(el);
}

export type ThemePref = "light" | "dark" | "auto";

/** Narrow an arbitrary config string to the closed set; anything else is `auto`. */
export function themePref(raw: string | undefined): ThemePref {
  return raw === "light" || raw === "dark" ? raw : "auto";
}

/**
 * Select the theme.
 *
 * `auto` reflects `matchMedia('(prefers-color-scheme: dark)')` onto the SAME
 * registered `data-snag-theme` token, in a second position — our own host
 * element rather than the script tag. Nothing new is minted, and A3 is
 * satisfied because the attribute never lands on a host-page element.
 *
 * One listener, no polling. Returns its own disposer.
 */
export function applyTheme(host: HTMLElement, pref: ThemePref): () => void {
  const attr = THEME_ATTR;
  if (pref !== "auto") {
    host.setAttribute(attr, pref);
    return () => host.removeAttribute(attr);
  }

  const mq = host.ownerDocument?.defaultView?.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mq) {
    // No matchMedia: fall to the light default rather than guessing dark. The
    // token block's base values are light, so this also costs nothing.
    host.setAttribute(attr, "light");
    return () => host.removeAttribute(attr);
  }

  const sync = (): void => host.setAttribute(attr, mq.matches ? "dark" : "light");
  sync();
  mq.addEventListener("change", sync);
  return () => {
    mq.removeEventListener("change", sync);
    host.removeAttribute(attr);
  };
}
