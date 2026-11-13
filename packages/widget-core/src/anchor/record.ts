import { hostAttr } from "@snagset/types/names";
import { format } from "../strings/en.ts";
import { rectOf } from "./geometry.ts";
import { anchorTargetOf } from "./shadow.ts";
import { normalizeText } from "./similarity.ts";
import type { AnchorRecord } from "./types.ts";

/**
 * Creating the durable record of what a pin points at.
 *
 * The whole design bet: record MANY INDEPENDENT FACETS, so a rebuild that
 * destroys some still leaves others. A single-selector anchor is a coin toss
 * against any real release; this is what the spike measures.
 */

/** Hook attributes in priority order. Ours first, then the common ones. */
const HOOK_ATTRS = [
  hostAttr("anchor"),
  "data-testid",
  "data-test-id",
  "data-test",
  "data-cy",
  "data-qa",
  "data-pw",
  "data-automation-id",
] as const;

const MAX_TEXT = 256;
/** An ELEMENT anchor's text facet caps at 200 (the reduced
 *  accessible name above keeps its own 256; the two caps are different specs'). */
const MAX_ELEMENT_QUOTE = 200;
const MAX_PATH = 12;

export function firstHook(el: Element): { attr: string; value: string } | undefined {
  for (const attr of HOOK_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) return { attr, value };
  }
  return undefined;
}

/** Tag-name path root-last, with a positional suffix only where it disambiguates. */
export function pathOf(el: Element, max = MAX_PATH): string[] {
  const out: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && out.length < max) {
    const tag = node.tagName.toLowerCase();
    if (tag === "html") break;
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((c) => c.tagName === node!.tagName);
      out.push(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag);
    } else {
      out.push(tag);
    }
    node = parent;
  }
  return out.reverse();
}

/** ARIA role: explicit wins, else a small implicit map (the common interactives). */
export function roleOf(el: Element): string | undefined {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "input") {
    const t = (el.getAttribute("type") ?? "text").toLowerCase();
    if (t === "checkbox" || t === "radio" || t === "button" || t === "submit") return t === "submit" ? "button" : t;
    return "textbox";
  }
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "nav") return "navigation";
  if (tag === "img") return "img";
  return undefined;
}

/**
 * Accessible name, in specification order for the cases that matter here:
 * aria-label → aria-labelledby → alt/title → trimmed text content.
 */
export function accessibleNameOf(el: Element): string | undefined {
  const label = el.getAttribute("aria-label");
  if (label?.trim()) return label.trim();

  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const names = by
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (names) return names;
  }
  const alt = el.getAttribute("alt") ?? el.getAttribute("title");
  if (alt?.trim()) return alt.trim();

  const text = (el.textContent ?? "").trim();
  return text ? text.slice(0, MAX_TEXT) : undefined;
}

/**
 * A label from the TAG ALONE — no text is read.
 *
 * The real derivation is `deriveAnchorLabel` in src/capture/, which quotes the
 * element's text and therefore needs `isSensitiveValue` and the masking gate in
 * front of it. Those live in the panels chunk, because anchor CREATION only
 * ever happens with the composer open, and this file is in the eager runtime
 * where anchor RESOLUTION lives.
 *
 * So creation injects the good label through `opts.label`, exactly as it already
 * injects `css`, and this is the floor for a caller that supplies none. It reads
 * no text, so it cannot leak any — which is the only reason it is safe to have
 * a fallback here at all.
 */
function tagLabel(el: Element): string {
  const tag = el.tagName.toLowerCase();
  return tag === "img"
    ? format("label.image")
    : tag === "a"
      ? format("label.link")
      : tag === "button"
        ? format("label.button")
        : format("label.tag", { tag });
}

export interface CreateAnchorOptions {
  /** Click point in viewport coordinates, for the fractional offset. */
  point?: { x: number; y: number };
  /** Viewport width, for the breakpoint bucket. */
  viewportWidth?: number;
  /** What was pinned, in words. Injected rather than derived here: the
   *  derivation reads element TEXT and so needs the redaction gate, which
   *  ships with the panels chunk. Absent, the tag alone is used. */
  label?: string;
  /** The element's `id`, ALREADY filtered by `isStableId`.
   *  Injected rather than read here for the same reason `css` is: the filter is
   *  a value-shape judgement that shares its vocabulary with the redaction
   *  predicate, and that lives in the capture chunk. */
  domid?: string;
  /** Generated CSS selector; injected so the generator stays swappable. */
  css?: string;
  /** The shadow provenance, generated by the same injected describer. */
  hostPath?: string[];
  /** The diagnostic XPath, injected like `css` and never resolved against. */
  xpath?: string;
}

/**
 * The NORMATIVE five-bucket table — the previous four-bucket version
 * here (sm < 640) was a drift both creation and resolution shared, so it
 * never disagreed with itself and nothing failed. One function, imported by
 * the extension chunk, because two copies of a boundary table is how a pin
 * captured at 700 px gets judged against a different ruler than made it.
 */
export function breakpointBucket(width: number): string {
  if (width < 480) return "xs";
  if (width < 768) return "sm";
  if (width < 1024) return "md";
  if (width < 1440) return "lg";
  return "xl";
}

export function createElementAnchor(target: Element, opts: CreateAnchorOptions = {}): AnchorRecord {
  /**
   * V0: *"walk `getRootNode().host` upward until the node's root is
   * `document`, anchor to the resulting host element"*.
   *
   * The hit test now descends into the host page's open shadow roots, so
   * this function started receiving nodes that no document-rooted selector can
   * reach. Every facet below — `path`, `rect`, `text`, `role` — has to describe
   * the element a later `querySelector` can actually find, and that is the
   * host. `opts.label` is the deliberate exception: the caller derives it from
   * the INNER element, because what the reviewer pointed at is what the comment
   * is about, and saying so costs nothing and explains the pin's position.
   */
  const el = anchorTargetOf(target);
  const hook = firstHook(el);
  const rect = rectOf(el);
  const doc = el.ownerDocument;
  const scrollX = doc.defaultView?.scrollX ?? 0;
  const scrollY = doc.defaultView?.scrollY ?? 0;
  const text = normalizeText(el.textContent ?? "").slice(0, MAX_ELEMENT_QUOTE);

  const rec: AnchorRecord = {
    path: pathOf(el),
    // Document-relative, NOT viewport-relative: a pin must survive a scroll.
    rect: { x: rect.left + scrollX, y: rect.top + scrollY, w: rect.width, h: rect.height },
    label: opts.label ?? tagLabel(el),
  };

  if (hook) rec.testid = hook.value;
  // "element.id, IF it passes isStableId(). Omit otherwise."
  // Taken raw, a React `:r1:` or an Ember counter was stored as though it were
  // a durable anchor — and `#:r1:` is not even a valid selector.
  if (opts.domid) rec.domid = opts.domid;
  if (opts.css) rec.css = opts.css;
  if (opts.hostPath?.length) rec.hostPath = opts.hostPath;
  if (opts.xpath) rec.xpath = opts.xpath;

  const role = roleOf(el);
  if (role) rec.role = role;
  const name = accessibleNameOf(el);
  if (name) rec.accessibleName = name;
  if (text) rec.text = { exact: text };

  if (opts.point && rect.width > 0 && rect.height > 0) {
    rec.offset = {
      fx: clamp01((opts.point.x - rect.left) / rect.width),
      fy: clamp01((opts.point.y - rect.top) / rect.height),
    };
  }
  const vw = opts.viewportWidth ?? doc.defaultView?.innerWidth;
  if (vw) rec.breakpoint = breakpointBucket(vw);

  return rec;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
