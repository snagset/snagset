import type { MiddlewareHandler } from "hono";
import type { Env } from "../app.ts";

/**
 * The JSON body cap, which was registered and enforced by nothing.
 *
 * `SNAGSET_MAX_BODY_BYTES` has been in the config registry now with a
 * 1 MB default, cited by name in two specs, printed by `snagset env` — and read
 * by no code at all. So every JSON route on this server would read whatever it
 * was sent, and the only thing standing between an instance and a body large
 * enough to exhaust its memory was the hosting platform's own proxy, which a
 * self-hoster on their own box does not have.
 *
 * ── THE TWO NUMBERS, AND WHY ONLY ONE IS TUNABLE ──
 *
 * Caps JSON at **256 KB** and says plainly it is *"not operator-
 * tunable"*. Caps binary routes at `SNAGSET_MAX_BODY_BYTES` (1 MB) and
 * that one IS tunable. They are different limits for different reasons: the
 * JSON cap protects the parser, and every JSON body this API accepts is small
 * by construction — a comment, an anchor, a capture context whose breadcrumbs
 * are already truncated server-side. An operator raising it is not configuring
 * the product, they are disabling a bound the wire format does not need.
 *
 * Binary is different: images are ≤ 256 KB by construction, but the ceiling is
 * the operator's because their proxy and their bucket are.
 *
 * ── WHY `Content-Length` AND NOT A COUNTING STREAM ──
 *
 * Rejecting on the declared length is the whole point: it costs nothing and it
 * happens BEFORE the body is read. A stream that counts as it goes has already
 * accepted the bytes it is measuring. A liar who declares 1 KB and sends 10 MB
 * defeats the header check — and is then bounded by the platform's own limit
 * and by the fact that `c.req.json()` throws on a truncated body, which is the
 * same place an unbounded read would have failed anyway. The header check is
 * the cheap 99%, not the security boundary; it exists so an honest client with
 * a runaway payload gets a clean `413` instead of an OOM.
 */

/** And deliberately not `SNAGSET_MAX_BODY_BYTES`. */
export const JSON_BODY_CAP = 256 * 1024;

export function bodyLimit(binaryBytes: () => number): MiddlewareHandler<Env> {
  return async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();

    const declared = Number(c.req.header("content-length") ?? "");
    if (!Number.isFinite(declared) || declared <= 0) return next();

    const type = (c.req.header("content-type") ?? "").toLowerCase();
    const isJson = type.includes("json") || type === "";
    const cap = isJson ? JSON_BODY_CAP : binaryBytes();

    if (declared > cap) {
      return c.json(
        {
          error: {
            code: "body_too_large",
            message: `That request body is ${Math.round(declared / 1024)} KB; the limit here is ${Math.round(cap / 1024)} KB.`,
            requestId: c.get("requestId"),
          },
        },
        413,
      );
    }
    return next();
  };
}
