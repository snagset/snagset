import { GLOBALS, scriptAttr, param, COOKIE, type ScriptAttr } from "@snagset/types/names";

export type Config = Partial<Record<ScriptAttr, string>>;

/**
 * Everything the activation policy is allowed to look at, captured as plain data.
 *
 * The policy is a PURE function of this snapshot — no DOM, no globals — because a
 * kill switch that can only be tested by arranging a browser is a kill switch that
 * goes untested. (Discovered the hard way: `navigator.webdriver` is false in the
 * dev preview browser, so the automation refusal could not be proven there at all.)
 * v0's "12 kill switches, one explanation" task builds directly on this shape.
 */
/**
 * `window.SnagsetConfig` — the second rung, and the shape
 *
 * NOT the same type as `Config`. Attribute config is all strings, because HTML
 * attributes are; this is a real JavaScript object a host assigns, so `disabled`
 * is a boolean, `enabled` may be a predicate, and `allowedOrigins` is an array.
 * Collapsing the two into one type is what would force a host to write
 * `disabled: "true"`.
 *
 * Every field is `unknown`-ish and checked at the point of use: this object
 * comes from the host page and nothing validates it on the way in. A host that
 * writes `allowedOrigins: "https://x"` instead of an array must not take the
 * widget down with a TypeError — the design is absolute about that.
 */
export interface ConfigGlobal {
  disabled?: unknown;
  /** `false`, or a predicate returning false. */
  enabled?: unknown;
  /** When set, `location.origin` must be in it. */
  allowedOrigins?: unknown;
  [key: string]: unknown;
}

export interface Env {
  /** A review token arrived on this URL, or a holder identity for this project
   *  is already stored — either way, this visitor is in review and the
   *  production gate must not apply (row: no-review-token). */
  inReview?: boolean;
  config: Config;
  search: string;
  cookie: string;
  webdriver: boolean;
  globals: Record<string, unknown>;
  /** Layer 2. Absent on a page that never set one, which is most. */
  configGlobal?: ConfigGlobal;
  /** `location.origin`, passed rather than read so the policy stays pure. */
  origin?: string;
}

/**
 * One rung .2's ladder.
 *
 * `gate` is the spec's own token — the thing that appears after
 * `not activated:` — and `token` is the registered name of the switch that
 * actually fired, so "why is it not showing" still has exactly one answer even
 * where one gate has two triggers (`off-switch` is both the query param and the
 * cookie). `fix` is the half .2's line that makes the diagnostic
 * actionable rather than merely honest.
 */
export interface Gate {
  gate: string;
  token: string;
  fix: string;
  /**
   * Two gates print NOTHING by default: `automation`, because a
   * client's own test suite asserting an empty console must not be broken by
   * us, and `no-review-token`, because it is the steady state of every
   * production install and would otherwise log on every page view forever.
   */
  silent?: boolean;
}

/**
 * Why the widget must stay inert, or null to proceed.
 *
 * Ordered as the ladder is ordered, and FIRST MATCH WINS — a page that
 * trips two gates still explains itself with exactly one line.
 */
