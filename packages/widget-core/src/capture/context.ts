import { SCHEMA_VERSION } from "@snagset/types/names";
import { deriveDisplay } from "./derive.ts";
import { captureReport } from "./report.ts";
import { redactText, redactUrl } from "../redact/predicates.ts";
// The SAME function the runtime uses for `Snag.route` — see runtime/route.ts for
// why the token-segment rule lives in the eager chunk and not beside the rest
// of the vocabulary.
import { metaRoute, normalisePath, redactRoute } from "../runtime/route.ts";
import { significantQuery, type QueryPolicy } from "../runtime/params.ts";
import type { Breadcrumb, CaptureContext, PageRef, UaData } from "./types.ts";

/**
 * The T0 snapshot — what the page was, at the moment somebody pointed at it
 *
 * TAKEN AT THE CLICK, NOT AT SUBMIT. Stamps `timestamp` at "Comment
 * pressed"; places the whole snapshot there: click → freeze → derive
 * the label → snapshot → composer opens. The difference is not academic. A
 * reviewer can scroll, resize, rotate a phone or follow a client-side route
 * change between pointing at something and finishing the sentence about it, and
 * a viewport recorded at submit describes a page nobody was looking at.
 *
 * Held in memory only until the comment is sent, and dropped on cancel — an
 * abandoned composer leaves no trace anywhere (plan task 40).
 *
 * ≤ 2 ms, synchronous, one task. Twelve property reads and one regex
 * pass. No `await`, and `getHighEntropyValues` is never called — the design says
 * "not called. Ever." and is a CI grep for it.
 */

/**
 * The caps, at the one v0 field that has them: pre-cap 4096 BEFORE the
 * rules run, post-cap 2048 after.
 *
 * The pre-cap is what bounds the regex work, and the design is explicit that it
 * halves the worst case now that redaction runs on every record. The trailing
 * `…[+N]` says how much was dropped rather than leaving a silent truncation
 * that reads like the URL itself.
 */
function capUrl(raw: string, allow: readonly string[]): string {
  const pre = raw.length > 4096 ? raw.slice(0, 4096) : raw;
  const red = redactUrl(pre, allow);
  return red.length <= 2048 ? red : red.slice(0, 2048) + `…[+${red.length - 2048}]`;
}

/**
 * Where this is, structurally.: "In v0 only `normalisePath` runs;
 * `query` is `undefined`, `route` is the normalised pathname."
 *
 * `origin` is recorded for display and debugging only — and both
 * say never to match on it, which is why route identity elsewhere in the
 * runtime is pathname alone.
 */
export interface PageRefOptions {
  /**
   * The runtime's live route override (path 1) — injected
   * rather than read from module state, because this file is a separate
   * bundled copy of the shared sources and cannot see the runtime's.
   * The meta hint (path 2) is DOM and read here directly.
   */
  routeOverride?: string | null;
  /** The query policy, from the config global. Default: strip everything. */
  query?: QueryPolicy;
  doc?: Document;
}

export function derivePageRef(loc: Location = location, opts: PageRefOptions = {}): PageRef {
  // The route is a primary key and is stored as-is APART FROM
  // token-shaped segments. It went out raw while `url` for the same page load
  // was correctly redacted, so a password-reset link put its JWT into storage
  // and both exports. Same function the runtime uses for `Snag.route`, so the
  // stored key and the live one cannot disagree.
  const pathname = redactRoute(loc.pathname);
  // The ladder: override, then the meta hint, then the pathname — and the
  // SAFETY VALVE lives at the match site, not here: whatever this returns,
  // pathname equality remains a sufficient match, so a wrong hint can only
  // ever fail to widen, never orphan (F22).
  const hint = opts.routeOverride ?? (opts.doc ? metaRoute(opts.doc) : typeof document !== "undefined" ? metaRoute(document) : null);
  const query = significantQuery(loc.search ?? "", opts.query);
  // "In v0 only `normalisePath` runs; `query` is `undefined`, `route`
  // is the NORMALISED pathname." This comment said so above for months while
  // `route` was the raw pathname — so `/about/` and `/about` were two pages
  // with two sets of pins, which on a trailing-slash site (Hugo, Astro,
  // Eleventy, Next with the option flipped) halves a round at random.
  //
  // `pathname` stays as it was, minus redaction: keeps it raw because it
  // is the field a human reads, and an export that lower-cases the URL somebody
  // actually visited is an export that misquotes them.
  return {
    route: normalisePath(hint ?? pathname),
    pathname,
    ...(query ? { query } : {}),
    origin: loc.origin,
  };
}

