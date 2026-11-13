import { hostAttr, cssClass, widgetAttr } from "@snagset/types/names";
import { probeDataImages, rasterise } from "./raster.ts";
import { encodeToBudget, MAX_LONGEST_SIDE } from "./encode.ts";
import { spotLines, type SpotCounts } from "./spots.ts";
import type { ScreenshotSituation } from "../capture/report.ts";

/**
 * The capture orchestrator: scope and crop, overlay
 * suppress-and-composite, two-stage masking that fails CLOSED, blind spots
 * named never silent, and the degradation ladder that degrades by option and
 * scope reduction — never by engine swap.
 */

export interface CaptureOptions {
  doc: Document;
  /** The pinned element — element scope's centre, from the hitTest. */
  target?: Element | null;
  scope?: "viewport" | "element";
  maxDpr?: number;
  maxLongestSide?: number;
  maxRasterPixels?: number;
  maxOverlays?: number;
  timeoutMs?: number;
  /** The server's image proxy, for cross-origin images CORS refuses (RasterOptions). */
  fetchForeignImage?: (url: string) => Promise<Blob | null>;
  /** ADDED to the built-ins, never replaces. */
  maskSelectors?: readonly string[];
  maskAllInputs?: boolean;
  /** Fed by pagehide / the runtime's onNav — mid-capture navigation discards. */
  signal?: AbortSignal;
}

export interface CaptureOutcome {
  situation: ScreenshotSituation;
  blob?: Blob;
  quality?: number;
  width?: number;
  height?: number;
  blindSpots: string[];
  maskedCount: number;
}

/** The selector table — built-ins ALWAYS apply; config only adds. */
function maskSelectorList(opts: CaptureOptions): string[] {
  const base = [
    `[${hostAttr("mask")}]`,
    `.${cssClass("mask")}`,
    `.${cssClass("block")}`,
    'input[type="password"]',
    'input[autocomplete*="password" i]',
    '[autocomplete*="cc-" i]',
    '[autocomplete="one-time-code"]',
    'input[type="email"]',
    'input[type="tel"]',
  ];
  if (opts.maskAllInputs) base.push("input", "textarea", "select", "[contenteditable]");
  return [...base, ...(opts.maskSelectors ?? [])];
}

interface Overlay {
  el: Element;
  rect: DOMRect;
  modal: boolean;
}

/**
 * The collector, on the LIVE dom: top-layer members and fixed/sticky
 * elements, deduped to the outermost, capped, 8 ms budget — overrun skips
 * compositing entirely and the base raster still ships.
 */
function collectOverlays(doc: Document, cap: number): { overlays: Overlay[]; notes: string[] } {
  const win = doc.defaultView ?? window;
  const t0 = performance.now();
  const notes: string[] = [];
  const found: Overlay[] = [];
  const ours = `[${widgetAttr("root")}]`;

  const all = doc.querySelectorAll("body *");
  const sampled = all.length > 5000;
  const candidates = sampled
    ? doc.querySelectorAll(
        "body > *, [class*=fixed], [class*=sticky], header, nav, dialog, [popover], [role=dialog], [role=tooltip], [role=menu]",
      )
    : all;
  if (sampled) notes.push("Overlay scan was reduced on this very large page; some fixed elements may be missing.");

  for (const el of candidates) {
    if (performance.now() - t0 > 8) {
      notes.push("Overlay scan ran out of time; fixed and sticky elements are not composited.");
      return { overlays: [], notes };
    }
    if (el.closest(ours)) continue;
    let qualifies = false;
    let modal = false;
    try {
      if (el.matches(":popover-open")) qualifies = true;
    } catch {
      /* engine without the pseudo-class */
    }
    if (el instanceof win.HTMLDialogElement && el.open) {
      qualifies = true;
      try {
        modal = el.matches(":modal");
      } catch {
        modal = false;
      }
    }
    if (!qualifies) {
      const pos = win.getComputedStyle(el).position;
      if (pos === "fixed" || pos === "sticky") qualifies = true;
    }
    if (!qualifies) continue;
    const inView = (r: DOMRect): boolean =>
      r.width >= 1 && r.height >= 1 && r.bottom >= 0 && r.right >= 0 && r.top <= win.innerHeight && r.left <= win.innerWidth;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      // A zero-height sticky <header> whose bar overflows it (Acme's): the
      // wrapper paints nothing, its children are the overlay. Left out, the
      // bar rendered at its place in the document — off the crop once the
      // page was scrolled, so the header was simply missing.
      for (const child of el.children) {
        const cr = child.getBoundingClientRect();
        if (inView(cr)) found.push({ el: child, rect: cr, modal });
      }
      continue;
    }
    if (!inView(rect)) continue;
    found.push({ el, rect, modal });
  }

  // Outermost only: a sticky inside a fixed header is the header's pixels.
  const outer = found.filter((o) => !found.some((p) => p !== o && p.el.contains(o.el)));
  // Pluralised, because this is the line a reviewer sees most often and "1
  // overlay elements were re-composited" reads as a bug in the tool. The
  // shadow-root note next door got this right; this one did not, and it only
  // became visible once the zero-size shadow roots stopped drowning it out.
  const many = (n: number, one: string, other: string): string => (n === 1 ? one : other);
  if (outer.length > cap) {
    const n = outer.length - cap;
    notes.push(
      `${n} overlay ${many(n, "element", "elements")} (fixed/sticky/menus) ${many(n, "was", "were")} not captured`,
    );
  }
  if (outer.length > 0) {
    const n = Math.min(outer.length, cap);
    notes.push(
      `${n} overlay ${many(n, "element", "elements")} ${many(n, "was", "were")} re-composited; ` +
        `${many(n, "its", "their")} stacking order is approximate`,
    );
  }
  return { overlays: outer.slice(0, cap), notes };
}

