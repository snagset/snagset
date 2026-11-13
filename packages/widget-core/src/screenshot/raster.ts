import { spotLines } from "./spots.ts";

/**
 * The zero-dependency `foreignObject` rasteriser, verbatim
 * ~40 lines of strategy; everything else is the fidelity work the
 * libraries exist to sell, bought here one disclosed blind spot at a time.
 * Snapdom is out, no third-party engine exists to pin, and
 * verify-dist asserts no node_modules module resolves into this chunk.
 */

/**
 * The fixed property list — what is not in it is not in the picture.
 * `width`/`height` are here ON PURPOSE: pinning the computed box on every
 * node is what prevents reflow inside the foreignObject, where no page
 * stylesheet is in scope.
 */
const SNAP_PROPS = [
  "display", "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "order", "gap",
  "align-items", "align-content", "align-self", "justify-content", "justify-items", "justify-self",
  "grid-template-columns", "grid-template-rows", "grid-column", "grid-row",
  "box-sizing", "width", "height", "margin", "padding", "border", "border-radius",
  "position", "top", "right", "bottom", "left", "z-index", "isolation", "transform", "transform-origin",
  "object-fit", "object-position", "vertical-align", "text-transform",
  "background-color", "background", "color",
  "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
  "text-decoration", "text-align", "white-space", "text-wrap",
  "overflow", "opacity", "box-shadow", "max-width", "list-style",
] as const;

/**
 * The cap, now a backstop: the sweep styles only what the crop
 * can show (see rasterise), so an ordinary page stays far below it. It was
 * 200 — fine for the prototype's element-scope fixture, ruinous for a real
 * page, where it ran out before the first section.
 */
const NODE_CAP = 6000;

export interface RasterOptions {
  /** REMOVED from the clone — layout not preserved. The verb for our own
   *  UI (position:absolute, nothing to preserve) and step 3's removals. */
  drop?: (el: Element) => boolean;
  /** `visibility:hidden` in the inlined style — layout preserved. The
   *  verb for sticky/fixed (removal shifts every later y) and stage 1. */
  hide?: (el: Element) => boolean;
  /** Blind spot 1's required mitigation: same-origin images inlined
   *  as data: URIs; cross-origin ones become placeholders. */
  inlineSameOriginAssets?: boolean;
  /**
   * A cross-origin image the browser will not let us read, fetched another
   * way — the server's image proxy. Tried only after a plain CORS fetch
   * failed; null means the placeholder stays. Absent → placeholder at once.
   */
  fetchForeignImage?: (url: string) => Promise<Blob | null>;
}

export interface RasterResult {
  /**
   * The loaded SVG image — the crop source. The CALLER draws exactly one
   * canvas (the viewport-sized crop) from this and then clears `img.src`:
   * a full-document intermediate canvas is the 38 MP / 154 MB iOS failure
   * the spec names, and returning the image instead of a canvas is what
   * makes allocating one impossible from this side.
   */
  image: HTMLImageElement;
  /** CSS-pixel size of the rasterised box. */
  width: number;
  height: number;
  /** Rows detected during the style sweep (shadow roots, failed inlines). */
  blindSpots: string[];
}

/** Same-origin test that treats parse failures as foreign — the safe side. */
function sameOrigin(url: string, doc: Document): boolean {
  try {
    return new URL(url, doc.baseURI).origin === doc.location.origin;
  } catch {
    return false;
  }
}

function toDataUri(blob: Blob): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

/** Inline one same-origin image as a data: URI via fetch; null on any miss. */
async function inlineImage(src: string, doc: Document): Promise<string | null> {
  try {
    const res = await fetch(new URL(src, doc.baseURI).href, { credentials: "same-origin" });
    if (!res.ok) return null;
    return await toDataUri(await res.blob());
  } catch {
    return null;
  }
}

/**
 * A cross-origin image, in two tries. First a plain CORS fetch: plenty of
 * CDNs DO send `Access-Control-Allow-Origin`, and until this every foreign
 * image went grey without even asking. Then the server's proxy, for the hosts
 * that do not (Acme's). Credentials omitted on the first try: an image a
 * reviewer sees only because of their own cookies is not ours to copy.
 */
