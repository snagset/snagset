/**
 * The encode ladder — a REUSABLE unit on purpose: The reviewer
 * attachments "share the raster, downscale and encode machinery", so the
 * probe, the format selection, the quality step-down and the byte-budget
 * check live here with no capture-flow state in them (brief).
 *
 * The economics: WebP where encodable, JPEG on WebKit (Safari cannot
 * toBlob('image/webp')), quality stepped down until the blob fits 256 KB —
 * a BYTE budget, not a quality setting. Measured basis: WebP q0.75 ≈ 18 KB
 * at 1600 px, JPEG q0.8 ≈ 93 KB.
 */

/** And CHECKs the same number server-side. */
export const TARGET_BYTES = 256_000;
/** Longest edge 1600, clamp ≤ 2048 — the 2560 loses (LOCK's
 *  preamble: where any spec disagrees, LOCK wins; 04 flagged for amendment). */
export const MAX_LONGEST_SIDE = 1600;
export const MAX_LONGEST_SIDE_CLAMP = 2048;
const START_QUALITY = 0.82;
/** ≤ 0.5 MP: also encode PNG and keep the smaller — flat UI colour at small
 *  sizes compresses better lossless (the measured exception). */
const SMALL_RASTER_PX = 500_000;

/** The probe, not a UA test, is authoritative: a future Safari that gains
 *  the encoder takes the WebP branch with no code change. Cached per session. */
let webpProbe: boolean | null = null;
export function canEncodeWebp(doc: Document): boolean {
  if (webpProbe !== null) return webpProbe;
  try {
    const c = doc.createElement("canvas");
    c.width = 1;
    c.height = 1;
    webpProbe = c.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    webpProbe = false;
  }
  return webpProbe;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality);
    } catch (e) {
      // The handler lives HERE regardless of reachability: the
      // built-in SVG path cannot organically taint the canvas (it references
      // no external resource), but the handler is what the library
      // escalation path and the 'tainted' fixture both drive through. A
      // SecurityError REJECTS — swallowing it into null decays 'tainted'
      // into 'engine-failed' and the sentence becomes a lie.
      if ((e as { name?: string }).name === "SecurityError") reject(e);
      else resolve(null);
    }
  });
}

async function encodeOnce(canvas: HTMLCanvasElement, doc: Document, quality: number): Promise<Blob | null> {
  const blob = canEncodeWebp(doc)
    ? await toBlob(canvas, "image/webp", quality)
    : // JPEG floors at 0.85 on this branch — its artefacts at lower
      // qualities are what the floor exists to keep out of bug reports.
      await toBlob(canvas, "image/jpeg", Math.max(quality, 0.85));
  if (blob && (blob.type === "image/webp" || blob.type === "image/jpeg")) return blob;
  return toBlob(canvas, "image/png");
}

export interface EncodeResult {
  blob: Blob;
  /** The quality the size loop settled on — the DoD records it. */
  quality: number;
  /** True when the loop had to shrink the raster to fit the byte budget. */
  rescaled: boolean;
}

/**
 * Downscale so the longest side fits, then run the size loop: quality steps
 * of 0.12 while above 0.55, then a 0.75 rescale and a quality reset — at
 * most 4 iterations, and re-rastering is a drawImage on the composited
 * canvas, never a DOM re-serialisation. Still over 256 KB after all of it:
 * null, and the caller reports 'failed' — a byte budget is a promise.
 */
export async function encodeToBudget(
  source: HTMLCanvasElement,
  doc: Document,
  maxLongestSide: number = MAX_LONGEST_SIDE,
): Promise<EncodeResult | null> {
  const side = Math.min(Math.max(1, maxLongestSide), MAX_LONGEST_SIDE_CLAMP);
  let canvas = source;
  const longest = Math.max(canvas.width, canvas.height);
  if (longest > side) canvas = rescale(source, doc, side / longest);

  let quality = START_QUALITY;
  let rescaled = false;
  for (let i = 0; i < 4; i++) {
    let blob = await encodeOnce(canvas, doc, quality);
    if (!blob) return null;
    if (canvas.width * canvas.height <= SMALL_RASTER_PX) {
      const png = await toBlob(canvas, "image/png");
      if (png && png.size < blob.size) blob = png;
    }
    if (blob.size <= TARGET_BYTES) return { blob, quality, rescaled };
    if (quality > 0.55) {
      quality -= 0.12;
    } else {
      canvas = rescale(canvas, doc, 0.75);
      quality = START_QUALITY;
      rescaled = true;
    }
  }
  const last = await encodeOnce(canvas, doc, quality);
  return last && last.size <= TARGET_BYTES ? { blob: last, quality, rescaled } : null;
}

function rescale(canvas: HTMLCanvasElement, doc: Document, factor: number): HTMLCanvasElement {
  const next = doc.createElement("canvas");
  next.width = Math.max(1, Math.round(canvas.width * factor));
  next.height = Math.max(1, Math.round(canvas.height * factor));
  const ctx = next.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0, next.width, next.height);
  return next;
}
