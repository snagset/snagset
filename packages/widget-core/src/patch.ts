import { SYMBOL_KEY } from "@snagset/types/names";

/**
 * The patch registry, the ONLY sanctioned way to wrap a host global.
 *
 * Sentry, PostHog, LogRocket, Datadog RUM and New Relic patch the same globals
 * we do. A QA tool that suppresses the customer's error monitoring is removed
 * within a day, so the protocol here is not our convenience — it is
 * the contract that lets five instrumentation vendors coexist on one page:
 *
 *   P1 — IDEMPOTENT. Wrapping a function we already own is a no-op returning a
 *        no-op unwrapper. The check is the registered symbol, not module state,
 *        because the decision makes chunks self-contained: the stub, the runtime and
 *        snag.crumbs.js each carry their own COPY of this file, and the copies
 *        must recognise each other's wrappers. Everything that has to be shared
 *        lives on the wrapper function itself, under `Symbol.for()` keys that
 *        all copies resolve to the same registry entry.
 *   P2 — CALL-THROUGH PRESERVED. `make(prev)` builds the replacement; binding
 *        rule 1 obliges it to return `prev`'s result unchanged. The
 *        registry cannot enforce that, but it can refuse to add layers of its
 *        own between caller and `prev` beyond the one neutralisation check.
 *   P3 — `name` and `length` preserved where the engine permits, for host code
 *        that introspects `console.error.length`.
 *   P4 — IDENTITY-BASED RESTORE, order-independent. Restore only when we are
 *        still the top wrapper; otherwise neutralise ours to a pure
 *        pass-through. "Un-patch in reverse patch order" is neither sufficient
 *        (a third party may have wrapped in between) nor necessary.
 *   P5 — NEVER THROWS INTO HOST CODE. A frozen or non-configurable target is a
 *        silent skip, not an exception.
 *
 * watch.ts (history.pushState/replaceState — the named exception) is the first
 * consumer; the breadcrumb instrumentation is the second. A second registry is
 * forbidden, and by what happened when draft 1 had two.
 */

// The SYMBOL STRINGS are registered at (`Symbol.for('snagset.*')`).
// The constants are private identifiers and deliberately NOT `SNAGSET_`-shaped
// (the rename note): scopes that spelling to environment
// variables, and a source constant matching the lint pattern without being one
// is how a lint gets disabled.
const SYM_ORIGINAL = Symbol.for(SYMBOL_KEY.original);
const SYM_WRAPPED = Symbol.for(SYMBOL_KEY.wrapped);

type AnyFn = (...args: never[]) => unknown;

/** Undo one `wrap()`. Applies the restore matrix; safe to call twice. */
export type Unwrap = () => void;

const NOOP_UNWRAP: Unwrap = () => {};

export function wrap<T extends object>(
  owner: T,
  key: keyof T & PropertyKey,
  make: (prev: AnyFn) => AnyFn,
): Unwrap {
  let prev: unknown;
  try {
    prev = owner[key];
  } catch {
    return NOOP_UNWRAP; // P5 — a throwing getter is the host's business
  }
  // Restore-matrix row 3 taken at wrap time as well: a target that is not a
  // function (host nuked it, or it never existed on this engine) is left alone.
  if (typeof prev !== "function") return NOOP_UNWRAP;
  // P1 — the top of the chain is already one of OUR wrappers, possibly from a
  // different artefact's copy of this module. Wrapping again would record every
  // event twice and unwind in the wrong order.
  if ((prev as unknown as Record<symbol, unknown>)[SYM_WRAPPED]) return NOOP_UNWRAP;

  const original = prev as AnyFn;
  const inner = make(original);

  // `neutralised` lives in the closure, not on the function: only the copy that
  // created a wrapper ever neutralises it, so no cross-copy access is needed —
  // and a symbol-published flag would invite another tool to flip it.
  let neutralised = false;
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    return neutralised
      ? (original as (...a: unknown[]) => unknown).apply(this, args)
      : (inner as (...a: unknown[]) => unknown).apply(this, args);
  };

  try {
    const w = wrapper as unknown as Record<symbol, unknown>;
    w[SYM_WRAPPED] = true;
    w[SYM_ORIGINAL] = original;
    // P3 — both properties are configurable-only on functions, so this is a
    // defineProperty or nothing.
    Object.defineProperty(wrapper, "name", { value: original.name, configurable: true });
    Object.defineProperty(wrapper, "length", { value: original.length, configurable: true });
  } catch {
    /* P5 — cosmetic metadata; a sealed engine object costs us nothing */
  }

  try {
    owner[key] = wrapper as unknown as T[typeof key];
  } catch {
    return NOOP_UNWRAP; // P5 — frozen owner: silent skip
  }
  // A defineProperty-guarded setter can swallow the assignment without
  // throwing. If our wrapper did not actually land, there is nothing to undo.
  if ((owner[key] as unknown) !== wrapper) return NOOP_UNWRAP;

  return () => {
    let current: unknown;
    try {
      current = owner[key];
    } catch {
      current = undefined;
    }
    if (current === wrapper) {
      // Row 1 — still on top: full unwind.
      try {
        owner[key] = original as unknown as T[typeof key];
        return;
      } catch {
        /* fall through to neutralise — the owner froze after we wrapped */
      }
    }
    // Rows 2–3 — someone wrapped on top of us, or the host replaced the slot.
    // Restoring would delete THEIR wrapper, so ours becomes a pass-through and
    // stays in the chain.
    neutralised = true;
  };
}
