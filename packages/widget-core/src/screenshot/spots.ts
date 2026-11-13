/**
 * The blind-spot sentences, COUNTED — one line per kind, never one
 * element.
 *
 * The rasteriser used to push "1 image may appear as a placeholder (served
 * without CORS headers)" once per image, so a client page with six hotlinked
 * images (found reviewing a real one) showed the identical line six times —
 * in the widget's capture block AND in the dashboard, which renders
 * `blindSpots[]` verbatim. The own example row is already the aggregate
 * ("2 images may appear as placeholders"); the per-element push was the bug.
 * The scan in capture.ts had the same shape for iframes, canvases, videos and
 * failed overlays.
 *
 * Counts in, sentences out, and nothing else here — so the plural rules are
 * testable under `node --test` without a DOM, and both producers (raster.ts's
 * style sweep, capture.ts's pre-scan) word a kind the same way. The
 * sentences are DATA that travels with the thread, not UI chrome,
 * which is why they live in the screenshot chunk beside their producers
 * rather than in a strings catalogue no other chunk would read.
 */

export interface SpotCounts {
  /** Cross-origin `<img>` without CORS → grey placeholder. */
  corsImages?: number;
  /** Same-origin images the inline step could not fetch (blind spot 1). */
  failedImages?: number;
  /** Painting shadow hosts (blind spot 6). */
  shadowRoots?: number;
  /** One entry per cross-origin iframe; "" where no host could be parsed
   *  (srcdoc, about). Hosts only, never a path or query. */
  iframeHosts?: string[];
  taintedCanvases?: number;
  blankCanvases?: number;
  videos?: number;
  /** Overlays whose own raster threw during the composite. */
  failedOverlays?: number;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function spotLines(c: SpotCounts): string[] {
  const out: string[] = [];
  const cors = c.corsImages ?? 0;
  if (cors > 0) {
    out.push(
      `${cors} ${plural(cors, "image may appear as a placeholder", "images may appear as placeholders")} (served without CORS headers)`,
    );
  }
  const failed = c.failedImages ?? 0;
  if (failed > 0) {
    out.push(`${failed} ${plural(failed, "image", "images")} could not be included in the screenshot`);
  }
  const shadow = c.shadowRoots ?? 0;
  if (shadow > 0) {
    out.push(
      shadow === 1
        ? "1 web component could not be captured (its contents are in a shadow root)"
        : `${shadow} web components could not be captured (their contents are in shadow roots)`,
    );
  }
  const frames = c.iframeHosts ?? [];
  if (frames.length > 0) {
    // Each host named ONCE: three embeds from one video provider are one fact
    // about the page, and repeating the host is the same noise as repeating
    // the line was.
    const hosts = [...new Set(frames.filter(Boolean))].join(", ");
    out.push(
      `${frames.length} cross-origin ${plural(frames.length, "iframe", "iframes")} not captured${hosts ? `: ${hosts}` : ""}`,
    );
  }
  const tainted = c.taintedCanvases ?? 0;
  if (tainted > 0) {
    out.push(
      tainted === 1
        ? "1 canvas could not be read (tainted by a cross-origin image)"
        : `${tainted} canvases could not be read (tainted by cross-origin images)`,
    );
  }
  const blank = c.blankCanvases ?? 0;
  if (blank > 0) out.push(`${blank} ${plural(blank, "canvas", "canvases")} may appear blank`);
  // The sentence carries no count, so it is said once however many videos.
  if ((c.videos ?? 0) > 0) out.push("Video frames are not captured");
  const ov = c.failedOverlays ?? 0;
  if (ov > 0) out.push(`${ov} overlay ${plural(ov, "element", "elements")} could not be captured`);
  return out;
}