/**
 * One cheap look at a canvas: a 16×16 thumbnail, read back. Reading a tainted
 * canvas's pixels throws SecurityError, so the same call answers "readable?"
 * and "anything drawn?". It replaced a `toDataURL()` per canvas — a full PNG
 * encode just to learn whether one would be allowed — which on CI's WebKit
 * spent the scan's whole 5 ms budget on a single canvas.
 */
/** Canvases looked at before the time budget may skip one (see the scan). */
const PROBE_FREE = 32;

function probeCanvas(c: HTMLCanvasElement, doc: Document): "tainted" | "blank" | "pixels" {
  if (c.width === 0 || c.height === 0) return "blank";
  try {
    const probe = doc.createElement("canvas");
    probe.width = probe.height = 16;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "blank";
    ctx.drawImage(c, 0, 0, 16, 16);
    const px = ctx.getImageData(0, 0, 16, 16).data;
    for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) return "pixels";
    return "blank";
  } catch (e) {
    return (e as { name?: string }).name === "SecurityError" ? "tainted" : "blank";
  }
}

/** The pre-scan — 5 ms budget, hosts only, never a path or query. */
function scanBlindSpots(
  doc: Document,
  notes: string[],
  paintsCanvases: boolean,
): { el: Element; rect: DOMRect; label: string }[] {
  // Any layout the page still owes is flushed BEFORE the clock starts: the
  // first rect read below would pay it, and on a slow engine that alone spent
  // the 5 ms meant for the scan's own work. The capture needs that layout
  // anyway — this only moves who is billed for it.
  void doc.documentElement.getBoundingClientRect();
  const t0 = performance.now();
  const hatched: { el: Element; rect: DOMRect; label: string }[] = [];
  const media = doc.querySelectorAll("iframe, canvas, video");
  if (media.length > 5000) {
    notes.push("Blind-spot scan skipped on this very large page.");
    return hatched;
  }
  // Counted per kind and worded ONCE at the end (spots.ts): a page with four
  // embeds used to say "1 cross-origin iframe not captured" four times.
  const seen: Required<Pick<SpotCounts, "iframeHosts" | "taintedCanvases" | "blankCanvases" | "videos">> = {
    iframeHosts: [],
    taintedCanvases: 0,
    blankCanvases: 0,
    videos: 0,
  };
  let probed = 0;
  for (const el of media) {
    /**
     * Past the 5 ms budget the scan does not STOP — it stops PROBING. A break
     * here meant a slow device (CI's WebKit, twice) spent the budget reading
     * one canvas's pixels and never reached the next, which then went
     * unnamed: the one outcome exists to prevent. Late, a canvas is
     * named without the readback, on the safe side.
     *
     * And the first PROBE_FREE canvases are always looked at, whatever the
     * clock says: each look is a 16×16 readback, and a budget measured in
     * time made the answer depend on the machine — CI's WebKit, slow that
     * day, named a canvas with a drawing on it as "may appear blank".
     */
    const late = probed >= PROBE_FREE && performance.now() - t0 > 5;
    if (el.closest(`[${widgetAttr("root")}]`)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (el.tagName === "IFRAME") {
      const f = el as HTMLIFrameElement;
      let crossOrigin = false;
      try {
        if (!f.contentDocument) crossOrigin = true;
      } catch {
        crossOrigin = true;
      }
      if (crossOrigin) {
        let host = "";
        try {
          host = new URL(f.src, doc.baseURI).host;
        } catch {
          /* srcdoc or about: — host stays empty */
        }
        seen.iframeHosts.push(host);
        hatched.push({ el, rect, label: "iframe not captured" });
      }
    } else if (el.tagName === "CANVAS") {
      if (late) {
        seen.blankCanvases++;
        hatched.push({ el, rect, label: "canvas not captured" });
        continue;
      }
      probed++;
      const look = probeCanvas(el as HTMLCanvasElement, doc);
      const tainted = look === "tainted";
      // A readable canvas with pixels in it is drawn into the picture by the
      // rasteriser — nothing missed, nothing to hatch. What stays blank is a
      // WebGL canvas that clears its buffer after each frame.
      if (look === "pixels" && paintsCanvases) continue;
      if (tainted) seen.taintedCanvases++;
      else seen.blankCanvases++;
      hatched.push({ el, rect, label: "canvas not captured" });
    } else {
      seen.videos++;
      hatched.push({ el, rect, label: "video not captured" });
    }
  }
  notes.push(...spotLines(seen));
  return hatched;
}

function hatch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: string): void {
  ctx.save();
  // Clip first: the diagonal strokes start left of the box by construction,
  // and unclipped they smear across neighbouring content (seen in the first
  // fixture dump, not hypothetical).
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = "#f3f3f3";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#d0d0d0";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = -h; i < w; i += 12) {
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h, y);
  }
  ctx.stroke();
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  if (w >= 120 && h >= 20) {
    ctx.fillStyle = "#8a8f98";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, x + w / 2, y + h / 2 + 4);
  }
  ctx.restore();
}

