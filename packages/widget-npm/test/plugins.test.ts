import { test } from "node:test";
import assert from "node:assert/strict";
import { snagset as vitePlugin } from "../src/vite.ts";
import { Snagset as NextSnagset } from "../src/next.ts";

/**
 * The two config-level installs. Both are thin shells over `tagFor()`, so
 * what these tests pin is the part that IS theirs: where the tag lands, what
 * happens when config is missing, and that neither can ever produce a tag the
 * hand-pasted form cannot (one tag, whatever the door).
 */

const CONFIG = { host: "https://review.example.com", site: "prj_demo" };

test("snagset/vite injects the one true tag at the end of <body>", () => {
  const plugin = vitePlugin(CONFIG);
  assert.equal(plugin.name, "snagset");
  const tags = plugin.transformIndexHtml();
  assert.equal(tags.length, 1);
  const tag = tags[0]!;
  assert.equal(tag.tag, "script");
  assert.equal(tag.injectTo, "body");
  assert.equal(tag.attrs["src"], "https://review.example.com/snag.js");
  assert.equal(tag.attrs["defer"], true);
  assert.equal(tag.attrs["data-snag-site"], "prj_demo");
  assert.equal(tag.attrs["data-snag-host"], "https://review.example.com");
});

test("snagset/vite refuses a config with no site AT STARTUP, not mid-build", () => {
  // The factory throws so `vite` stops with a sentence before serving anything.
  assert.throws(() => vitePlugin({ host: CONFIG.host } as never), /`site` is required/);
  assert.throws(() => vitePlugin({ site: CONFIG.site } as never), /`host` is required/);
});

test("snagset/next renders the script element itself — no effect, no client code", () => {
  const el = NextSnagset(CONFIG);
  assert.ok(el, "expected an element");
  const props = (el as unknown as { type: string; props: Record<string, unknown> });
  assert.equal(props.type, "script");
  assert.equal(props.props["src"], "https://review.example.com/snag.js");
  assert.equal(props.props["defer"], true);
  assert.equal(props.props["data-snag-site"], "prj_demo");
});

test("snagset/next falls back to NEXT_PUBLIC_SNAGSET_* — and NOT to bare SNAGSET_*", () => {
  process.env["NEXT_PUBLIC_SNAGSET_HOST"] = "https://review.example.com";
  process.env["NEXT_PUBLIC_SNAGSET_SITE"] = "prj_env";
  // Bait: were the component to read the server's reserved namespace, a
  // colocated instance's own variables would leak into the page.
  process.env["SNAGSET_SITE"] = "prj_WRONG";
  try {
    const el = NextSnagset();
    const props = (el as unknown as { props: Record<string, unknown> }).props;
    assert.equal(props["data-snag-site"], "prj_env");
    assert.equal(props["src"], "https://review.example.com/snag.js");
  } finally {
    delete process.env["NEXT_PUBLIC_SNAGSET_HOST"];
    delete process.env["NEXT_PUBLIC_SNAGSET_SITE"];
    delete process.env["SNAGSET_SITE"];
  }
});

test("snagset/next with no config renders NOTHING — a root layout must survive it", () => {
  // The widget's oldest rule, applied to its own installer: an unset env var
  // in some environment must not take down every page of the site.
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: string) => void warnings.push(String(msg));
  try {
    assert.equal(NextSnagset(), null);
  } finally {
    console.warn = original;
  }
  assert.ok(warnings.some((w) => w.includes("NEXT_PUBLIC_SNAGSET_HOST")), "the silence must be diagnosable in dev");
});
