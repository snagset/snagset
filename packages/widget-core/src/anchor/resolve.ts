import { hostAttr, widgetAttr } from "@snagset/types/names";
import { normalizeText } from "./similarity.ts";
import { stateFor, scoreV0 } from "./score.ts";
import { pathOf, roleOf, accessibleNameOf } from "./record.ts";
import { isRendered } from "./geometry.ts";
import type { AnchorRecord, AnchorResolution, AnchorReason, AnchorStrategy } from "./types.ts";

/**
 * The re-anchor cascade. Ordered by trust: an explicit hook is a
 * promise from the codebase; a generated CSS selector is a guess that Tailwind
 * invalidates every release; a path is a last resort.
 *
 * The cascade stops at the FIRST step that produces candidates — it does not
 * merge across steps. A later step agreeing adds nothing; a later step
 * disagreeing would only tempt us into averaging two guesses, which is how a
 * pin ends up confidently on the wrong element.
 */

const HOOK_ATTRS = [
  hostAttr("anchor"),
  "data-testid",
  "data-test-id",
  "data-test",
  "data-cy",
  "data-qa",
  "data-pw",
  "data-automation-id",
];

export interface ResolveOptions {
  viewportWidth?: number;
  /**
   * The v0.1 cascade, injected.
   *
   * v0 ships `testid` and `css` ONLY — the design is explicit, and P8
   * asserts that a v0 session fetches neither anchor chunk. The extended steps
   * and the whole corroboration scorer they need live in `snag.anchor-ext.js`
   * and are handed in here when a release loads them.
   *
   * They shipped eagerly in this file until `css` was real, and that was
   * load-bearing rather than sloppy: with nothing generating a selector, the
   * v0.1 fallbacks were the only thing resolving anchors on a page without
   * `data-testid`. Splitting them out was only safe once generation landed.
   */
  extended?: ExtendedResolver;
  /** The per-pass caches, created once per reanchor pass and handed to
   *  every extended call — the index blow-up fix. Opaque to this module. */
  passCaches?: import("./ext.ts").PassCaches;
}

/** What `snag.anchor-ext.js` exports. Returns null when its own steps all miss. */
export type ExtendedResolver = (
  rec: AnchorRecord,
  root: ParentNode,
  ctx: { viewportWidth?: number; caches?: import("./ext.ts").PassCaches },
) => AnchorResolution | null;

interface Step {
  strategy: AnchorStrategy;
  applicable(rec: AnchorRecord): boolean;
  find(rec: AnchorRecord, root: ParentNode): Element[];
  /** Per-candidate quality in [0,1]; 1 for exact hits. */
  quality?(el: Element, rec: AnchorRecord): number;
  extended?: boolean;
}

const esc = (v: string): string =>
  typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&");

const STEPS: Step[] = [
  {
    strategy: "testid",
    applicable: (r) => !!r.testid,
    find: (r, root) =>
      query(root, HOOK_ATTRS.map((a) => `[${a}="${esc(r.testid!)}"]`).join(",")),
  },
  {
    // Cascade position 2 — RESIDENT, not in the extension chunk:
    // Keeps `domid` in the core because it is two lines and the fast path
    // already names it. Only STABLE ids are ever recorded (capture/selector.ts
    // rejects framework-generated ones), so a hit here is an explicit hook in
    // everything but spelling.
    strategy: "domid",
    applicable: (r) => !!r.domid,
    find: (r, root) => query(root, `#${esc(r.domid!)}`),
  },
  {
    strategy: "css",
    applicable: (r) => !!r.css,
    find: (r, root) => {
      try {
        return query(root, r.css!);
      } catch {
        return []; // a stale selector can be syntactically invalid; that is a miss, not a crash
      }
    },
  },
];

function query(root: ParentNode, selector: string): Element[] {
  return [...root.querySelectorAll(selector)].filter(isNotOurs);
}
/** Never resolve onto our own UI — the widget must be invisible to itself. */
function isNotOurs(el: Element): boolean {
  return !el.closest(`[${widgetAttr("root")}]`);
}



/**
 * Does this element still look like the one that was pinned?
 *
 * A GENERATED SELECTOR CAN BE POSITIONAL. When an element has no stable hook,
 * finder falls back to structure — `nav li:nth-of-type(3) > a` — and after a
 * release that selector resolves confidently to whatever now occupies slot 3.
 * The rebuild spike caught exactly that: the Pricing nav link resolved to Docs,
 * state `anchored`, score 0.9. A pin sitting on Docs claiming to be about
 * Pricing is the silent lie this whole product is written against, and "zero
 * silently wrong" is the metric it is sold on.
 *
 * `scoreV0`'s own comment asserted that "v0 records no role, name, text or
 * path" and used that to justify trusting a hit unchecked. It is simply not
 * true — `createElementAnchor` records all four — so the corroborating evidence
 * was sitting in the record the whole time, unread.
 *
 * NEUTRAL WHEN THERE IS NOTHING TO CHECK. A record with no text is not
 * penalised for the absence; only a positive disagreement counts. And the
 * containment tests are deliberately loose, because the alternative failure —
 * orphaning every element whose label was reworded — costs a reviewer their
 * pins for a copy edit.
 */
