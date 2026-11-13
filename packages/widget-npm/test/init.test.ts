import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import snagset, { init, destroy, isInstalled, tagFor } from "../src/index.ts";
import { snagsetTag } from "../src/astro.ts";
import { scriptAttr } from "@snagset/types/names";

/**
 * The shim.
 *
 * A tiny DOM stub rather than jsdom: everything under test is "which attributes
 * end up on one script element", and a 30-line stub makes that legible where a
 * DOM implementation would make it a dependency and an unrelated failure mode.
 */

interface FakeScript {
  src: string;
  defer: boolean;
  attributes: Record<string, string>;
  remove(): void;
  /** The `load` listener `init()` attaches, so a test can deliver it. */
  fire(event: string): void;
}

let head: FakeScript[];

function installDom(): void {
  head = [];
  const doc = {
    createElement: (): FakeScript => {
      const listeners: Record<string, (() => void)[]> = {};
      const el: FakeScript = {
        src: "",
        defer: false,
        attributes: {},
        remove() {
          head = head.filter((s) => s !== el);
        },
        fire(event) {
          for (const fn of listeners[event] ?? []) fn();
        },
      };
      (el as unknown as Record<string, unknown>)["addEventListener"] = (n: string, fn: () => void) => {
        (listeners[n] ??= []).push(fn);
      };
      // `setAttribute` is what the shim calls; the object carries it as an own
      // method so the stub stays a plain object rather than a class.
      (el as unknown as Record<string, unknown>)["setAttribute"] = (n: string, v: string) => {
        el.attributes[n] = v;
      };
      return el;
    },
    head: { appendChild: (el: FakeScript) => head.push(el) },
  };
  (globalThis as Record<string, unknown>)["document"] = doc;
  (globalThis as Record<string, unknown>)["window"] = {};
}

beforeEach(installDom);

const only = (): FakeScript => {
  assert.equal(head.length, 1, `expected one script, found ${head.length}`);
  return head[0]!;
};

test("init writes the tag the docs tell you to paste", () => {
  init({ host: "https://review.example.com", site: "prj_abc123456789" });
  const el = only();
  assert.equal(el.src, "https://review.example.com/snag.js");
  assert.equal(el.defer, true, "must not block parsing of somebody else's page");
  assert.equal(el.attributes[scriptAttr("site")], "prj_abc123456789");
  assert.equal(el.attributes[scriptAttr("host")], "https://review.example.com");
});

test("a trailing slash on host does not produce a double slash", () => {
  init({ host: "https://review.example.com/", site: "prj_abc123456789" });
  assert.equal(only().src, "https://review.example.com/snag.js");
});

test("init twice adds ONE tag — React strict mode runs effects twice", () => {
  const off = init({ host: "https://h.test", site: "prj_abc123456789" });
  init({ host: "https://h.test", site: "prj_abc123456789" });
  assert.equal(head.length, 1, "a second tag would boot a second widget");
  assert.equal(isInstalled(), true);
  off();
  assert.equal(head.length, 0);
  assert.equal(isInstalled(), false);
});

test("`false` is DROPPED, never written as the string \"false\"", () => {
  // `data-snag-disabled="false"` reads as "disabled" to a has-attribute check,
  // which is the shape the kill switches use. Writing it would turn an
  // explicit opt-IN into an opt-out.
  init({ host: "https://h.test", site: "prj_abc123456789", disabled: false, screenshots: false });
  const el = only();
  assert.ok(!(scriptAttr("disabled") in el.attributes));
  assert.ok(!(scriptAttr("screenshots") in el.attributes));
});

test("`true` becomes a bare attribute, not the string \"true\"", () => {
  init({ host: "https://h.test", site: "prj_abc123456789", disabled: true });
  assert.equal(only().attributes[scriptAttr("disabled")], "");
});

test("every option maps to its registered data-snag-* name", () => {
  // The mapping is `scriptAttr()`'s, so this cannot drift from the attribute
  // registry — which is the reason the option type is keyed on ScriptAttr
  // rather than being a hand-written list.
  const { attrs } = tagFor({
    host: "https://h.test",
    site: "prj_abc123456789",
    env: "staging",
    theme: "dark",
    lang: "pt",
    hotkey: "alt+c",
  });
  assert.equal(attrs["data-snag-env"], "staging");
  assert.equal(attrs["data-snag-theme"], "dark");
  assert.equal(attrs["data-snag-lang"], "pt");
  assert.equal(attrs["data-snag-hotkey"], "alt+c");
  assert.ok(!("target" in attrs), "target is ours, not the widget's");
});

test("host and site are required, and say which is missing", () => {
  assert.throws(() => init({ site: "prj_abc123456789" } as never), /host` is required/);
  assert.throws(() => init({ host: "https://h.test" } as never), /site` is required/);
});

test("on the server it is a no-op, not a crash", () => {
  // This package is imported at module scope in a Next.js or Nuxt component,
  // so it IS evaluated on the server.
  delete (globalThis as Record<string, unknown>)["document"];
  delete (globalThis as Record<string, unknown>)["window"];
  assert.doesNotThrow(() => init({ host: "https://h.test", site: "prj_abc123456789" }));
  assert.doesNotThrow(() => destroy());
  assert.equal(isInstalled(), false);
});

