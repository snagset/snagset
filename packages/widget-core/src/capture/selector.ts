import { finder } from "@medv/finder";
import { isSensitiveValue } from "../redact/predicates.ts";
import { anchorTargetOf, shadowHosts } from "../anchor/shadow.ts";
import { hostAttr } from "@snagset/types/names";

/**
 * The shared `data-snag-` prefix, DERIVED rather than typed.
 *
 * The design forbids a literal token anywhere under `src/` — that rule is the
 * whole reason a rename is a registry edit and not a grep. There is no exported
 * prefix constant, so this takes a registered attribute and keeps what comes
 * before its own name, exactly as `runtime/draft.ts` derives its storage prefix.
 */
const HOST_ATTR_PREFIX = hostAttr("anchor").replace(/anchor$/, "");

/**
 * Generating the durable half of an anchor.
 *
 * ── Why this was the most important thing missing ──
 *
 * The cascade table tags `testid` and `css` v0 and everything else v0.1,
 * so the v0 cascade is exactly those two steps. `css` was never generated —
 * `createElementAnchor` only ever COPIED an injected `opts.css` and nothing
 * passed one — and a typical page has no `data-testid` either. So both v0 steps
 * had nothing to work with, and what was actually resolving anchors was the
 * v0.1 fallbacks (`aria`, `text-exact`, `path-rect`) which the pin layer
 * switches on eagerly. The published durability numbers describe a selector the
 * widget could not produce.
 *
 * ── Why it lives in the capture chunk ──
 *
 * Generation happens once, at creation, which only ever occurs with the
 * composer open. RESOLUTION — which runs eagerly on every page load — needs
 * none of this. Same boundary as the label and the T0 snapshot: the runtime
 * injects the result rather than importing the generator.
 */

/**
 * Preferred hooks, .2's order. `data-snag-anchor` is the documented
 * opt-in escape hatch: a host app that adds it to a component gets a permanent,
 * refactor-proof anchor.
 */
const TEST_ID_ATTRS = [
  hostAttr("anchor"),
  "data-testid",
  "data-test-id",
  "data-test",
  "data-cy",
  "data-qa",
  "data-pw",
  "data-automation-id",
];

/** Pass A's set — the hooks worth building a selector on and nothing else. */
const STABLE_ATTRS = new Set([
  ...TEST_ID_ATTRS,
  "name",
  "aria-label",
  "role",
  "type",
  "itemprop",
]);

/** Pass B additionally allows these ("Also allowed in selectors"). */
const ALSO_ALLOWED = new Set(["name", "type", "role", "aria-label", "itemprop", "href", "alt", "lang"]);

/**
 * The denylist, and every entry is a framework that rebuilds its value.
 * A selector built on one of these works until the next deploy, which is the
 * single failure this product exists to avoid — and worse than no selector,
 * because it fails silently and confidently.
 */
const DENY = [
  /^class$|^style$/,
  /^data-v-/, // Vue SFC scoped styles
  /^_ngcontent-|^_nghost-|^ng-version$|^ng-reflect-/, // Angular emulated encapsulation
  /^data-reactid$|^data-react-checksum$|^data-react-helmet$/,
  /^data-radix-|^data-headlessui-|^data-floating-ui-|^data-state$|^data-side$/, // interaction state
  /^data-svelte-h$|^data-astro-|^data-styled|^data-emotion$/, // build hashes
];

/** Value shapes that are regenerated per build or per render. */
const UNSTABLE = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i, // UUID
  /^[0-9a-f]{16,}$/i, // hex hash
  /^:r[0-9a-z]+:$/, // React 18 useId
  /^«r[0-9a-z]+»$/, // React 19 useId
  /^\d{4,}$/, // bare numeric id
  /^(ember|mui|mat|cdk|headlessui|radix|reach)-?\d/i,
  // EXTENSION .2's list, and it closes a real hole. The rule above
  // requires the digit to follow the framework prefix immediately, so it catches
  // `ember1234` and `mui-4821` but NOT `cdk-overlay-0` — which is exactly the
  // shape Angular CDK mints, incrementing per overlay. Anchoring on one is
  // anchoring on "the third dialog opened this session".
  //
  // Deliberately narrow: a known prefix, then hyphenated words, then a trailing
  // number. `matrix-2x2` and `material-icons` still pass, which is the point —
  // over-rejecting costs every useful selector on a page.
  /^(ember|mui|mat|cdk|headlessui|radix|reach)(-?[a-z]+)*-?\d+$/i,
];

