/**
 * `CaptureContext` — what the page was, at the moment somebody pointed at it
 *
 * The v0 shape is exactly twelve emitted keys and the design is a CLOSED type:
 * validates "with no extra keys and no null values", which is only enforceable
 * because it is closed. The design fixes the omission convention too — "`—` means
 * the field is omitted (not `null`, not `''`) when unavailable" — so an absent
 * `uaData` is an absent KEY, never `uaData: undefined`.
 *
 * Deliberately absent, and not to be added yet: `build` (v1) and `custom`
 * (v1). `breadcrumbs` left this list at; the `capture` object widened to
 * the full shape at — the v0.1 fields are TYPED now and OMITTED
 * until their producers exist (blind spots and maskedCount are the
 * screenshot pass, droppedCategories is the payload assembly), because an
 * empty array claims a producer ran and found nothing.
 */

export type SchemaVersion = "snagset.v1";

/**
 * Where a comment was left, structurally.
 *
 * `origin` is recorded for display and debugging ONLY — and both
 * say never to match on it.
 */
export interface PageRef {
  route: string;
  pathname: string;
  query?: Record<string, string>;
  origin: string;
}

/**
 * The low-entropy client-hint triple, and only that.
 *
 * A structured COPY, never the live `NavigatorUAData` — asserts `brands`
 * is a plain array with no prototype chain back to it. `getHighEntropyValues`
 * is never called; the design says "not called. Ever." and is a CI grep.
 */
export interface UaData {
  brands: { brand: string; version: string }[];
  platform: string;
  mobile: boolean;
}

/**
 * One breadcrumb. `message` and `data` are REDACTED by the time a
 * value of this type exists — redacts at record time, so there is no
 * moment where a rendered, exported or posted breadcrumb differs from the
 * stored one.
 */
export interface Breadcrumb {
  t: string;
  /** `system` = widget-internal events (capture failed, entries dropped). */
  type: "console" | "error" | "network" | "navigation" | "click" | "system";
  level?: "log" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface CaptureContext {
  schemaVersion: SchemaVersion;
  /** Already through `redactUrl` and the caps by the time it lands here. */
  url: string;
  page: PageRef;
  /** `dpr` is stored RAW and rounded at render — the store never rounds. */
  viewport: { w: number; h: number; dpr: number };
  screen: { w: number; h: number };
  /** Raw and unparsed. The authoritative record; `derived` is never written back. */
  ua: string;
  uaData?: UaData;
  /**
   * Optional in the TYPE and mandatory in the producer: The design says "never
   * omitted once runs". The `?` is for readers of records written before
   * it existed, not a licence to skip it.
   */
  derived?: { browser: string; os: string; device: "Mobile" | "Desktop" };
  language: string;
  prefersColorScheme: "light" | "dark";
  timestamp: string;
  /** The ring buffer's contents at T0 — absent when the category is
   *  off or the crumbs chunk never arrived, and `capture.breadcrumbs` says which. */
  breadcrumbs?: Breadcrumb[];
  /** Populated on EVERY submission — same optionality note. */
  capture?: {
    screenshot?: "ok" | "disabled" | "failed" | "timeout" | "tainted";
    breadcrumbs?: "ok" | "disabled" | "truncated";
    /** Sentences, not codes, rendered verbatim to the reviewer. */
    reasons?: string[];
    /** Things present on the page that could not be captured, named —
     *  the disclosure text verbatim ("1 cross-origin iframe not captured:
     *  js.stripe.com"). */
    blindSpots?: string[];
    /** Categories shed to fit the payload budget, in drop order. */
    droppedCategories?: string[];
    /** Elements masked by data-snag-mask / .snag-mask / .snag-block. */
    maskedCount?: number;
  };
}
