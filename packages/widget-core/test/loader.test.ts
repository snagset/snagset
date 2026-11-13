import { test } from "node:test";
import assert from "node:assert/strict";
import { inferHost } from "../src/loader/infer-host.ts";

/**
 * The API origin, inferred from the stub's own `<script src>`.
 *
 * ── WHY THIS EXISTS ──
 *
 * `config.host` decides which storage adapter the runtime builds: with one it
 * talks to the server, without one it uses the LOCAL adapter and every comment
 * stays in that browser. So a tag carrying `data-snag-site` and no
 * `data-snag-host` looked entirely correct — toolbar, pin, screenshot, the
 * lot — and reached nobody.
 *
 * The dashboard's Sites screen, `snagset projects add` and the quickstart all
 * printed exactly that tag. The browser check that should have caught it passed
 * because the tag it injected by hand happened to carry the attribute.
 *
 * The information was never missing: the script came FROM the instance.
 */

const at = (src: string, page = "https://shop.test/checkout") => {
  // `new URL(src, location.href)` needs a base; the src here is always absolute
  // so the base is never consulted, and this keeps the test DOM-free.
  (globalThis as Record<string, unknown>)["location"] = { href: page, origin: new URL(page).origin };
  const cfg: Record<string, string | undefined> = {};
  return { cfg, run: (existing?: string) => (existing && (cfg["host"] = existing), inferHost(cfg, src), cfg) };
};

test("a tag with no data-snag-host talks to the origin it was served from", () => {
  assert.equal(at("https://review.example.com/snag.js").run()["host"], "https://review.example.com");
});

test("an explicit data-snag-host always wins — the CDN case", () => {
  // Loaded from a CDN, the script's origin is the CDN and not the API, so an
  // explicit host is the only thing that can be right.
  const { run } = at("https://cdn.example.com/snagset/snag.js");
  assert.equal(run("https://review.example.com")["host"], "https://review.example.com");
});

test("an instance serving its own page infers itself, not nothing", () => {
  // The first draft skipped inference when the script came from the page's own
  // origin, on the theory that a copied `snag.js` should stay offline. That
  // broke exactly this — an instance serving a demo page, where the API IS
  // there — and traded a loud 404 for the silent demo mode this removes.
  const page = "http://localhost:8080/demo";
  assert.equal(at("http://localhost:8080/snag.js", page).run()["host"], "http://localhost:8080");
});

test("no src means no host, so the local adapter still runs", () => {
  // The first-run promise: a bare tag works offline with no account. That is
  // triggered by the absence of `data-snag-site`, and this must not
  // accidentally give it a server to fail against.
  const cfg: Record<string, string | undefined> = {};
  inferHost(cfg, undefined);
  assert.equal(cfg["host"], undefined);
});

test("an empty src is not a host", () => {
  // The only falsy case that can reach here. A first version of this test used
  // a nonsense string and asserted no host — wrong, because `new URL(junk,
  // base)` does not throw, it RESOLVES against the base. It cannot happen
  // either way: `HTMLScriptElement.src` is the IDL attribute, which the DOM
  // returns already resolved and absolute, so by the time the loader is running
  // (which means the script loaded) the src is a real URL.
  const cfg: Record<string, string | undefined> = {};
  inferHost(cfg, "");
  assert.equal(cfg["host"], undefined);
});
