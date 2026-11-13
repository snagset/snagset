import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";

/**
 * Fetch an image from the public internet, and from nowhere else — the image
 * proxy's half on the server (D-image-proxy, found reviewing Acme).
 *
 * A server that fetches a URL a browser hands it is a server that can be
 * pointed at itself: `http://localhost:5432`, the cloud metadata address
 * `169.254.169.254`, a database on the private network beside it. So the
 * check is on the ADDRESS, not the name, and it happens at connect time,
 * inside the socket's own DNS lookup: checking the name first and connecting
 * afterwards is exactly the gap DNS rebinding drives through, because the
 * second resolution can answer differently from the first. Redirects are
 * followed by hand for the same reason — each hop is a new connection and
 * gets the same check.
 *
 * Node's built-in BlockList, not a dependency: the ranges are short, fixed
 * and RFC-numbered, and a parser library is one more thing on the path of
 * every request this route serves.
 */

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, and the cloud metadata address in it
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64, which can reach an IPv4 private address
  ["64:ff9b:1::", 48], // NAT64 local use
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv6");
}
// NOT `::ffff:0:0/96`. Node's BlockList matches an IPv4 address against an
// IPv4-mapped IPv6 subnet, so that one line blocked the whole IPv4 internet —
// found by the test that expects 8.8.8.8 to be public. Mapped addresses are
// unwrapped and judged as IPv4 in isPublicAddress instead.

/** True when an address is one the proxy may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED.check(address, "ipv4");
  if (family === 6) {
    // `::ffff:10.0.0.1` is 10.0.0.1. Judged as what it reaches, not as what
    // it is written as — the IPv6 range alone would say only "mapped".
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mapped) return !BLOCKED.check(mapped, "ipv4");
    return !BLOCKED.check(address, "ipv6");
  }
  return false;
}

export type PublicFetchCode =
  | "bad_url"
  | "blocked_address"
  | "not_an_image"
  | "too_large"
  | "upstream"
  | "timeout"
  | "too_many_redirects";

export class PublicFetchError extends Error {
  // Assigned in the body: the server runs under --experimental-strip-types,
  // which has no parameter properties.
  readonly code: PublicFetchCode;
  constructor(code: PublicFetchCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PublicFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  /** Tests only: a local test server is a private address on a random port. */
  allowPrivate?: boolean;
}

const PORTS = new Set(["", "80", "443"]);

export async function fetchPublicImage(
  raw: string,
  opts: PublicFetchOptions,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PublicFetchError("bad_url", "That is not a URL.");
  }
  const deadline = Date.now() + opts.timeoutMs;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new PublicFetchError("bad_url", "Only http and https images can be fetched.");
    }
    // Credentials in a URL are someone's, and nothing an image needs. A port
    // beyond the web's two is how "fetch this image" becomes "probe this
    // service" — the allowed origin's images are served on 80 and 443.
    if (url.username || url.password || (!opts.allowPrivate && !PORTS.has(url.port))) {
      throw new PublicFetchError("bad_url", "Only images on the standard web ports can be fetched.");
    }
    const res = await request(url, deadline, opts);
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = new URL(res.location, url);
      continue;
    }
    if (res.status !== 200) throw new PublicFetchError("upstream", `The image's server answered ${res.status}.`);
    return { bytes: res.bytes!, contentType: res.contentType! };
  }
  throw new PublicFetchError("too_many_redirects", "The image redirected too many times.");
}

function guardedLookup(allowPrivate: boolean) {
  return (
    hostname: string,
    options: object,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      // EVERY answer, not the first: a name that resolves to one public and
      // one private address would otherwise be a coin toss on which the
      // socket picks.
      if (!allowPrivate && (list.length === 0 || !list.every((a) => isPublicAddress(a.address)))) {
        return callback(Object.assign(new Error("blocked_address"), { code: "EBLOCKED" }), []);
      }
      const all = (options as { all?: boolean }).all;
      if (all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

function request(
  url: URL,
  deadline: number,
  opts: PublicFetchOptions,
): Promise<{ status: number; location?: string; bytes?: Uint8Array; contentType?: string }> {
  const lib = url.protocol === "https:" ? https : http;
  // A literal IP skips DNS, so it is checked here instead.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!opts.allowPrivate && isIP(host) && !isPublicAddress(host)) {
    return Promise.reject(new PublicFetchError("blocked_address", "That address is not on the public internet."));
  }
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new PublicFetchError("timeout", "The image took too long."));
    const req = lib.get(
      url,
      {
        lookup: guardedLookup(!!opts.allowPrivate) as never,
        timeout: remaining,
        headers: { accept: "image/*", "user-agent": "Snagset image proxy (+https://snagset.com)" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, ...(res.headers.location ? { location: res.headers.location } : {}) });
        }
        if (status !== 200) {
          res.resume();
          return resolve({ status });
        }
        const contentType = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        // An image or nothing. The proxy exists to put pixels in a canvas; a
        // page, a script or a JSON document has no business coming back.
        if (!contentType.startsWith("image/")) {
          res.destroy();
          return reject(new PublicFetchError("not_an_image", `Expected an image; got "${contentType || "nothing"}".`));
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > opts.maxBytes) {
          res.destroy();
          return reject(new PublicFetchError("too_large", "The image is larger than the proxy carries."));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          // Counted as it arrives: a Content-Length can be absent or a lie.
          if (size > opts.maxBytes) {
            res.destroy();
            reject(new PublicFetchError("too_large", "The image is larger than the proxy carries."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, bytes: new Uint8Array(Buffer.concat(chunks)), contentType }));
        res.on("error", (e) => reject(new PublicFetchError("upstream", e.message)));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new PublicFetchError("timeout", "The image took too long."));
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EBLOCKED" || e.message === "blocked_address") {
        reject(new PublicFetchError("blocked_address", "That address is not on the public internet."));
      } else if (!(e instanceof PublicFetchError)) {
        reject(new PublicFetchError("upstream", e.message));
      } else reject(e);
    });
  });
}
