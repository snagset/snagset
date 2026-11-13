import { isSensitiveKey, redactText, redactUrl } from "./predicates.ts";

/**
 * `redactObject` — the rule for `Breadcrumb.data` (v0.1) and, later,
 * `CaptureContext.custom` (v1): **key-first, then `redactText` on every leaf,
 * URL-shaped leaves via `redactUrl`**.
 *
 * Key-first matters because the value under a bad key is often innocent-LOOKING
 * — `{ password: "hunter2" }` has a value no shape rule would flag, and the key
 * is the only evidence. When the key condemns it, the whole value goes,
 * whatever its type: an object under `credentials:` is not walked for salvage.
 *
 * A SEPARATE FILE from predicates.ts, deliberately: the runtime re-exports the
 * three predicate functions as resident surface (residency), and keeping
 * the walker out of that module means its bytes can never ride into the
 * activation envelope on the strength of a re-export. Chunks that need it —
 * crumbs, capture — bundle it from this one source.
 *
 * Depth and size discipline belongs to the SERIALIZER — by the time
 * data reaches here it is already bounded. The walker still carries its own
 * depth stop so a caller who skips the serializer cannot make it spin.
 */

const URLISH = /^https?:\/\//i;
const MARK = "[redacted]";

export function redactObject(v: unknown, depth = 4): unknown {
  if (typeof v === "string") return URLISH.test(v) ? redactUrl(v) : redactText(v);
  if (v === null || typeof v !== "object") return v; // numbers, booleans, undefined pass
  if (depth <= 0) return MARK; // deeper than the serializer allows — refuse, don't trust
  if (Array.isArray(v)) return v.map((item) => redactObject(item, depth - 1));

  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? MARK : redactObject(val, depth - 1);
  }
  return out;
}