test("destroy calls the widget's OWN teardown", () => {
  // Removing the script element does nothing — the code has already run and
  // the listeners are already bound. This is the difference between a teardown
  // that works and one that appears to.
  let destroyed = false;
  (globalThis as Record<string, unknown>)["window"] = { Snagset: { destroy: () => (destroyed = true) } };
  destroy();
  assert.equal(destroyed, true);
});

test("the astro helper renders a pasteable tag", () => {
  const tag = snagsetTag({ host: "https://review.example.com", site: "prj_abc123456789", env: "staging" });
  assert.match(tag.html, /^<script src="https:\/\/review\.example\.com\/snag\.js"/);
  assert.match(tag.html, /data-snag-site="prj_abc123456789"/);
  assert.match(tag.html, /data-snag-env="staging"/);
  assert.match(tag.html, /defer><\/script>$/);
});

test("an attribute value containing a quote cannot break out of the tag", () => {
  // `env` reaches this from a config file or an environment variable, and the
  // output is interpolated into HTML by whoever renders it.
  const tag = snagsetTag({ host: "https://h.test", site: "prj_abc123456789", env: 'a" onload="x' });
  assert.ok(!tag.html.includes('" onload="'), tag.html);
  assert.match(tag.html, /&quot;/);
});

// ── the front door ───────────────────────────────────────────────────────

test("the default export carries the verbs", () => {
  // `init` and `destroy` are the widget's OWN public API (and
  // `window.Snagset.init` is on the live object). The first version of this
  // package called them `mount`/`unmount` — React vocabulary imported into a
  // product that already had a name for this — so a developer would have read
  // `snagset.mount()` in their app and `Snagset.init()` in the console and
  // reasonably concluded they were different things.
  assert.equal(snagset.init, init);
  assert.equal(snagset.destroy, destroy);
  assert.equal(snagset.isInstalled, isInstalled);
  assert.equal(snagset.tag, tagFor);
  assert.equal(typeof (snagset as unknown as () => void), "object", "an object with init, not a callable");
});

test("init returns its own teardown", () => {
  const off = snagset.init({ host: "https://h.test", site: "prj_abc123456789" });
  assert.equal(head.length, 1);
  off();
  assert.equal(head.length, 0);
  assert.equal(isInstalled(), false);
});

test("a SECOND init merges config through Snagset.init — the documented contract", () => {
  // "may be called repeatedly before activation; each call merges". A second
  // call must not add a second tag, and must not silently drop the config
  // either — which is what the first version did.
  const merged: unknown[] = [];
  init({ host: "https://h.test", site: "prj_abc123456789" });
  (globalThis as Record<string, unknown>)["window"] = {
    ...(globalThis as Record<string, unknown>)["window"] as object,
    Snagset: { init: (c: unknown) => merged.push(c) },
  };
  init({ host: "https://h.test", site: "prj_abc123456789", theme: "dark" });
  assert.equal(head.length, 1, "no second tag — that would boot a second widget");
  assert.deepEqual(merged, [{ host: "https://h.test", site: "prj_abc123456789", theme: "dark" }]);
});

test("config queued before the widget loads is FLUSHED on load, not dropped", () => {
  /**
   * A caller cannot know whether an async script has arrived, so "your second
   * call worked or did not depending on timing" is not a contract. The tag
   * carries a one-time `load` listener that flushes whatever queued.
   */
  init({ host: "https://h.test", site: "prj_abc123456789" });
  // The widget is not there yet — this is the race the queue exists for.
  init({ host: "https://h.test", site: "prj_abc123456789", theme: "dark" });

  const merged: unknown[] = [];
  (globalThis as Record<string, unknown>)["window"] = {
    ...(globalThis as Record<string, unknown>)["window"] as object,
    Snagset: { init: (c: unknown) => merged.push(c) },
  };
  only().fire("load");
  assert.deepEqual(merged, [{ host: "https://h.test", site: "prj_abc123456789", theme: "dark" }]);
});

test("`target` is ours and never reaches the widget's config", () => {
  const merged: Record<string, unknown>[] = [];
  init({ host: "https://h.test", site: "prj_abc123456789" });
  (globalThis as Record<string, unknown>)["window"] = {
    ...(globalThis as Record<string, unknown>)["window"] as object,
    Snagset: { init: (c: Record<string, unknown>) => merged.push(c) },
  };
  init({ host: "https://h.test", site: "prj_abc123456789", target: {} as Element });
  assert.ok(!("target" in merged[0]!), "where to put the tag means nothing to the widget");
});

test("every subpath default-exports, so the import can be named after the package", async () => {
  const [core, react, vue, astro] = await Promise.all([
    import("../src/index.ts"),
    import("../src/react.ts"),
    import("../src/vue.ts"),
    import("../src/astro.ts"),
  ]);
  for (const [name, mod] of [["index", core], ["react", react], ["vue", vue], ["astro", astro]] as const) {
    assert.ok(mod.default, `${name} has no default export`);
  }
  assert.equal(react.default, react.Snagset);
  assert.equal(vue.default, vue.Snagset);
  assert.equal(astro.default, astro.snagsetTag);
});