export function blockedReason(env: Env): Gate | null {
  const { config: cfg } = env;

  // E2E kill switch (set via Playwright addInitScript before any page script).
  if (env.globals[GLOBALS.disabled]) {
    return {
      gate: "disabled-global",
      token: GLOBALS.disabled,
      fix: `delete window.${GLOBALS.disabled}`,
    };
  }

  /**
   * ROW 4 — `window.SnagsetConfig.disabled === true`, v0.
   *
   * Documented as the SECOND recipe rather than the first (the own note), for
   * hosts that already set the config global for other reasons and would rather
   * not also template an attribute onto the tag. It sits here, beside the other
   * two hard-off rungs, because it means the same thing they do.
   *
   * `=== true`, not truthy: a host with `disabled: 0` or `disabled: ""` means
   * "not disabled", and reading those as off would silently uninstall the
   * widget for somebody who was trying to keep it.
   */
  if (env.configGlobal?.disabled === true) {
    return {
      gate: "disabled-config",
      token: `${GLOBALS.config}.disabled`,
      fix: `set ${GLOBALS.config}.disabled = false`,
    };
  }

  // Hard off, presence-means-off, matching HTML's own disabled/hidden/inert.
  if ("disabled" in cfg) {
    return {
      gate: "disabled-attr",
      token: scriptAttr("disabled"),
      fix: `remove ${scriptAttr("disabled")} from the script tag`,
    };
  }

  // Per-load and persistent opt-out. ONE gate, two triggers.
  if (new URLSearchParams(env.search).has(param("off"))) {
    return {
      gate: "off-switch",
      token: param("off"),
      fix: `remove ?${param("off")} from the URL`,
    };
  }
  if (env.cookie.split("; ").some((c) => c.startsWith(COOKIE.off + "="))) {
    return {
      gate: "off-switch",
      token: COOKIE.off,
      fix: `clear the ${COOKIE.off} cookie`,
    };
  }

  // Automation refusal: a test suite must not be pinning things. Opt out with
  // data-snag-allow-automation, which is how we test the widget itself.
  /**
   * ROW 8, and the spec PRINTS three checks where we had one.
   *
   * `navigator.webdriver` is mandated by the WebDriver spec and set by
   * Playwright, Puppeteer and Selenium. **Cypress sets nothing** — it runs the
   * app inside an iframe in its own runner and exposes `window.Cypress`
   * instead, so a client running their own Cypress suite against the staging
   * deployment that carries `data-snag-mode="on"` — the documented staging
   * configuration — had a live review widget intercepting their clicks.
   *
   * The `opener` check is the same runner seen from a spawned window.
   */
  const automated =
    env.webdriver ||
    "Cypress" in env.globals ||
    isCypressOpener(env.globals["opener"]);
  if (automated && !("allowAutomation" in cfg)) {
    return {
      gate: "automation",
      token: env.webdriver ? "navigator.webdriver" : "window.Cypress",
      fix: `add ${scriptAttr("allowAutomation")} if this is deliberate`,
      silent: true,
    };
  }

  const mode = cfg.mode ?? "auto";
  if (mode === "off") {
    return {
      gate: "mode-off",
      token: `${scriptAttr("mode")}="off"`,
      fix: `set ${scriptAttr("mode")}="on"`,
    };
  }
  // `auto` is the safe default: it declines to run on a production deployment
  // unless someone says so explicitly — OR unless this visitor is IN REVIEW.
  //
  // The gate has been named `no-review-token` since it was written, and until
  // now it never checked for one: a client opening their review link on a
  // production install got an inert page, silently, which is this gate's own
  // documented exception not implemented. `inReview` is true when the URL
  // carried a review token or when a holder identity for this project is
  // already in localStorage — someone who has reviewed here before, which on a
  // link-required site means someone who once held a link.
  if (mode === "auto" && cfg.env === "production" && !env.inReview) {
    return {
      gate: "no-review-token",
      token: `${scriptAttr("env")}="production"`,
      fix: `set ${scriptAttr("mode")}="on" to review production deliberately`,
      silent: true,
    };
  }

  /**
   * ROW 9 — `config.enabled === false`, or a predicate returning false, v0.
   *
   * A predicate is how a host gates on their own feature flag or on who is
   * logged in, which is the case exists to serve and the reason this is not
   * simply a boolean. It runs inside a try: it is HOST CODE running on our
   * stack, and the design says a throw from it must not take the page down. A
   * predicate that throws is treated as "no opinion" rather than as `false` —
   * refusing to run because somebody's flag service was down would be the more
   * surprising of the two failures.
   */
  if (env.configGlobal && "enabled" in env.configGlobal) {
    const e = env.configGlobal.enabled;
    let off = e === false;
    if (typeof e === "function") {
      try {
        off = (e as () => unknown)() === false;
      } catch {
        off = false;
      }
    }
    if (off) {
      return {
        gate: "config-disabled",
        token: `${GLOBALS.config}.enabled`,
        fix: `set ${GLOBALS.config}.enabled = true`,
      };
    }
  }

  /**
   * ROW 10 — `allowedOrigins` set and `location.origin` not in it, v0.
   *
   * The case: one shared layout template renders on staging and on production,
   * and the operator scopes the widget by origin rather than by templating a
   * different tag per environment. Without this the tag on the template was
   * live everywhere it rendered.
   *
   * An EMPTY array means "nowhere", and is honoured as written. A non-array is
   * ignored with no gate: a host who typed a string meant to allow that origin,
   * and refusing to run is the opposite of what they asked for.
   */
  const allowed = env.configGlobal?.allowedOrigins;
  if (Array.isArray(allowed) && !allowed.includes(env.origin ?? "")) {
    return {
      gate: "origin-not-allowed",
      token: `${GLOBALS.config}.allowedOrigins`,
      fix: `add ${env.origin ?? "this origin"} to ${GLOBALS.config}.allowedOrigins`,
    };
  }

  return null;
}

/** Cypress seen from a window it opened. Guarded: `opener` is cross-origin on
 *  plenty of pages and touching it throws. */
function isCypressOpener(opener: unknown): boolean {
  try {
    return !!opener && typeof opener === "object" && "Cypress" in (opener as object);
  } catch {
    return false;
  }
}
