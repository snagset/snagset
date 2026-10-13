import { wrap, type Unwrap } from "../patch.ts";

/**
 * Tiers A and B — the stub's share of breadcrumbs.
 *
 * They exist because the bug class QA actually reports is "the page loaded
 * wrong", and by activation the evidence is gone: React, Next, Vue and Svelte
 * report hydration mismatches EXCLUSIVELY through console.error/warn — they do
 * not throw. So the stub owns:
 *
 *   Tier A — two addEventListener calls (`error` capturing, so resource
 *            failures surface too, and `unhandledrejection`) plus one
 *            initial-URL record. ZERO monkey-patching.
 *   Tier B — console.error and console.warn wrapped through the ONE
 *            registry. Off with `breadcrumbs.early: false`; Tier A is not.
 *
 * What the stub does NOT do, each by spec:
 *   - No redaction. The PreBuffer holds REDUCED STRINGS in page
 *     memory; nothing crosses a trust boundary before activation because there
 *     is no network path before activation (00 A1). The runtime redacts the
 *     backlog as it seeds the real buffer.
 *   - No network. Tier A+B are listeners, two wrappers and an array — the
 *     purity E2E diffs `performance.getEntriesByType('resource')` to
 *     zero with breadcrumbs on.
 *   - No de-duplication. The flood guard below bounds the same failure (a
 *     console.error inside a render loop) at strictly lower cost; full de-dupe
 *     lives in the runtime buffer where it is affordable.
 *   - No deep serialisation. The shallow reducer is one non-recursive
 *     pass; parking raw `[level, args]` tuples would retain whatever the host
 *     logged — the memory rule .3 binds the stub too.
 */

/** [epoch-ms, type, level, message] — reduced, UNREDACTED until seeding. */
export type PreRecord = [number, "console" | "error" | "navigation" | "system", string, string];

export interface EarlyCrumbs {
  /**
   * Hand everything to the runtime, once. The buffer is emptied and every
   * later record goes straight to the sink the caller installs — after
   * activation the real BreadcrumbBuffer owns ordering and redaction, and a
   * second copy accumulating here would just be a leak.
   */
  drain(sink: (rec: PreRecord) => void): { records: PreRecord[]; dropped: number };
  /** Unwind Tier B via the registry's restore matrix. Tier A dies with the stub's signal. */
  destroy(): void;
}

/** One non-recursive pass; every branch contained. */
export function reduceArg(v: unknown): string {
  try {
    if (typeof v === "string") return v.slice(0, 512);
    if (v === null || v === undefined || typeof v !== "object") {
      if (typeof v === "function") return `[Function ${(v as { name?: string }).name ?? ""}]`;
      return String(v);
    }
    const o = v as { name?: unknown; message?: unknown; stack?: unknown; nodeType?: unknown; tagName?: unknown };
    // `instanceof Error` misses cross-realm errors (an iframe's TypeError), so
    // duck-typing is the primary test and instanceof merely confirms it.
    if ((typeof o.name === "string" && typeof o.message === "string") || v instanceof Error) {
      const head = `${String(o.name)}: ${String(o.message)}`;
      const stack = typeof o.stack === "string" ? o.stack.split("\n").slice(0, 10).join("\n") : "";
      return (stack ? `${head}\n${stack}` : head).slice(0, 1024);
    }
    if (o.nodeType !== undefined) {
      // Never id, class, attributes, children or text — a node reference is
      // exactly the retention hazard the reducer exists to avoid.
      return typeof o.tagName === "string" ? `<${o.tagName.toLowerCase()}>` : "[Node]";
    }
    if (Array.isArray(v)) return `[Array(${v.length})]`;
    return `[${Object.prototype.toString.call(v).slice(8, -1)}]`;
  } catch {
    return "[unreadable]"; // a throwing getter on a duck-typed `name` must not break console.error
  }
}