/** The fallback is `'light'`, and matchMedia may not exist at all. */
function prefersDark(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/**
 * The v0 `capture` object.
 *
 * BOTH sentences ship, one per disabled category. The design
 * covers screenshots and says nothing about breadcrumbs; the design covers
 * breadcrumbs and says nothing about screenshots. Emitting both is the only way
 * to satisfy the "entries are sentences, not codes … rendered verbatim"
 * without writing a sentence no spec states. Punctuation is normalised to a
 * full stop on both, because two adjacent sentences in one list disagreeing
 * about it is the kind of detail a client notices and a spec does not.
 *
 * `reasons[]` is never redacted — they are our own sentences and
 * carry no page data.
 *
 * blindSpots, droppedCategories and maskedCount are OMITTED, not null and not
 * empty: they are v0.1/v1, and validates "no extra keys".
 */
// The whole outcome table moved to report.ts at — the sentences are
// normative and test/report.test.ts pins them against the spec file itself.
// Until wires the engine, every submission's screenshot situation is
// "release": not built yet, and said so.

export interface CaptureInput {
  page: PageRef;
  /**
   * The allow-list, injected rather than read from an ambient config
   * the spec names no attribute for it. Default empty, and it stays empty:
   * "the failure mode of a too-loose default (leaking a magic-link token in
   * every captured URL) is catastrophic."
   */
  urlParamAllowList?: readonly string[];
  /**
   * The crumbs chunk's `drain()` at T0, plus its honest status.
   * Injected by the runtime rather than read from an ambient module because
   * chunks are self-contained: the capture chunk cannot import the
   * crumbs chunk, and the records are ALREADY REDACTED — this
   * function stores them; it never inspects them.
   */
  breadcrumbs?: { records: Breadcrumb[]; status: "ok" | "disabled" | "truncated" };
}

export function captureContext(input: CaptureInput): CaptureContext {
  const allow = input.urlParamAllowList ?? [];

  let url: string;
  try {
    url = capUrl(location.href, allow);
  } catch {
    try {
      url = capUrl(document.URL, allow);
    } catch {
      // DEVIATION, whose third fallback is a bare
      // `origin + pathname` with no redaction pass. The design is normative prose
      // "No captured datum may be written to any storage, rendered on any
      // surface … before it has been through the redactor" — and a table cell
      // is shorthand. A JWT-shaped path segment survives on that branch
      // otherwise, which is two throws deep but not impossible.
      url = redactText(location.origin + location.pathname);
    }
  }

  // Some embedded webviews report 0 for the window dimensions.
  let w = innerWidth;
  let h = innerHeight;
  if (w === 0 || h === 0) {
    w = document.documentElement.clientWidth;
    h = document.documentElement.clientHeight;
  }

  let scr = { w: 0, h: 0 };
  try {
    // Firefox's resistFingerprinting spoofs these. Recorded as-is, never
    // "corrected" — a spoofed value is what that browser reports and pretending
    // otherwise would make the record disagree with the reviewer's own screen.
    scr = { w: screen.width, h: screen.height };
  } catch {
    /* access threw — {0,0} is the specified fallback */
  }

  const ua = navigator.userAgent || "";
  const live = (navigator as { userAgentData?: UaData }).userAgentData;
  // A structured COPY of the low-entropy triple, never the live object:
  // asserts `brands` is a plain array with no prototype chain back to
  // NavigatorUAData.
  const uaData: UaData | undefined = live
    ? {
        brands: (live.brands ?? []).map((b) => ({ brand: b.brand, version: b.version })),
        platform: live.platform,
        mobile: live.mobile,
      }
    : undefined;

  const ctx: CaptureContext = {
    schemaVersion: SCHEMA_VERSION,
    url,
    page: input.page,
    // `dpr` raw — rounds at render, and the store keeps what it saw.
    viewport: { w, h, dpr: devicePixelRatio || 1 },
    screen: scr,
    ua,
    derived: deriveDisplay(ua, uaData),
    language: navigator.language || navigator.languages?.[0] || "en",
    // NOT influenced by ?snag_theme — that parameter themes OUR ui, and
    // recording it here would misreport how the host page rendered.
    prefersColorScheme: prefersDark() ? "dark" : "light",
    timestamp: new Date().toISOString(),
    capture: captureReport({ breadcrumbs: input.breadcrumbs?.status ?? "disabled" }),
  };
  // Assigned conditionally, never `uaData: undefined`.: "`—` means the
  // field is omitted (not null, not '')", and AC the "no extra keys" makes the
  // distinction observable.
  if (uaData) ctx.uaData = uaData;
  if (input.breadcrumbs && input.breadcrumbs.status !== "disabled") {
    ctx.breadcrumbs = input.breadcrumbs.records;
  }
  return ctx;
}
