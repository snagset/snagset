import { PRODUCT, TERM_ITEM, TERM_ITEM_PLURAL, TERM_SET } from "@snagset/types/names";

/**
 * The formatter, separated from the catalogue so a catalogue can be per-CHUNK.
 *
 * Both chunks used to import one flat `en` object, and a bundler cannot
 * tree-shake object properties — so every `dock.*`, `composer.*` and `export.*`
 * string shipped inside `snag.runtime.js` too, which is the chunk every activated
 * reviewer downloads before any panel exists. That was 1.6 KB of strings the
 * runtime can never render, and it was the whole reason the activation envelope
 * went over the normative 40 KB.
 *
 * `make()` binds a lookup to one catalogue. The runtime binds the CORE set; the
 * panels chunk binds core-plus-panels. Adding a panel string now costs the lazy
 * chunk only, which is where the cost belongs.
 */

/**
 * Merged into every call, so no entry has to carry the product name as a
 * literal — the rename-in-minutes claim is only true if the brand
 * appears in the catalogue zero times.
 */
const STANDING: Record<string, string> = {
  product: PRODUCT,
  set: TERM_SET,
  item: TERM_ITEM,
  items: TERM_ITEM_PLURAL,
};

/**
 * `format("dock.position", { n: 2, total: 3 })` → `"2 of 3"`.
 *
 * An unknown placeholder is left visible as `{name}` rather than silently
 * blanked: a missing param should look wrong in review, not read as a typo in
 * production.
 */
export function make<T extends Record<string, string>>(catalogue: T) {
  return (key: keyof T, params?: Record<string, string | number>): string =>
    // The `?? ""` is unreachable through the typed API — `keyof T` guarantees
    // the entry — and exists only because `noUncheckedIndexedAccess` cannot see
    // that. It is not a silent fallback for a missing key; a missing key is a
    // compile error.
    (catalogue[key] ?? "").replace(/\{(\w+)\}/g, (whole, name: string) => {
      const v = params?.[name] ?? STANDING[name];
      return v === undefined ? whole : String(v);
    });
}

/** Counts are locale-formatted; identifiers and pin numbers are NOT. */
export const count = (n: number): string => new Intl.NumberFormat().format(n);

/** Human-facing dates. Machine-facing ones stay ISO 8601 — see the JSON export. */
export const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
};
