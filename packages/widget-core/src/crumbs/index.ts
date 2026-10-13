import { PRODUCT, cssClass, hostAttr } from "@snagset/types/names";

/** The three masking hooks, as one selector — built once, not per click. */
const MASKED = `[${hostAttr("mask")}], .${cssClass("mask")}, .${cssClass("block")}`;
import { wrap, type Unwrap } from "../patch.ts";
import { redactText, redactUrl } from "../redact/predicates.ts";
import { redactObject } from "../redact/object.ts";
import type { Breadcrumb } from "../capture/types.ts";
import type { EarlyCrumbs, PreRecord } from "../loader/crumbs-early.ts";

/**
 * snag.crumbs.js — Tier C breadcrumbs, the real buffer, and record-time
 * redaction.
 *
 * The split of responsibilities, because three files now share the word
 * "breadcrumb":
 *
 *   stub (loader/crumbs-early.ts) — Tiers A+B: listeners, two wrapped console
 *     methods, a 100-slot PreBuffer of REDUCED, UNREDACTED strings. Exists
 *     because hydration errors happen before any reviewer activates.
 *   THIS CHUNK — Tier C sources (console.log/info/debug, fetch, XHR,
 *     navigation, clicks), the byte-budgeted BreadcrumbBuffer, the bounded
 *     serializer, and the ONE place redaction happens: on the way into
 *     the buffer. It seeds itself from the stub's backlog and then
 *     becomes the stub's sink, so post-activation Tier A/B records flow through
 *     the same redaction gate as everything else.
 *   capture chunk — consumes `drain()` at T0 and puts the result on
 *     `CaptureContext.breadcrumbs`. It never redacts breadcrumbs; .7
 *     there is nothing left to redact.
 *
 * Everything that wraps a host global goes through the registry — this
 * chunk bundles its own copy of that module (self-containment) and the
 * copies coordinate through `Symbol.for()`, so the stub's Tier B wrapper and
 * this chunk's Tier C wrappers unwind independently and correctly.
 */

// ── — the bounded serializer ──────────────────────────────────────────
// Used for Tier C console arguments and `Breadcrumb.data` values. NOT in the
// stub (the stub's reducer is). Every bound in the table, enforced.

const LEAF_MAX = 256;
const TOTAL_MAX = 2048;