export function isAllowedAttr(name: string): boolean {
  // Our own namespace is never a selector hook — except the one attribute we
  // publish for exactly that purpose. `data-snag-src` and `data-snag-component`
  // are dev-build-only, so a selector built on one breaks in production.
  if (name.startsWith(HOST_ATTR_PREFIX) && name !== hostAttr("anchor")) return false;
  // Every aria-* except aria-label is STATE: aria-expanded and aria-selected
  // flip on interaction, so a selector carrying one matches only while the
  // component happens to be in the state it was captured in.
  if (name.startsWith("aria-") && name !== "aria-label") return false;
  if (DENY.some((re) => re.test(name))) return false;
  return STABLE_ATTRS.has(name) || ALSO_ALLOWED.has(name);
}

export function isUnstableAttrValue(name: string, v: string): boolean {
  // 120 aligns .8's own length clause so the two rules cannot
  // disagree about the same string for different reasons. Here it is an
  // INSTABILITY judgement — a 200-character aria-label is prose, and prose in a
  // selector is fragile — while the sensitivity judgement is the alone.
  if (!v || v.length > 120) return true;
  // A query string is where tokens live, and a cross-origin href is not ours to
  // depend on.
  if (name === "href" && (v.includes("?") || /^[a-z]+:\/\//i.test(v))) return true;
  return UNSTABLE.some((re) => re.test(v));
}

/**
 * The two halves, applied together.
 *
 * The sensitivity vocabulary is IMPORTED, never forked — settles it.
 * Draft 2 of 03 hard-coded its own list, which had drifted five ways: its card
 * rule had no Luhn check and its hex threshold was 24 rather than 32, so the
 * fork was silently WEAKER than the owner while presenting itself as the same
 * protection.
 */
export const isUsableAttrValue = (n: string, v: string): boolean =>
  !isUnstableAttrValue(n, v) && !isSensitiveValue(v);

/**
 * Is this `id` worth storing?
 *
 * Framework-generated ids are the trap: React's `:r1:`, Angular's counters,
 * Ember's `ember1234`. They look like perfect anchors and change every build.
 */
export function isStableId(id: string): boolean {
  return isUsableAttrValue("id", id) && /^[a-zA-Z0-9_-]+$/.test(id);
}

/**
 * Backslash-escape and quote, for ATTRIBUTE VALUE positions.
 *
 * "Always emit `[id="…"]`, never `#id`." Framework ids routinely
 * contain `:` and `«»`, which silently produce an INVALID selector under
 * `#`-syntax — invalid, not merely wrong, so it throws at resolve time rather
 * than simply failing to match.
 */
export const cssQuote = (v: string): string => `"${v.replace(/([\\"])/g, "\\$1")}"`;

/**
 * Rewrite finder's `#id` into `[id="id"]` ("Always emit `[id="…"]`,
 * never `#id`").
 *
 * `isStableId` already refuses anything outside `[a-zA-Z0-9_-]`, so the `#`
 * form would be valid for every id we actually store — this is defence in
 * depth, and it is cheap. The failure it guards against is nastier than a
 * mismatch: a framework id containing `:` or `«»` makes `#…` an INVALID
 * selector, so `querySelectorAll` throws at resolve time rather than simply
 * returning nothing, and the whole cascade falls over on one bad record.
 */
export const idAttrForm = (sel: string): string =>
  // Quoted spans are matched FIRST and returned untouched, so a `#` that is
  // part of a value — `[fill="#fff"]` — is not read as an id. Finder cannot
  // produce that today (`fill` is not in the allowlist), but a transform that
  // is only correct for the inputs currently possible is a trap for whoever
  // widens the allowlist next.
  sel.replace(/"[^"]*"|'[^']*'|#([A-Za-z_-][\w-]*)/g, (m, id?: string) =>
    id ? `[id=${cssQuote(id)}]` : m,
  );

/** Finder's output is never trusted: a selector that does not round-trip is discarded. */
function isUnique(sel: string, el: Element, root: ParentNode): boolean {
  try {
    return root.querySelectorAll(sel).length === 1 && root.querySelector(sel) === el;
  } catch {
    return false; // not a valid selector — which is exactly what the design warns about
  }
}

/**
 * Generate a CSS selector, in two passes.
 *
 * Finder minimises a penalty over candidates but cannot express "prefer
 * data-testid". The preference is recovered by running it twice: pass A sees
 * ONLY the stable hooks and may fail; pass B adds surviving classes and
 * structure. A cheap approximation of a whitelist, at a fraction of the bytes.
 *
 * `timeoutMs` is why this library was chosen over `css-selector-generator`: it
 * is a WALL-CLOCK bound, and candidate counts do not bound time on a
 * pathological DOM. This runs inside the click that opens the composer.
 */
export function generateCss(el: Element, root: Element = document.body): string | undefined {
  const base = {
    root,
    tagName: () => true,
    idName: isStableId,
    seedMinLength: 2,
    optimizedMinLength: 2,
  };
  try {
    const a = finder(el, {
      ...base,
      timeoutMs: 150,
      className: () => false,
      attr: (n: string, v: string) => STABLE_ATTRS.has(n) && isUsableAttrValue(n, v),
    });
    const q = idAttrForm(a);
    if (isUnique(q, el, root)) return q;
  } catch {
    /* no stable-hook selector exists — fall through to structure */
  }
  try {
    const b = finder(el, {
      ...base,
      timeoutMs: 300,
      className: isStableClassName,
      attr: (n: string, v: string) => isAllowedAttr(n) && isUsableAttrValue(n, v),
    });
    const q = idAttrForm(b);
    return isUnique(q, el, root) ? q : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A class worth putting in a selector.
 *
 * Utility frameworks (`px-4`, `md:flex`) and CSS-module hashes (`Button_a1b2c3`)
 * are the two shapes that churn hardest, and a selector built on either lasts
 * exactly until somebody adjusts the padding.
 */
function isStableClassName(name: string): boolean {
  if (!name || name.length > 60) return false;
  if (/^[a-z-]*\d/.test(name)) return false; // px-4, mt-2, grid-cols-3
  if (/[:[\]/]/.test(name)) return false; // md:flex, w-[32px]
  if (/_[A-Za-z0-9]{5,}$/.test(name)) return false; // CSS-module hash suffix
  if (/^[a-z]+-[0-9a-f]{6,}$/i.test(name)) return false; // emotion/styled hashes
  return true;
}

/**
 * Everything about an element that only the generator knows.
 *
 * One injection point rather than three: the runtime asks for this once at
 * creation and hands the result to `createElementAnchor`, so the whole
 * selector policy has a single home and the eager chunk imports none of it.
 */
/**
 * Absolute positional XPath, DIAGNOSTIC ONLY (v0.1).
 *
 * Stored because declares the field, the W3C-shaped export maps it to
 * an XPathSelector, and the MCP server hands it to an agent as a locator
 * hint. It is deliberately absent from the resolution cascade: an absolute
 * XPath is strictly dominated by `css`, and its failure mode is worse — it
 * silently returns a DIFFERENT element rather than nothing.
 *
 * Positional predicates only, never attribute predicates, so the guard
 * has nothing to test: `[2]` when same-tag siblings exist, bare tag when the
 * element is the only one. Scoped to the nearest root — inside a shadow root
 * the path is root-relative, which the `hostPath` beside it makes explicit.
 */
export function xpathOf(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < 40; depth++) {
    const tag = node.tagName.toLowerCase();
    let index = 1;
    let hasSameTagSibling = false;
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.tagName === node.tagName) index++;
    }
    for (let sib = node.nextElementSibling; !hasSameTagSibling && sib; sib = sib.nextElementSibling) {
      if (sib.tagName === node.tagName) hasSameTagSibling = true;
    }
    parts.unshift(index > 1 || hasSameTagSibling ? `${tag}[${index}]` : tag);
    node = node.parentElement;
  }
  return `/${parts.join("/")}`;
}

