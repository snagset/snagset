/**
 * The mark, and its geometry is not ours to adjust.
 *
 * The pin is the shipped one from `pins.ts`: a circle of r 12 with its
 * lower-left quadrant squared, the same construction as
 * `border-radius: 50% 50% 50% 2px`. So the favicon, the app icon and the thing
 * on the client's own page are ONE object, which no amount of guideline buys
 * later — if the pin changes in `pins.ts`, this changes with it.
 *
 * THREE PROPERTIES ARE LOAD-BEARING, and records that each was removed
 * once while "constructing" the drawing, and each had to be put back:
 *
 *   1. The pin FLOATS — 4.3 units of air between its point and the rule. That
 *      gap is the difference between a mark being placed and one being parked.
 *   2. The composition is ASYMMETRIC — eight units of rule run on past the pin
 *      with nothing on them. The overhang is what says *page* rather than
 *      *underline*: the document carries on past the thing you found.
 *   3. ONE alignment, and it reads only because nothing else lines up — the
 *      pin's sharp corner and the rule's left end share x 0.
 *
 * The rule for anyone refining it: stroke weight, colour and file
 * preparation are in scope; **position, scale and alignment are the
 * composition.** Centring it, shrinking it or sitting it on the rule replaces
 * all three with defaults.
 *
 * `currentColor` rather than a literal, so it inherits ink in both themes.
 */
export function Mark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className} style={{ display: "block" }}>
      <path d="M0 24V12A12 12 0 0 1 12 0a12 12 0 0 1 12 12 12 12 0 0 1-12 12z" fill="currentColor" />
      <path d="M0 30h32" stroke="currentColor" strokeWidth="3.4" strokeLinecap="square" />
    </svg>
  );
}