export function serialise(v: unknown, depth = 3, budget = TOTAL_MAX): string {
  const t0 = performance.now();
  const seen = new Set<object>();
  let nodes = 0;

  const go = (x: unknown, d: number): string => {
    // A Proxy or exotic object that drags — abort the whole walk (the 2 ms
    // rule). The first few nodes are exempt: a cold VM spends more than 2 ms
    // JIT-ing this very function on its first run, and "[unserialisable]" for
    // an ordinary object on the session's first breadcrumb is a lie. A hostile
    // Proxy has many properties by nature, so the walk that matters always
    // crosses the warm-up threshold.
    if (++nodes > 8 && performance.now() - t0 > 2) return "[unserialisable]";
    try {
      if (typeof x === "string") return x.length > LEAF_MAX ? `${x.slice(0, LEAF_MAX)}…` : x;
      if (x === null || x === undefined || typeof x === "number" || typeof x === "boolean") return String(x);
      if (typeof x === "bigint" || typeof x === "symbol") return String(x);
      if (typeof x === "function") return `[Function ${x.name || "anonymous"}]`;
      const o = x as Record<string, unknown>;
      if (x instanceof Error || (typeof o.name === "string" && typeof o.message === "string" && "stack" in o)) {
        const stack = typeof o.stack === "string" ? o.stack.split("\n").slice(0, 10).join("\n") : "";
        return `${String(o.name)}: ${String(o.message)}${stack ? `\n${stack}` : ""}`.slice(0, TOTAL_MAX);
      }
      if (typeof Response !== "undefined" && x instanceof Response) return `[Response ${x.status}]`;
      if (typeof Request !== "undefined" && x instanceof Request) return `[Request ${x.method} …]`;
      if (typeof Node !== "undefined" && x instanceof Node) {
        const el = x as Element;
        const id = el.id ? `#${el.id}` : "";
        const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/)[0]}` : "";
        return `<${(el.tagName ?? x.nodeName ?? "node").toLowerCase()}${id}${cls}>`;
      }
      if (seen.has(x as object)) return "[Circular]";
      seen.add(x as object);
      if (Array.isArray(x)) {
        if (d <= 0) return `[Array(${x.length})]`;
        const items = x.slice(0, 10).map((i) => go(i, d - 1));
        if (x.length > 10) items.push(`…+${x.length - 10} more`);
        return `[${items.join(", ")}]`;
      }
      if (d <= 0) return "[Object]";
      const keys = Object.keys(o);
      const parts: string[] = [];
      for (const k of keys.slice(0, 20)) {
        let val: string;
        try {
          val = go(o[k], d - 1);
        } catch {
          val = "[throws]"; // per-property try/catch — a hostile getter costs one key
        }
        parts.push(`${k}: ${val}`);
      }
      if (keys.length > 20) parts.push(`…+${keys.length - 20} more`);
      return `{${parts.join(", ")}}`;
    } catch {
      return "[unserialisable]";
    }
  };

  const out = go(v, depth);
  return out.length > budget ? `${out.slice(0, budget)}…` : out;
}

// ── — the real buffer ──────────────────────────────────────────────────

/** The caps for the two breadcrumb fields. Pre-cap bounds the regex work;
 *  post-cap bounds the stored bytes; redaction runs between them so a secret
 *  is never cut in half with its head left in clear. */
const MSG_PRECAP = 4096;
const MSG_CAP = 512;

/** UTF-8 over-estimate in one scan: code units + 2 per non-ASCII unit. The
 *  consequence of over-counting is a buffer holding slightly LESS than 64 KB,
 *  which is the safe direction. */
function sizeOf(b: Breadcrumb): number {
  const s = JSON.stringify(b);
  let extra = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) extra += 2;
  return s.length + extra;
}

function cap(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max}]` : s;
}

export class BreadcrumbBuffer {
  private buf: Breadcrumb[] = [];
  private sizes: number[] = [];
  private bytes = 0;
  private droppedCount = 0;
  private maxEntries: number;
  private maxBytes: number;

  constructor(maxEntries = 100, maxBytes = 65_536) {
    // The design is a ceiling, not a default a config can raise past.
    this.maxEntries = Math.min(maxEntries, 100);
    this.maxBytes = Math.min(maxBytes, 65_536);
  }

  /** `b` is ALREADY redacted — this class never touches content. */
  push(b: Breadcrumb): void {
    let size = sizeOf(b);
    if (size > this.maxBytes >> 2) {
      // One entry may not own more than a quarter of the buffer.
      b = { ...b, message: cap(b.message, 1024) };
      delete b.data;
      size = sizeOf(b);
    }
    // De-dupe: identical (type, level, message) within 1000 ms bumps a counter
    // instead of storing a copy. This is what stops a console.log inside a
    // render loop from flushing the whole buffer in 200 ms — and because it
    // compares REDACTED messages, two lines differing only in a token collapse
    // too, which is strictly better (consequence 3).
    const last = this.buf[this.buf.length - 1];
    if (
      last &&
      last.type === b.type &&
      last.level === b.level &&
      last.message === b.message &&
      Date.parse(b.t) - Date.parse(last.t) < 1000
    ) {
      const n = ((last.data?.count as number) ?? 1) + 1;
      const prev = this.sizes[this.sizes.length - 1]!;
      last.data = { ...last.data, count: Math.min(n, 1000) };
      last.t = b.t;
      const next = sizeOf(last);
      this.sizes[this.sizes.length - 1] = next;
      this.bytes += next - prev;
      return;
    }
    this.buf.push(b);
    this.sizes.push(size);
    this.bytes += size;
    while (this.buf.length > this.maxEntries || this.bytes > this.maxBytes) {
      this.buf.shift();
      this.bytes -= this.sizes.shift()!;
      this.droppedCount++;
    }
  }

  /** Pre-activation losses (the stub's own ring) count toward the same notice. */
  noteDropped(n: number): void {
    if (n > 0) this.droppedCount += n;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /** ≤ 1 ms: a copy, no redaction — the design moved all the work to record time. */
  drain(): Breadcrumb[] {
    const out = this.buf.slice();
    if (this.droppedCount > 0) {
      out.unshift({
        t: out[0]?.t ?? new Date().toISOString(),
        type: "system",
        level: "info",
        message: `${NOTICE} ${this.droppedCount} earlier breadcrumbs dropped (buffer limit)`,
      });
    }
    return out;
  }

  clear(): void {
    // Releases every retained string (the teardown row).
    this.buf.length = 0;
    this.sizes.length = 0;
    this.bytes = 0;
  }
}

// Composed, never typed — the design forbids a literal product name under src/,
// and the design fixes the notice spelling as the lower-case bracketed form.
const NOTICE = `[${PRODUCT.toLowerCase()}]`;

// ── Tier C installation ─────────────────────────────────────────────────────

export interface TierCConfig {
  console?: boolean;
  consoleLevels?: ("log" | "info" | "warn" | "error")[];
  network?: boolean;
  navigation?: boolean;
  clicks?: boolean;
  maxEntries?: number;
  maxBytes?: number;
}

export interface TierCOptions {
  win?: Window & typeof globalThis;
  /** The stub's Tier A/B backlog. Seeded through redaction, then re-sunk here. */
  early?: EarlyCrumbs;
  config?: TierCConfig;
  /** Self-traffic filter: requests to this origin are never
   *  recorded — they would be noise carrying the bearer session. */
  backendOrigin?: string;
  /** 02 owns navigation detection; we subscribe. Returns unsubscribe. */
  subscribeNav?: (fn: (from: string, to: string) => void) => () => void;
}

export interface CrumbsHandle {
  /** The buffer at T0 — already redacted, ready for `CaptureContext.breadcrumbs`. */
  drain(): Breadcrumb[];
  /** The honest status for the category. */
  status(): "ok" | "truncated";
  /** Widget-internal `system` notices (capture degraded, chunk missing…). */
  note(message: string): void;
  destroy(): void;
}

export function installTierC(opts: TierCOptions = {}): CrumbsHandle {
  const win = opts.win ?? (window as Window & typeof globalThis);
  const cfg = opts.config ?? {};
  const buffer = new BreadcrumbBuffer(cfg.maxEntries ?? 100, cfg.maxBytes ?? 65_536);
  const ac = new AbortController();
  const unwraps: Unwrap[] = [];
  const unsubs: (() => void)[] = [];
  // Re-entrancy guard: our own recorder, the redactor and the
  // serializer may touch console or fetch; while recording, every wrapper is a
  // straight pass-through.
  let recording = false;
  let overBudgetNoted = false;

  /**
   * THE redaction gate: pre-cap → redact → post-cap, under a 4 ms
   * per-record budget. A record that blows the budget is truncated harder and
   * a `system` breadcrumb says so, once — amortising the cost across the
   * session is the whole reason redaction moved off the drain path.
   */
  const record = (
    type: Breadcrumb["type"],
    level: Breadcrumb["level"],
    message: string,
    data?: Record<string, unknown>,
  ): void => {
    if (recording) return;
    recording = true;
    try {
      const t0 = performance.now();
      let msg = cap(redactText(message.slice(0, MSG_PRECAP)), MSG_CAP);
      const red = data ? (redactObject(data) as Record<string, unknown>) : undefined;
      if (performance.now() - t0 > 4) {
        msg = cap(msg, 256);
        if (!overBudgetNoted) {
          overBudgetNoted = true;
          buffer.push({
            t: new Date().toISOString(),
            type: "system",
            level: "info",
            message: `${NOTICE} a breadcrumb exceeded the redaction budget and was truncated`,
          });
        }
      }
      const b: Breadcrumb = { t: new Date().toISOString(), type, message: msg };
      if (level) b.level = level;
      if (red && Object.keys(red).length) b.data = red;
      buffer.push(b);
    } catch {
      /* rule 2 — a recorder failure emits nothing and never reaches host code */
    }
    recording = false;
  };

  // ── Seed from the stub's backlog ("the activation backlog") ──────────
  const seedOne = ([t, type, level, msg]: PreRecord): void => {
    const lv = level === "log" || level === "info" || level === "warn" || level === "error" ? level : "info";
    try {
      const message =
        type === "navigation" ? redactUrl(msg.slice(0, MSG_PRECAP)) : cap(redactText(msg.slice(0, MSG_PRECAP)), MSG_CAP);
      buffer.push({ t: new Date(t).toISOString(), type, level: lv, message });
    } catch {
      /* one bad record is one bad record */
    }
  };
  if (opts.early) {
    const { records, dropped } = opts.early.drain((rec) => seedOne(rec));
    buffer.noteDropped(dropped);
    // Chunked, off the critical path: ≤ 100 entries in ≤ 4 ms slices. The
    // slices run as macrotasks so a slow redaction cannot janken activation.
    let i = 0;
    const slice = (): void => {
      const t0 = performance.now();
      while (i < records.length && performance.now() - t0 < 4) seedOne(records[i++]!);
      if (i < records.length) win.setTimeout(slice, 0);
    };
    slice();
  }

  // ── Tier C: console.log/info/debug ─────────────────────────────────
  const levels = cfg.consoleLevels ?? ["log", "info", "warn", "error"];
  if (cfg.console !== false) {
    for (const m of ["log", "info", "debug"] as const) {
      const lv = m === "debug" ? "info" : m; // Debug → 'info'
      if (!levels.includes(lv)) continue;
      unwraps.push(
        wrap(win.console, m, (prev) => function (this: Console, ...args: unknown[]) {
          const out = (prev as (...a: unknown[]) => unknown).apply(this, args);
          record("console", lv, args.map((a) => serialise(a)).join(" "));
          return out;
        }),
      );
    }
  }

  // ── Tier C: network (binding rules 5–8 and 10) ──────────────────────
  const selfTraffic = (url: string): boolean => {
    if (!opts.backendOrigin) return false;
    try {
      return new URL(url, win.location.href).origin === opts.backendOrigin;
    } catch {
      return false;
    }
  };

  if (cfg.network !== false) {
    unwraps.push(
      wrap(win as unknown as { fetch: typeof fetch }, "fetch", (prev) => function (this: unknown, ...args: unknown[]) {
        const t0 = performance.now();
        let method = "GET";
        let url = "";
        try {
          const input = args[0] as string | URL | Request;
          url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          method = ((args[1] as RequestInit | undefined)?.method ?? (input as Request).method ?? "GET").toUpperCase();
        } catch {
          /* metadata only — never fail the request over it */
        }
        const p = (prev as typeof fetch).apply(this, args as Parameters<typeof fetch>);
        if (selfTraffic(url)) return p;
        // Rule 5: return the DERIVED promise and rethrow on the rejection arm.
        // Attaching handlers to the original and returning it would mark it
        // handled and silently kill the host's own unhandledrejection
        // reporting. Cost: one microtask tick per fetch; measured < 0.01 ms.
        return p.then(
          (res) => {
            // Rule 6: status/ok/url/type/redirected are metadata reads and do
            // not consume the stream. Bodies and headers are never touched.
            record("network", res.ok ? "info" : "error", `${method} ${redactUrl(res.url || url)} → ${res.status}`, {
              method,
              url: redactUrl(res.url || url),
              status: res.status,
              ok: res.ok,
              type: res.type,
              redirected: res.redirected,
              duration_ms: Math.round(performance.now() - t0),
            });
            return res;
          },
          (err: unknown) => {
            const aborted = (err as { name?: string } | null)?.name === "AbortError";
            record("network", aborted ? "info" : "error", `${method} ${redactUrl(url)} failed`, {
              method,
              url: redactUrl(url),
              duration_ms: Math.round(performance.now() - t0),
              aborted,
            });
            throw err;
          },
        );
      }),
    );

    // Rule 8: prototypes, never the constructor — replacing window.XMLHttpRequest
    // breaks `instanceof` for host code and for other instrumentation. Metadata
    // lives in a WeakMap, not on the instance (no collisions, no strong refs).
    const meta = new WeakMap<XMLHttpRequest, { method: string; url: string; t0: number }>();
    const XP = win.XMLHttpRequest?.prototype;
    if (XP) {
      unwraps.push(
        wrap(XP, "open", (prev) => function (this: XMLHttpRequest, ...args: unknown[]) {
          try {
            meta.set(this, { method: String(args[0] ?? "GET").toUpperCase(), url: String(args[1] ?? ""), t0: 0 });
          } catch {
            /* recording is best-effort */
          }
          return (prev as (...a: unknown[]) => unknown).apply(this, args);
        }),
      );
      unwraps.push(
        wrap(XP, "send", (prev) => function (this: XMLHttpRequest, ...args: unknown[]) {
          const m = meta.get(this);
          if (m && !selfTraffic(m.url)) {
            m.t0 = performance.now();
            this.addEventListener(
              "loadend",
              () => {
                record("network", this.status >= 400 || this.status === 0 ? "error" : "info",
                  `${m.method} ${redactUrl(m.url)} → ${this.status}`, {
                    method: m.method,
                    url: redactUrl(m.url),
                    status: this.status,
                    duration_ms: Math.round(performance.now() - m.t0),
                  });
              },
              { once: true, signal: ac.signal },
            );
          }
          return (prev as (...a: unknown[]) => unknown).apply(this, args);
        }),
      );
    }
  }

  // ── Tier C: navigation — subscribed, never patched ─────────────────
  // 02 owns SPA navigation detection; a second history patch here is exactly
  // the double-instrumentation the one-registry rule exists to prevent.
  if (cfg.navigation !== false && opts.subscribeNav) {
    unsubs.push(
      opts.subscribeNav((from, to) => {
        record("navigation", "info", `${redactUrl(from)} → ${redactUrl(to)}`, {
          from: redactUrl(from),
          to: redactUrl(to),
        });
      }),
    );
  }

  // ── Tier C: document clicks ────────────────────────────────────────
  if (cfg.clicks !== false) {
    let lastClick = 0;
    win.document.addEventListener(
      "click",
      (e: MouseEvent) => {
        try {
          const now = performance.now();
          if (now - lastClick < 100) return; // max one per 100 ms
          lastClick = now;
          const el = e.target as Element | null;
          if (!el || typeof el.closest !== "function") return;
          // Masked elements produce a stub crumb with NO identifying detail.
          // `data-snag-ignore` is deliberately not consulted: it means "do not
          // anchor to this", not "do not observe this".
          if (el.closest(MASKED)) {
            record("click", undefined, "click [masked]");
            return;
          }
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role") ?? "";
          const name = (el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? "")
            .trim()
            .slice(0, 80);
          const testId = el.getAttribute("data-testid") ?? "";
          const id = el.id ? `#${el.id}` : "";
          const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/)[0]}` : "";
          record("click", undefined, `click <${tag}${id}>${name ? ` "${name}"` : ""}`, {
            tag,
            ...(role ? { role } : {}),
            ...(testId ? { testId } : {}),
            selector: `${tag}${id}${cls}`,
          });
        } catch {
          /* rule 2 */
        }
      },
      // Capture + passive: we observe host clicks; we never delay or consume
      // them. In review mode the shield is the target, so these mostly record
      // the reviewer toggling OUT to reproduce something.
      { capture: true, passive: true, signal: ac.signal },
    );
  }

  return {
    drain: () => buffer.drain(),
    status: () => (buffer.dropped > 0 ? "truncated" : "ok"),
    note: (message) => record("system", "info", `${NOTICE} ${message}`),
    destroy() {
      ac.abort(); // every listener, atomically (the matrix row 4)
      for (const un of unwraps) un(); // identity-based restore per wrapper
      unwraps.length = 0;
      for (const un of unsubs) un();
      unsubs.length = 0;
      buffer.clear();
    },
  };
}