/** The block: provably zero information — a solid fill, never a blur. */
function maskBlock(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = "#5b5f66";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#8a8f98";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  if (w >= 80 && h >= 24) {
    ctx.fillStyle = "#c9cdd3";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("masked", x + w / 2, y + h / 2 + 4);
  }
  ctx.restore();
}

function htmlBackground(doc: Document): string {
  const win = doc.defaultView ?? window;
  for (const el of [doc.documentElement, doc.body]) {
    if (!el) continue;
    const bg = win.getComputedStyle(el).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
  }
  return "#ffffff";
}

/** One attempt at one scope with one option set — the ladder runs these. */
async function attempt(
  opts: CaptureOptions,
  scope: "viewport" | "element",
  inlineAssets: boolean,
  compositeOverlays: boolean,
  scopeForced: boolean,
): Promise<CaptureOutcome> {
  const doc = opts.doc;
  const win = doc.defaultView ?? window;
  const ours = `[${widgetAttr("root")}]`;
  const blind: string[] = [];

  /**
   * The settle: two frames — RACED AGAINST A TIMER, because a browser
   * pauses `requestAnimationFrame` entirely in a hidden tab and this await
   * never resolves there. Found by dogfooding, and it is not an exotic case:
   * a reviewer who clicks Post and immediately switches tab or app gets a
   * document that is `hidden` before the capture starts, so every rung of
   * the ladder burned its whole budget and the outcome was `timeout` —
   * 7.8 s of nothing, on a page whose raster takes 15 ms.
   *
   * 50 ms is two frames' worth at 60 Hz; when frames ARE running the rAF arm
   * wins and nothing changes. The hidden-tab wait below is what
   * gives a returning reviewer a settled page; this only stops the deadlock.
   */
  await Promise.race([
    new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r))),
    new Promise((r) => win.setTimeout(r, 50)),
  ]);
  if (doc.hidden) {
    await new Promise<void>((resolve) => {
      const t = win.setTimeout(resolve, 500);
      doc.addEventListener(
        "visibilitychange",
        () => {
          win.clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
  if (opts.signal?.aborted) throw new Error("navigated");

  // ── Masking, stage recording — BEFORE capture, fail closed on any throw ──
  let maskRects: DOMRect[];
  let maskSet: Set<Element>;
  try {
    const selector = maskSelectorList(opts).join(", ");
    const matches = [...doc.querySelectorAll(selector)].filter((el) => !el.closest(ours));
    maskSet = new Set(matches);
    maskRects = matches.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  } catch (e) {
    throw Object.assign(new Error("masking-failed"), { cause: e });
  }

  // ── Overlays (live rects) + blind-spot pre-scan ──────────────────────────
  const { overlays, notes } = compositeOverlays
    ? collectOverlays(doc, opts.maxOverlays ?? 8)
    : { overlays: [], notes: [] };
  blind.push(...notes);
  const hatched = scanBlindSpots(doc, blind, inlineAssets);
  const suppressed = new Set<Element>([...overlays.map((o) => o.el), ...maskSet]);

  // ── DPR and the raster budget: sharpness degrades before scope ────
  let dpr = Math.min(win.devicePixelRatio || 1, opts.maxDpr ?? 2);
  const de = doc.documentElement;
  const boxW = scope === "viewport" ? de.scrollWidth : 0;
  const boxH = scope === "viewport" ? de.scrollHeight : 0;
  const budget = opts.maxRasterPixels ?? 40_000_000;
  if (scope === "viewport") {
    const px = boxW * boxH * dpr * dpr;
    if (px > budget) dpr = Math.max(1, dpr * Math.sqrt(budget / px));
    if (boxW * boxH > budget) {
      // Still over at dpr 1: element scope, NAMED, never silent.
      return attempt(opts, "element", inlineAssets, compositeOverlays, true);
    }
  }

  // ── The raster ───────────────────────────────────────────────────────────
  let rootEl: Element = de;
  /** Source rect in the RASTER's coordinate space (root-box-relative). */
  let crop: { x: number; y: number; w: number; h: number };
  /** The crop's top-left in VIEWPORT coordinates — the frame mask and hatch
   *  rects arrive in, since they come from getBoundingClientRect. */
  let origin = { x: 0, y: 0 };
  if (scope === "viewport") {
    crop = { x: 0, y: 0, w: win.innerWidth, h: win.innerHeight }; // x/y set from rootBox below
  } else {
    const target = opts.target && opts.target.isConnected ? opts.target : de;
    const r = target.getBoundingClientRect();
    const pad = 200;
    const x0 = Math.max(0, r.left - pad);
    const y0 = Math.max(0, r.top - pad);
    const x1 = Math.min(win.innerWidth, r.right + pad);
    const y1 = Math.min(win.innerHeight, r.bottom + pad);
    // Smallest ancestor whose border box contains rect⊕pad.
    let host: Element = target;
    while (host.parentElement && host !== de) {
      const hb = host.getBoundingClientRect();
      if (hb.left <= x0 && hb.top <= y0 && hb.right >= x1 && hb.bottom >= y1) break;
      host = host.parentElement;
    }
    rootEl = host;
    const hb = host.getBoundingClientRect();
    crop = { x: x0 - hb.left, y: y0 - hb.top, w: x1 - x0, h: y1 - y0 };
    origin = { x: x0, y: y0 };
  }

  const raster = await rasterise(rootEl, {
    drop: (el) => el.closest?.(ours) != null, // REMOVED, one selector covers every surface of ours
    hide: (el) => suppressed.has(el),
    inlineSameOriginAssets: inlineAssets,
    ...(opts.fetchForeignImage ? { fetchForeignImage: opts.fetchForeignImage } : {}),
  });
  blind.push(...raster.blindSpots);
  if (opts.signal?.aborted) {
    raster.image.src = "";
    throw new Error("navigated");
  }

  // ── The ONE canvas: the crop, at capture DPR. The SVG
  // source is vector — drawImage rasterises it at DESTINATION scale, which
  // is where the dpr sharpness genuinely comes from. ──────────────────────
  const rootBox = rootEl.getBoundingClientRect();
  // The viewport's top-left in root-box coordinates is simply (-left, -top):
  // for documentElement that equals (scrollX, scrollY) without ever adding
  // scroll twice, and it stays correct when the root box itself is offset.
  const srcX = scope === "viewport" ? -rootBox.left : crop.x;
  const srcY = scope === "viewport" ? -rootBox.top : crop.y;
  const canvas = doc.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.w * dpr));
  canvas.height = Math.max(1, Math.round(crop.h * dpr));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = htmlBackground(doc);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(raster.image, srcX, srcY, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
  raster.image.src = "";

  // ── Overlays composited at their LIVE rects ───────────────────────
  if (overlays.some((o) => o.modal)) {
    ctx.fillStyle = "rgba(0,0,0,0.35)"; // the ::backdrop stand-in
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  let failedOverlays = 0;
  for (const o of overlays) {
    try {
      const or = await rasterise(o.el, {
        drop: (el) => el.closest?.(ours) != null,
        hide: (el) => maskSet.has(el),
        inlineSameOriginAssets: inlineAssets,
    ...(opts.fetchForeignImage ? { fetchForeignImage: opts.fetchForeignImage } : {}),
      });
      ctx.drawImage(
        or.image,
        Math.round(o.rect.left * dpr),
        Math.round(o.rect.top * dpr),
        Math.round(o.rect.width * dpr),
        Math.round(o.rect.height * dpr),
      );
      or.image.src = "";
    } catch {
      failedOverlays++;
    }
  }
  blind.push(...spotLines({ failedOverlays }));

  // ── hatches, then stage 2 LAST (a composited overlay must never
  // paint over a mask) — both in viewport coordinates, fail closed on throw ──
  const toCanvas = (r: DOMRect) => ({
    x: Math.round((r.left - origin.x) * dpr),
    y: Math.round((r.top - origin.y) * dpr),
    w: Math.round(r.width * dpr),
    h: Math.round(r.height * dpr),
  });
  for (const hb of hatched) {
    const c = toCanvas(hb.rect);
    if (c.w > 0 && c.h > 0) hatch(ctx, c.x, c.y, c.w, c.h, hb.label);
  }
  let maskedCount = 0;
  try {
    for (const r of maskRects) {
      const c = toCanvas(r);
      if (c.w <= 0 || c.h <= 0) continue;
      maskBlock(ctx, c.x, c.y, c.w, c.h);
      maskedCount++;
    }
  } catch (e) {
    throw Object.assign(new Error("masking-failed"), { cause: e });
  }

  if (opts.signal?.aborted) throw new Error("navigated");

  // ── Encode to the byte budget ─────────────────────────────────────
  let encoded;
  try {
    encoded = await encodeToBudget(canvas, doc, opts.maxLongestSide ?? MAX_LONGEST_SIDE);
  } catch (e) {
    canvas.width = canvas.height = 0;
    if ((e as { name?: string }).name === "SecurityError") throw new Error("tainted");
    throw e;
  }
  canvas.width = canvas.height = 0;
  if (!encoded) {
    return { situation: "engine-failed", blindSpots: blind, maskedCount };
  }
  return {
    situation: scopeForced ? "scope-forced" : "ok",
    blob: encoded.blob,
    quality: encoded.quality,
    width: Math.round(crop.w),
    height: Math.round(crop.h),
    blindSpots: blind,
    maskedCount,
  };
}

/**
 * Race an attempt against its budget; a timeout DISCARDS late results. ALL
 * error mapping lives here — the first build also wrapped each attempt in
 * `.catch(() => engine-failed)` at the call sites, which ran FIRST and
 * flattened every typed verdict (tainted, navigated, masking-failed) into
 * `engine-failed` before this function ever saw it.
 */
function raced(p: Promise<CaptureOutcome>, ms: number): Promise<CaptureOutcome> {
  return Promise.race([
    p.catch((e: Error) => {
      if (e.message === "masking-failed") return { situation: "masking-failed" as const, blindSpots: [], maskedCount: 0 };
      if (e.message === "navigated") return { situation: "navigated" as const, blindSpots: [], maskedCount: 0 };
      if (e.message === "tainted") return { situation: "tainted" as const, blindSpots: [], maskedCount: 0 };
      return { situation: "engine-failed" as const, blindSpots: [], maskedCount: 0 };
    }),
    new Promise<CaptureOutcome>((resolve) =>
      setTimeout(() => resolve({ situation: "timeout", blindSpots: [], maskedCount: 0 }), ms),
    ),
  ]);
}

/**
 * The ladder: full options (3000 ms) → retry with asset inlining and
 * overlay compositing OFF (1500 ms) → element scope (1500 ms) → no
 * screenshot, and the comment submits normally. Worst case 6 s; never an
 * engine swap; stage 4 was deleted (the widget never records).
 */
export async function captureScreenshot(opts: CaptureOptions): Promise<CaptureOutcome> {
  if (!(await probeDataImages(opts.doc))) {
    return { situation: "csp-blocked", blindSpots: [], maskedCount: 0 };
  }
  const scope = opts.scope ?? "viewport";
  const budgets = [opts.timeoutMs ?? 3000, 1500, 1500];

  let out = await raced(attempt(opts, scope, true, true, false), Math.min(budgets[0]!, 10_000));
  if (out.situation === "ok" || out.situation === "scope-forced" || out.situation === "masking-failed" || out.situation === "navigated" || out.situation === "tainted") return out;

  out = await raced(attempt(opts, scope, false, false, false), budgets[1]!);
  if (out.situation === "ok" || out.situation === "scope-forced" || out.situation === "masking-failed" || out.situation === "navigated" || out.situation === "tainted") return out;

  const last = await raced(attempt(opts, "element", false, false, true), budgets[2]!);
  if (last.situation === "ok" || last.situation === "scope-forced") return last;
  // Preserve the most specific verdict the ladder produced.
  return last.situation === "engine-failed" && out.situation === "timeout" ? out : last;
}