function corroboratesText(el: Element, rec: AnchorRecord): boolean {
  const want = rec.text?.exact;
  if (!want) return true;
  const got = normalizeText(el.textContent ?? "");
  if (!got) return true; // an element with no text at all cannot disagree
  return got === want || got.includes(want) || want.includes(got);
}

/**
 * THE HONESTY RULES, in one place, applied to an element somebody already found.
 *
 * Extracted because there are now two ways to arrive at an element — the full
 * cascade, and the fast path — and the fast path got this wrong twice in
 * one afternoon by re-implementing it. First it reported `anchored` for a
 * `display:none` element, because the printed snippet checks `isConnected`
 * and `matches` and says nothing about rendering. Then it reported `anchored`
 * for a positional selector that had landed on the wrong element, because
 * `matches()` is true for exactly that case — which is the single failure the
 * whole cascade exists to prevent.
 *
 * Short-circuits the SEARCH. It does not license a different answer, and
 * the way to keep that true is to have one function that decides.
 *
 * Mutates `reasons` and returns the capped score, which is how the caller it
 * was lifted out of already worked.
 */
export function assess(
  el: Element,
  rec: AnchorRecord,
  score: number,
  reasons: AnchorReason[],
): number {
  if (!isRendered(el)) reasons.push("hidden");
  /**
   * Row F4 — "v0 `anchored` + `shadow-boundary` **on the host**".
   *
   * The reason existed in the union and nothing pushed it, so a pin inside a
   * web component reported plain `anchored` while the record's own label —
   * which quotes the control the reviewer pointed at — disagreed with where the
   * mark actually sits, silently.
   *
   * It does NOT cap the score. F4 is explicit that an open-root pin is
   * genuinely `anchored`: the host resolves exactly and the offset puts the pin
   * where the click was. This is provenance a reader can act on, not a doubt.
   */
  if (rec.hostPath?.length) reasons.push("shadow-boundary");
  // A structural selector that landed on something else must not claim
  // `anchored` — that is the one state the reviewer is shown no warning in.
  const drifted = !corroboratesText(el, rec);
  if (drifted) reasons.push("text-drift");
  let capped = reasons.includes("hidden") ? Math.min(score, 0.7) : score;
  if (drifted) capped = Math.min(capped, 0.5); // below stateFor's 0.75 → approximate
  return capped;
}

const MISS: AnchorResolution = {
  element: null,
  strategy: "none",
  score: 0,
  state: "orphaned",
  reasons: ["not-found"],
  candidates: 0,
};

export function resolveAnchor(
  rec: AnchorRecord,
  root: ParentNode = document,
  opts: ResolveOptions = {},
): AnchorResolution {
  const reasons: AnchorReason[] = [];

  for (const step of STEPS) {
    if (!step.applicable(rec)) continue;
    const found = step.find(rec, root);
    if (found.length === 0) continue;

    // v0 has no corroborating facets to weigh, so scoring is the 8-line scorer.
    const score = scoreV0(step.strategy as "testid" | "css", found.length);
    const el = found[0]!;
    if (found.length > 1) reasons.push("ambiguous");
    const capped = assess(el, rec, score, reasons);
    const resident: AnchorResolution = {
      element: el,
      strategy: step.strategy,
      score: capped,
      state: stateFor(capped),
      reasons: reasons.length ? reasons : ["exact"],
      candidates: found.length,
    };
    /**
     * A DRIFTED hit does not get the last word once the extended steps exist
     * `text-drift` means a structural selector landed on an element
     * whose text disagrees with the record — corpus row the exact shape: the
     * list was rebuilt, `li:nth-of-type(4)` still matches SOMETHING, and the
     * words moved elsewhere. The capped 0.5 is the right answer when it is
     * the only answer; when `text-exact` can place the pin on the element
     * that actually carries the recorded words at 0.8, returning the wrong
     * element at 0.5 is the silent lie with a warning sticker on it. The
     * better score wins; ties keep the resident answer.
     */
    if (resident.reasons.includes("text-drift") && opts.extended) {
      const better = opts.extended(rec, root, {
        ...(opts.viewportWidth === undefined ? {} : { viewportWidth: opts.viewportWidth }),
        ...(opts.passCaches ? { caches: opts.passCaches } : {}),
      });
      if (better && better.score > resident.score) return better;
    }
    return resident;
  }

  // Both v0 steps missed. A release that has loaded the ext chunk gets one more
  // chance; v0 does not, and an honest orphan is the correct answer there.
  return (
    opts.extended?.(rec, root, {
      ...(opts.viewportWidth === undefined ? {} : { viewportWidth: opts.viewportWidth }),
      ...(opts.passCaches ? { caches: opts.passCaches } : {}),
    }) ?? MISS
  );
}