export function describeElement(target: Element): {
  css?: string;
  domid?: string;
  hostPath?: string[];
  xpath?: string;
} {
  // The walk-out, applied HERE rather than at the call site, because a
  // selector generated for a node inside a shadow root is rooted at
  // `document.body` and therefore addresses nothing at all — a pin that
  // orphans on the very next load. Same reason `createElementAnchor` does it:
  // both take "what the reviewer pointed at" and neither makes the caller
  // remember which side of the boundary that was on.
  const el = anchorTargetOf(target);
  const out: { css?: string; domid?: string; hostPath?: string[]; xpath?: string } = {};

  /**
   * The `hostPath`, recorded (v0) rather than resolved through (v0.1).
   *
   * Its presence is the ONLY thing that lets `resolve` report row F4's
   * `shadow-boundary` — without it a pin inside a web component came back as
   * plain `anchored`, with no signal that the mark sits on the component rather
   * than on the control the reviewer pointed at.
   *
   * Selectors are generated per host against the DOCUMENT, which is correct for
   * the outermost one and best-effort for the rest; a nested host's selector is
   * only meaningful once the v0.1 resolution walks it, and generating it now
   * is what makes that walk possible without a migration.
   */
  const hosts = shadowHosts(target);
  if (hosts.length) {
    const path = hosts.map((h) => generateCss(h)).filter((c): c is string => !!c);
    if (path.length) out.hostPath = path;
  }
  const css = generateCss(el);
  if (css) out.css = css;
  // "element.id, IF it passes isStableId(). Omit otherwise." The
  // record used to take `el.id` unfiltered, so a React app's `:r1:` was stored
  // as though it were an anchor.
  if (el.id && isStableId(el.id)) out.domid = el.id;
  try {
    out.xpath = xpathOf(el);
  } catch {
    /* a record with no xpath is valid — the field is diagnostic */
  }
  return out;
}
