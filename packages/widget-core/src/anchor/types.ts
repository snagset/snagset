// Runtime vocabulary for anchoring. Ephemeral except where stated;
// adds no field to the closed types.

export type AnchorStrategy =
  | "testid"
  | "domid"
  | "css"
  | "aria"
  | "text-exact"
  | "text-fuzzy"
  | "path-rect"
  | "none"
  | "manual"; // v2 human re-pin; reported, never produced by resolve()

export type AnchorReason =
  | "exact"
  | "ambiguous"
  | "hidden"
  | "breakpoint"
  /** A selector matched, but the element's text disagrees with the record —
   *  the classic positional-selector drift after a release. */
  | "text-drift"
  | "fuzzy"
  | "shadow-boundary"
  | "shadow-path"
  | "transient-container"
  | "virtualised"
  | "index-truncated"
  | "budget-exceeded"
  | "not-found";

export type AnchorState = "anchored" | "approximate" | "orphaned";

/**
 * The durable record of what a pin pointed at — many independent facets, so a
 * rebuild that destroys some still leaves others. This is the artefact the spike
 * measures: it must survive a real release delta WITHOUT EVER LYING.
 */
export interface AnchorRecord {
  /**
   * How the pin was MADE — a consumer can tell a text pin from an
   * element pin without inspecting facets. Absent means "element": every
   * record written before predates the field.
   */
  source?: "element" | "text";
  /** Explicit hooks, in priority order. Authoritative when present. */
  testid?: string;
  domid?: string;
  /** Generated CSS selector — the most brittle facet on a Tailwind/Radix app. */
  css?: string;
  /** ARIA role + accessible name: survives class churn, breaks on copy rewrites. */
  role?: string;
  accessibleName?: string;
  /** Text quote with context, Hypothesis-style. */
  text?: { exact: string; prefix?: string; suffix?: string };
  /** Tag-name path, root-last. Compared by SUFFIX (see pathSimilarity). */
  path?: string[];
  /** Absolute positional XPath — DIAGNOSTIC ONLY. Exported to the
   *  W3C-shaped export and the MCP locator hint; never resolved against: its
   *  failure mode is silently returning a DIFFERENT element. */
  xpath?: string;
  /** Document-relative rect at capture, for the path-rect tie-break. */
  rect?: { x: number; y: number; w: number; h: number };
  /** Fractional offset of the click inside the element — where the pin sits. */
  offset?: { fx: number; fy: number };
  /** Viewport bucket at capture; a different bucket voids path-rect. */
  breakpoint?: string;
  /**
   * Selector path through the host page's OPEN shadow roots, outermost first
   *
   * At v0 this is PROVENANCE, not an address: the anchor itself is built
   * against the outermost host, because no CSS selector crosses a shadow
   * boundary. Its presence is what lets `resolve` report `shadow-boundary` —
   * row F4 requires that reason on every pin inside a web component,
   * and without the field there was nothing to key it on, so a pin on a
   * component claimed plain `anchored` and was never capped.
   *
   * Tags ADDRESSING through it v0.1. Recording it is v0's half.
   */
  hostPath?: string[];
  /**
   * Human-readable description of what was pinned, derived at creation
   * (R5 — 03 populates it via the deriveAnchorLabel).
   * This is what an orphaned pin says in ANNOTATION MODE, where there is no
   * screenshot to fall back on. It is the whole fallback story on a
   * bucket-less install, so it is never optional.
   */
  label: string;
}

export interface AnchorResolution {
  element: Element | null;
  strategy: AnchorStrategy;
  /** 0–1. */
  score: number;
  state: AnchorState;
  reasons: AnchorReason[];
  /** How many candidates the winning step produced — drives the ambiguity factor. */
  candidates: number;
}
