import type { Config } from "./policy.ts";

/**
 * The API origin, inferred from the stub's own `<script src>` when the tag does
 * not name one — the same inference `resolveAssetBase` already makes for the
 * lazy chunks, applied to the other thing the script's own address tells us.
 *
 * ── THE SILENT FAILURE THIS REMOVES ──
 *
 * `host` decides whether the runtime talks to a server at all: with none, the
 * LOCAL adapter is used and every comment stays in that browser. So a tag
 * carrying `data-snag-site` and no `data-snag-host` looked completely correct —
 * toolbar, pin, screenshot, the lot — and reached nobody. The dashboard's Sites
 * screen, `snagset projects add` and the quickstart all printed exactly that
 * tag, and the browser check that was supposed to catch it passed because the
 * tag injected by hand happened to carry the attribute.
 *
 * The information was never missing. The script came FROM the instance; its
 * `src` is the instance. Inferring it makes the short tag right and deletes the
 * class of mistake rather than one instance of it.
 *
 * **Local demo mode is untouched.** It is triggered by the absence of
 * `data-snag-site` (`uid = config.site ?? "local"`), not by the absence of a
 * host — so a bare `<script src="…/snag.js">` still runs offline exactly as
 * before, which is what the first-run promise needs.
 *
 * An explicit `data-snag-host` always wins, which is what a CDN install needs:
 * loaded from `cdn.example.com`, the script's origin is the CDN and not the API.
 */
export function inferHost(cfg: Config, src: string | undefined): void {
  if (cfg.host || !src) return;
  try {
    // No same-origin exception. The first draft skipped inference when the
    // script came from the page's own origin, on the theory that a copied
    // `snag.js` should stay offline — which would have broken the real case it
    // was meant to protect (an instance serving its own page, where the API IS
    // there) and traded a loud 404 for the silent demo mode this function
    // exists to remove.
    cfg.host = new URL(src, location.href).origin;
  } catch {
    /* an unparseable src cannot name a host; the local adapter is the fallback */
  }
}
