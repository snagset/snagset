import type { Context, MiddlewareHandler } from "hono";

/**
 * Who is calling — the one answer every per-caller count is keyed on.
 *
 * `SNAGSET_TRUST_PROXY` is the number of proxy hops to trust in
 * `X-Forwarded-For`, and `0` means the header is ignored entirely. Until
 * 2026-11-12 the variable was registered and read by nothing: five routes
 * each took the header's FIRST entry, always, which is the one entry the
 * caller writes. A limit keyed on that is a limit the caller resets by
 * sending a different header — or spends on somebody else's address.
 *
 * So: with `0` hops the address is the connection's own. With `n`, it is the
 * entry `n` from the right of the header — each trusted proxy appended the
 * address it saw, so the rightmost `n` are theirs to vouch for and everything
 * to the left of them is the caller's own say-so. A header with fewer entries
 * than hops is a deployment whose number is wrong; its leftmost entry is the
 * best there is. No header at all falls back to the connection.
 *
 * `X-Real-IP` is not read: nothing here can tell a proxy's from a caller's.
 *
 * An IPv6 caller is counted by its /64 — the unit an access network hands
 * one subscriber, who otherwise has 2^64 addresses to be a different caller
 * with. An IPv4 address mapped into IPv6 (`::ffff:203.0.113.7`, what a
 * dual-stack socket reports) is its IPv4 self.
 *
 * `"local"` when nothing is known: a request made in-process with no header,
 * or a platform with no socket and no trusted hop. All such callers share one
 * count, which is the honest reading of "we cannot tell them apart".
 */
export const UNKNOWN_CALLER = "local";

export function resolveCaller(forwarded: string | undefined | null, socket: string | undefined | null, hops: number): string {
  let raw = "";
  if (hops > 0 && forwarded) {
    const list = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) raw = list[Math.max(0, list.length - hops)]!;
  }
  if (!raw) raw = (socket ?? "").trim();
  return raw ? normalise(raw) : UNKNOWN_CALLER;
}

/**
 * Lower-cased, unbracketed, without a port or a zone; an IPv4 written inside
 * an IPv6 (mapped, in any spelling, or NAT64) as that IPv4; any other IPv6 as
 * its /64. Anything that is not an address is kept as sent, capped: still one
 * key per string.
 */
function normalise(raw: string): string {
  let a = raw.toLowerCase().slice(0, 100);
  if (a.startsWith("[")) a = a.slice(1, a.indexOf("]") > 0 ? a.indexOf("]") : undefined);
  const zone = a.indexOf("%");
  if (zone > 0) a = a.slice(0, zone);
  // `203.0.113.7:51234` — some proxies write the port, and a port is a new
  // caller per connection if it is left in.
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(a);
  if (v4) return v4[1]!;
  if (!a.includes(":") || !/^[0-9a-f:.]+$/.test(a)) return a;

  // Eight groups, with `::` written out and a dotted tail as its two groups.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (dotted) {
    const [, head, b1, b2, b3, b4] = dotted as unknown as [string, string, string, string, string, string];
    a = `${head}${((Number(b1) << 8) | Number(b2)).toString(16)}:${((Number(b3) << 8) | Number(b4)).toString(16)}`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return a;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = (halves.length === 1 ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]).map((g) => g.replace(/^0+(?=.)/, ""));
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return a;
  const tail4 = (): string => {
    const hi = parseInt(groups[6]!, 16);
    const lo = parseInt(groups[7]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  };
  const zeros = (n: number) => groups.slice(0, n).every((g) => g === "0");
  // ::ffff:a.b.c.d and ::ffff:0:a.b.c.d (mapped, translated), 64:ff9b::a.b.c.d (NAT64).
  if (zeros(5) && groups[5] === "ffff") return tail4();
  if (zeros(4) && groups[4] === "ffff" && groups[5] === "0") return tail4();
  if (groups[0] === "64" && groups[1] === "ff9b" && groups.slice(2, 6).every((g) => g === "0")) return tail4();
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** Works the caller out once per request; every route reads the same answer with `callerOf`. */
/**
 * What the log says, once, when a request carries `X-Forwarded-For` and the
 * setting is 0. A proxy in front that nobody told the server about is the
 * usual reason, and then every visitor is counted as the proxy: one caller,
 * sharing each per-caller limit. The header can also be a caller's own
 * invention on a server with nothing in front, so this says "if", changes
 * nothing about how the caller is worked out, and is said once per process
 * so that nobody can fill a log with it.
 */
export const FORGOTTEN_PROXY =
  "warn  A request arrived with an X-Forwarded-For header and SNAGSET_TRUST_PROXY is 0, so the header was ignored. " +
  "If a proxy stands in front of this server (nginx, Caddy, Traefik, Coolify, a load balancer, Cloudflare), every visitor is being counted as ONE caller " +
  "against the sign-in, sign-up, invite and reset limits: set SNAGSET_TRUST_PROXY to the number of proxies (usually 1). " +
  "If nothing stands in front, a caller wrote the header itself and ignoring it is right.";

export function callerMiddleware(hops: () => number, warn: (line: string) => void = console.warn): MiddlewareHandler {
  let said = false;
  return async (c, next) => {
    // `@hono/node-server` passes the Node request as `env.incoming`; a
    // platform that hands over only a `Request` has no socket to ask.
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    const forwarded = c.req.header("x-forwarded-for");
    const n = hops();
    if (!said && n === 0 && forwarded) {
      said = true;
      warn(FORGOTTEN_PROXY);
    }
    c.set("caller" as never, resolveCaller(forwarded, incoming?.socket?.remoteAddress, n) as never);
    return next();
  };
}

/** The caller the middleware worked out; `"local"` on an app mounted without it (a route under test on its own). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function callerOf(c: Context<any>): string {
  return (c.get("caller") as string | undefined) ?? UNKNOWN_CALLER;
}
