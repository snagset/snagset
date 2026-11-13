/**
 * A site's DOMAIN, borrowed from Faster Fixes's one-field
 * setup: the studio types `acme.com` once and the widget works on
 * `https://acme.com`, `https://staging.acme.com`, `http://preview.acme.com:3000`
 * and on localhost, with no list of origins to maintain. Exact origins stay
 * as "also allowed" for the cases a domain cannot say (a client's separate
 * marketing host, a numbered preview on somebody else's suffix).
 *
 * The rule, and the two boundaries that make it safe:
 *   · the origin's HOSTNAME equals the domain, or ends with "." + domain — a
 *     dot boundary, so `notacme.com` never matches `acme.com`;
 *   · any scheme and any port, because a staging server on :3000 is the same
 *     site as the one on :443, and the client's own site is the trust anchor
 *     (the "scheme and port must match" was written for exact origins,
 *     where a mismatch means a different origin; a domain is a claim about a
 *     host, and the host is what the client owns);
 *   · never a public suffix: `vercel.app` would allow every site on Vercel,
 *     which is the subdomain-takeover class refuses for wildcards.
 */

/** Suffixes shared by strangers — the ones the design names, plus the usual PaaS hosts. */
export const SHARED_SUFFIXES: readonly string[] = [
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "github.io",
  "gitlab.io",
  "workers.dev",
  "ngrok-free.app",
  "ngrok.io",
  "ngrok.app",
  "herokuapp.com",
  "fly.dev",
  "onrender.com",
  "render.com",
  "web.app",
  "firebaseapp.com",
  "azurewebsites.net",
  "azurestaticapps.net",
  "amazonaws.com",
  "cloudfront.net",
  "surge.sh",
  "glitch.me",
  "repl.co",
  "replit.app",
  "webflow.io",
  "framer.app",
  "framer.website",
  "wixsite.com",
  "squarespace.com",
  "myshopify.com",
  "wordpress.com",
  "blogspot.com",
  "github.dev",
  "codesandbox.io",
  "stackblitz.io",
  "localhost",
];

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * What the studio typed → the domain to store, or a sentence.
 * Accepts a bare host or a full address (the hostname is taken), lower-cases,
 * strips a trailing dot and a leading `www.` — `www.acme.com` and `acme.com`
 * are one site, and the shorter one covers both.
 */
export function normaliseDomain(input: string): { domain: string } | { error: string } {
  let raw = input.trim().toLowerCase();
  if (!raw) return { error: "Type the site's domain, like acme.com." };
  if (raw.includes("://")) {
    try {
      raw = new URL(raw).hostname;
    } catch {
      return { error: `${JSON.stringify(input.trim())} is not an address. A domain looks like acme.com.` };
    }
  } else {
    raw = raw.replace(/^\/+/, "").split(/[/?#:]/)[0] ?? "";
  }
  raw = raw.replace(/\.$/, "").replace(/^www\./, "");
  if (raw === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) || raw.startsWith("[")) {
    return { error: "localhost and IP addresses are always allowed while developing — the domain is the site's real host, like acme.com." };
  }
  if (!HOST.test(raw)) return { error: `${JSON.stringify(input.trim())} is not a domain. It looks like acme.com or staging.acme.com.` };
  if (isSharedSuffix(raw)) {
    return {
      error: `${raw} is a host shared by everyone who deploys there. Name your own subdomain (like kilnwork.${raw}) or add the exact address under "Also allowed".`,
    };
  }
  return { domain: raw };
}

/** A bare shared suffix, or a bare top-level label — never a site of its own. */
export function isSharedSuffix(host: string): boolean {
  if (!host.includes(".")) return true;
  return SHARED_SUFFIXES.includes(host);
}

/** Does this browser origin belong to the domain? Any scheme, any port, dot boundary on the host. */
export function originMatchesDomain(domain: string, origin: string): boolean {
  if (!domain) return false;
  let host: string;
  try {
    host = new URL(origin.toLowerCase()).hostname;
  } catch {
    return false;
  }
  return host === domain || host.endsWith("." + domain);
}

/**
 * The developer's own machine, allowed by default:
 * http(s)://localhost[:port], 127.0.0.1, [::1], and *.localhost.
 */
export function isLocalOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin.toLowerCase());
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname;
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]";
}

/**
 * Second-level public suffixes — the country registries that sell names one
 * level down (`acme.co.uk`), where the last two labels are a REGISTRY and not
 * anybody's site. Not the Public Suffix List, which is ten thousand lines and
 * a dependency to keep current; this list only has to be good enough to say
 * "no" to the common ones, because the only thing it gates is the silent
 * member sign-in below, and its failure mode is falling back to the popup.
 */
const SECOND_LEVEL_SUFFIXES: readonly string[] = [
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.jp", "ne.jp", "or.jp", "ac.jp",
  "co.nz", "org.nz", "net.nz",
  "co.za", "org.za",
  "com.br", "net.br", "org.br",
  "com.pt", "org.pt",
  "co.in", "net.in", "org.in",
  "com.cn", "net.cn", "org.cn",
  "com.mx", "com.ar", "com.tr", "com.sg", "com.hk", "com.tw", "co.kr", "co.il", "com.es",
];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const isLocalHost = (h: string): boolean =>
  h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]" || h === "::1";

/**
 * Are these two HOSTNAMES the same site — the browser's "site", the
 * registrable domain, which is what `SameSite` cookies and `Sec-Fetch-Site`
 * are about?: the silent member sign-in only works when the client's
 * page and the dashboard are one site (`acme.studio.dev` and
 * `snagset.studio.dev`), because only then does the browser send the
 * dashboard's `SameSite=Lax` cookie on the widget's fetch at all.
 *
 * CONSERVATIVE BY CONSTRUCTION, and every doubt answers "no":
 *   · the last two labels must be equal — `a.studio.dev` and `b.studio.dev`
 *     yes, `studio.dev` and `other.dev` no;
 *   · and those two labels must not be a suffix shared by strangers. A shared
 *     hosting suffix is NOT one site: two customers' `*.vercel.app` apps are
 *     different sites to every browser (vercel.app is on the Public Suffix
 *     List for exactly this reason), so `Sec-Fetch-Site` would already say
 *     `cross-site` and the cookie would not be sent — but this check is the
 *     second lock on that door, not a reliance on the first. A registry
 *     suffix (`co.uk`) is refused for the same reason: `acme.co.uk` and
 *     `evil.co.uk` share two labels and nothing else. A site under `co.uk`
 *     therefore never gets the silent path; it gets the popup, as any
 *     cross-site page does;
 *   · an IP address is only ever the same site as itself;
 *   · the developer's machine (localhost, `*.localhost`, loopback) is one
 *     site with itself and nothing else — so a localhost page is accepted
 *     only when the server is on localhost too, and never against a real
 *     host.
 */
export function sameSite(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/\.$/, "");
  const y = b.toLowerCase().replace(/\.$/, "");
  if (!x || !y) return false;
  if (isLocalHost(x) || isLocalHost(y)) return isLocalHost(x) && isLocalHost(y);
  if (IPV4.test(x) || IPV4.test(y) || x.includes(":") || y.includes(":")) return x === y;
  const site = (h: string): string | null => {
    const labels = h.split(".");
    if (labels.length < 2 || labels.some((l) => !l)) return null;
    const two = labels.slice(-2).join(".");
    return SHARED_SUFFIXES.includes(two) || SECOND_LEVEL_SUFFIXES.includes(two) ? null : two;
  };
  const sx = site(x);
  return sx !== null && sx === site(y);
}