export function installEarly(
  win: Window & typeof globalThis,
  opts: { early: boolean },
  signal: AbortSignal,
): EarlyCrumbs {
  // ── PreBuffer + flood guard (verbatim shape) ──────────────────────
  const pre: PreRecord[] = [];
  let dropped = 0;
  let windowStart = 0;
  let windowCount = 0;
  let suppressed = 0;
  let sink: ((rec: PreRecord) => void) | null = null;
  // Recorder failures never reach host code; three in a row
  // disable this instrumentation for the session.
  let failures = 0;

  const push = (type: PreRecord[1], level: string, msg: string): void => {
    if (failures >= 3) return;
    try {
      const now = Date.now();
      if (now - windowStart > 250) {
        if (suppressed) {
          pre.push([now, "system", "info", `${suppressed} records suppressed (flood guard)`]);
          suppressed = 0;
        }
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > 50) {
        suppressed++;
        return;
      }
      const rec: PreRecord = [now, type, level, msg];
      if (sink) {
        sink(rec);
        return;
      }
      pre.push(rec);
      while (pre.length > 100) {
        pre.shift();
        dropped++;
      }
      failures = 0;
    } catch {
      failures++;
    }
  };

  // ── Tier A ─────────────────────────────────────────────────────────────────
  push("navigation", "info", win.location.href);

  win.addEventListener(
    "error",
    (e: Event) => {
      try {
        // A resource failure fires a plain Event AT the element with no
        // `message`; only the capture phase sees it, which is why Tier A
        // captures. Script errors arrive as ErrorEvent at window.
        const t = e.target as { tagName?: string; src?: string; href?: string } | null;
        if (t && t !== (win as unknown) && typeof t.tagName === "string") {
          push("error", "error", `Failed to load <${t.tagName.toLowerCase()}> ${t.src ?? t.href ?? ""}`);
          return;
        }
        const ev = e as ErrorEvent;
        const head = `${ev.message ?? "Script error"} (${ev.filename ?? ""}:${ev.lineno ?? 0}:${ev.colno ?? 0})`;
        const err = ev.error ? `\n${reduceArg(ev.error)}` : "";
        push("error", "error", `${head}${err}`);
      } catch {
        failures++;
      }
    },
    // We observe; we never preventDefault() — rule 3. And never
    // `window.onerror = …` (rule 4): the host's own handler stays untouched.
    { capture: true, signal },
  );

  win.addEventListener(
    "unhandledrejection",
    (e: Event) => {
      try {
        push("error", "error", `Unhandled rejection: ${reduceArg((e as PromiseRejectionEvent).reason)}`);
      } catch {
        failures++;
      }
    },
    { signal },
  );

  // ── Tier B ─────────────────────────────────────────────────────────────────
  const unwraps: Unwrap[] = [];
  if (opts.early) {
    // Re-entrancy guard (rule 9): while our own recorder runs, every wrapper is
    // a straight pass-through — the redactor and the reducer may touch console.
    let recording = false;
    for (const level of ["error", "warn"] as const) {
      unwraps.push(
        wrap(win.console, level, (prev) => function (this: Console, ...args: unknown[]) {
          // Rule 1: call through FIRST, unconditionally — a throw in our
          // recorder can never precede the host's own handler.
          const out = (prev as (...a: unknown[]) => unknown).apply(this, args);
          if (!recording) {
            recording = true;
            // Format strings (%s, %d) are NOT interpolated — kept verbatim,
            // args appended. Re-implementing console's formatter is a
            // permanent bug source.
            push("console", level, args.map(reduceArg).join(" ").slice(0, 4096));
            recording = false;
          }
          return out;
        }),
      );
    }
  }

  const destroy = (): void => {
    for (const un of unwraps) un();
    unwraps.length = 0;
    sink = null;
    pre.length = 0; // release retained strings (the teardown row)
  };
  signal.addEventListener("abort", destroy, { once: true });

  return {
    drain(next) {
      const records = pre.slice();
      const out = { records, dropped };
      pre.length = 0;
      dropped = 0;
      sink = next;
      return out;
    },
    destroy,
  };
}