async function inlineForeign(
  src: string,
  doc: Document,
  viaServer?: (url: string) => Promise<Blob | null>,
): Promise<string | null> {
  const url = new URL(src, doc.baseURI).href;
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (res.ok) return await toDataUri(await res.blob());
  } catch {
    // Refused (no CORS headers) or unreachable — the second try is for exactly this.
  }
  if (!viaServer) return null;
  const blob = await viaServer(url).catch(() => null);
  return blob ? await toDataUri(blob) : null;
}

/** http(s) only — a data: or blob: image is already readable, and a malformed src is not worth a fetch. */
function isWebUrl(url: string, doc: Document): boolean {
  try {
    return /^https?:$/.test(new URL(url, doc.baseURI).protocol);
  } catch {
    return false;
  }
}

/** A 1×1 grey data: URI, generated — the placeholder for what we may not read. */
const GREY_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAALu7uwAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";

/** A 1×1 transparent GIF — for images outside the picture, which need no placeholder. */
const CLEAR_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export async function rasterise(el: Element, opts: RasterOptions): Promise<RasterResult> {
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;
  const r = el.getBoundingClientRect();
  // The guards. Too small is nothing to; too large is the
  // raster budget in miniature — both are REPORTED by the caller, not silent.
  if (r.width < 4 || r.height < 4) throw new Error("raster:too-small");

  const clone = el.cloneNode(true) as Element;

  // The style sweep. Source and clone walked in LOCKSTEP — the same
  // querySelectorAll("*") order on a just-cloned tree — with drop/hide
  // applied on the CLONE side only (A3: the host DOM is never touched).
  //
  // NOTHING may be removed from the clone before these two lists exist.
  // The first build removed script/iframe/video/canvas here, one line up —
  // and every real page has a <script> in <head> (an analytics tag, a
  // framework loader, Playwright's own addInitScript), so every pair after
  // it was shifted by one: <body> received the <style> element's computed
  // style, display:none included, and every viewport capture was a white
  // rectangle. The masks, hatches and overlays still painted, so it LOOKED
  // like a screenshot pipeline — only a pixel-spread assertion caught it.
  let shadowRoots = 0;
  let corsImages = 0;
  let failedImages = 0;
  const inlineJobs: Promise<void>[] = [];
  const dropped: Element[] = [];

  // Media gets its OWN lockstep pass over the whole tree, not
  // the style sweep's first 200 nodes. A viewport capture rasterises
  // <html>, and a Next.js page spends most of those 200 on <head> alone —
  // so on a real site (Acme's) the hero and every card image sat past the
  // cap, kept their CDN URL, and painted nothing inside the SVG. The style
  // sweep can afford a cap because the cloned <style> tags still style what
  // it skips; nothing else inlines an image.
  //
  // Only what is on screen is fetched: both scopes crop inside the viewport,
  // so an image below the fold is work nobody will see. It is blanked, not
  // counted — it is outside the picture, not missing from it.
  const viewW = win.innerWidth;
  const viewH = win.innerHeight;
  const onScreen = (n: Element): boolean => {
    const b = n.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && b.right > 0 && b.bottom > 0 && b.left < viewW && b.top < viewH;
  };
  /**
   * The box an element occupied, as inline style: what a stand-in needs so
   * nothing after it moves. Removing an iframe outright (the old way) slid
   * every sibling into its slot — under the hatch drawn at the LIVE rect.
   */
  const boxOf = (n: Element): string => {
    const cs = win.getComputedStyle(n);
    const b = n.getBoundingClientRect();
    const display = cs.display === "inline" ? "inline-block" : cs.display;
    return (
      `display:${display};box-sizing:border-box;width:${b.width}px;height:${b.height}px;` +
      `margin:${cs.margin};border:${cs.border};padding:${cs.padding};vertical-align:${cs.verticalAlign}`
    );
  };
  const MEDIA = "img, canvas, iframe, video";
  const mediaSrc = [...el.querySelectorAll(MEDIA)];
  const mediaDst = [...clone.querySelectorAll(MEDIA)];
  for (let i = 0; i < Math.min(mediaSrc.length, mediaDst.length); i++) {
    const src = mediaSrc[i]!;
    const dst = mediaDst[i]!;
    if (opts.drop?.(src)) continue;
    if (src.tagName !== "IMG") {
      // Still holds — nothing of an iframe or video is loaded
      // or faked — but the slot it held is kept, empty, at its size. A
      // readable canvas is pixels we already have, drawn in as an <img>;
      // tainted and WebGL-cleared ones are hatched and named by capture.ts.
      let data = "";
      if (src.tagName === "CANVAS" && opts.inlineSameOriginAssets && onScreen(src)) {
        try {
          data = (src as HTMLCanvasElement).toDataURL();
        } catch {
          /* tainted — stays an empty slot */
        }
      }
      const stand = doc.createElement(data ? "img" : "span");
      if (data) stand.setAttribute("src", data);
      // The class keeps whatever positions it (the cloned stylesheets still apply).
      const cls = src.getAttribute("class");
      if (cls) stand.setAttribute("class", cls);
      stand.setAttribute("style", boxOf(src));
      dst.replaceWith(stand);
      continue;
    }
    const img = dst as HTMLImageElement;
    // srcset WINS over src — inside the SVG as much as on the page. Left on
    // the clone, every responsive image (next/image, Sanity, WordPress)
    // ignores the data: URI below and asks for a URL the SVG may not load.
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.removeAttribute("loading");
    const srcUrl = (src as HTMLImageElement).currentSrc || src.getAttribute("src") || "";
    if (!srcUrl) continue;
    if (!onScreen(src)) {
      img.setAttribute("src", CLEAR_PIXEL);
    } else if (opts.inlineSameOriginAssets && sameOrigin(srcUrl, doc)) {
      inlineJobs.push(
        inlineImage(srcUrl, doc).then((data) => {
          if (data) img.setAttribute("src", data);
          else {
            img.setAttribute("src", GREY_PIXEL);
            failedImages++;
          }
        }),
      );
    } else if (opts.inlineSameOriginAssets && isWebUrl(srcUrl, doc)) {
      // Cross-origin: placeholder first, so a slow fetch never leaves the
      // original URL in the clone (the SVG image would not load it anyway).
      img.setAttribute("src", GREY_PIXEL);
      inlineJobs.push(
        inlineForeign(srcUrl, doc, opts.fetchForeignImage).then((data) => {
          if (data) img.setAttribute("src", data);
          else corsImages++;
        }),
      );
    } else if (!srcUrl.startsWith("data:")) {
      img.setAttribute("src", GREY_PIXEL);
      if (!sameOrigin(srcUrl, doc)) corsImages++;
    }
  }
  // <picture>'s <source> outranks the <img> it wraps, same as srcset.
  for (const n of clone.querySelectorAll("picture > source")) n.remove();

  /**
   * The style sweep: source and clone walked in LOCKSTEP, child by child —
   * the clone was just made, so the i-th child on one side IS the i-th on
   * the other — with drop/hide applied on the CLONE side only (A3: the host
   * DOM is never touched).
   *
   * Pairing is by tree position, never by two flattened lists: the first
   * build removed <script>s before pairing two querySelectorAll("*") lists,
   * every pair after the first script shifted by one, <body> received a
   * <style> element's display:none, and every capture was a white rectangle.
   *
   * WHAT IS SWEPT: everything the crop can show. The inline style IS the
   * styling here — a page's <link rel=stylesheet> never loads inside an SVG
   * image, so an element the sweep skips renders as bare HTML. The old
   * 200-node cap therefore broke every real page: on Acme's (Next.js), the
   * first 200 nodes ran out inside the header; below it the page collapsed,
   * so a scrolled viewport capture came out white. Both scopes crop inside
   * the viewport, so an element wholly outside it keeps only its BOX —
   * styled, emptied — and everything after it lands where it was. The cap
   * survives as a backstop against a pathological page.
   */
  const viewMargin = 64;
  const offScreen = (b: DOMRect): boolean =>
    b.bottom < -viewMargin || b.top > viewH + viewMargin || b.right < -viewMargin || b.left > viewW + viewMargin;
  const NEVER = /^(?:SCRIPT|NOSCRIPT)$/;
  const STOOD_IN = /^(?:IFRAME|VIDEO|CANVAS)$/; // the media pass already replaced these
  let swept = 0;
  const stack: [Element, Element][] = [[el, clone]];
  while (stack.length > 0 && swept < NODE_CAP) {
    const [src, dst] = stack.pop()!;
    if (NEVER.test(src.tagName) || opts.drop?.(src)) {
      dropped.push(dst);
      continue;
    }
    if (STOOD_IN.test(src.tagName)) continue;
    swept++;
    const cs = win.getComputedStyle(src);
    // setAttribute + XMLSerializer, NEVER hand-concatenated into the XML:
    // computed font-family carries double quotes, and hand-built markup
    // turns them into a malformed document and a blank screenshot (
    // detail 1 — the single most likely re-implementation break).
    let style = SNAP_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";");
    if (opts.hide?.(src)) style += ";visibility:hidden";
    dst.setAttribute("style", style);

    /**
     * Shadow-root detection rides the sweep: the subtree cannot be
     * serialised, so the box hatches rather than reading as a rendering bug.
     *
     * ONLY IF IT COULD HAVE SHOWN SOMETHING. The disclosure exists to tell
     * a reviewer what the picture missed, and an element that renders no
     * pixels missed nothing. The overlay scanner next door already applies
     * exactly this rule (`rect.width < 1 || rect.height < 1` → skip); the
     * shadow-root count did not, and the difference showed up the first time
     * a real Next.js page was reviewed: every screenshot reported "2 web
     * components could not be captured", and both were `nextjs-portal` and
     * `next-route-announcer` at 0×0 — framework internals with no content,
     * on every page, forever.
     *
     * That is the failure mode a disclosure cannot afford. A notice that
     * always says three things nobody can act on is a notice people stop
     * reading, and then the one time it says "your payment form was not
     * captured" it goes past unread.
     *
     * The rect is only measured for elements that HAVE a shadow root, which
     * is rare, so the layout read costs nothing on an ordinary page.
     */
    if (src.shadowRoot) {
      const box = src.getBoundingClientRect();
      const paints = box.width >= 1 && box.height >= 1 && cs.visibility !== "hidden";
      if (paints) {
        shadowRoots++;
        dst.setAttribute("style", style + ";background:repeating-linear-gradient(45deg,#eee,#eee 6px,#ddd 6px,#ddd 12px)");
      }
    }

    // display:none paints nothing below it; its children stay as they are
    // (a hidden <head> keeps the <style>s that still apply).
    if (cs.display === "none") continue;
    if (src !== el && cs.position !== "fixed" && offScreen(src.getBoundingClientRect())) {
      // Off the picture: the box stays, its contents go. Inline <style>s
      // are kept — they style the whole document, not just this box.
      const keep = [...dst.querySelectorAll("style")];
      dst.replaceChildren(...keep);
      continue;
    }
    const sk = src.children;
    const dk = dst.children;
    // Pushed in reverse so they pop in document order.
    for (let i = Math.min(sk.length, dk.length) - 1; i >= 0; i--) stack.push([sk[i]!, dk[i]!]);
  }
  for (const d of dropped) d.remove();
  // Beyond the backstop the sweep never looked — strip the never-ship tags
  // from the whole clone now that the lockstep pairing is over.
  for (const n of clone.querySelectorAll("script, iframe, video, canvas, noscript")) n.remove();
  await Promise.all(inlineJobs);
  // COUNTED, then worded once per kind (spots.ts) — never one line per image.
  const blindSpots = spotLines({ corsImages, failedImages, shadowRoots });

  // The XHTML-namespaced wrapper is REQUIRED — without it
  // nothing renders — and serialisation failure surfaces as img.onerror.
  const xml =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(r.width)}" height="${Math.ceil(r.height)}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml">` +
    new XMLSerializer().serializeToString(clone) +
    `</div></foreignObject></svg>`;

  const img = new win.Image();
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("raster:img-error"));
  });
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  await loaded;

  return { image: img, width: r.width, height: r.height, blindSpots };
}

/**
 * The pre-flight: one 1×1 SVG data: image, once per session. A CSP
 * without `data:` in img-src kills the whole technique in one microtask —
 * probed here so the failure is a sentence, never a hang.
 */
let dataProbe: Promise<boolean> | null = null;
export function probeDataImages(doc: Document): Promise<boolean> {
  if (dataProbe) return dataProbe;
  dataProbe = new Promise((resolve) => {
    const img = new (doc.defaultView ?? window).Image();
    const timer = setTimeout(() => resolve(false), 1000);
    img.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    img.src =
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  });
  return dataProbe;
}

export { SNAP_PROPS, NODE_CAP };
