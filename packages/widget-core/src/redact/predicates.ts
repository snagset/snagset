import { RESERVED_URL_PARAMS } from "@snagset/types/names";

/**
 * The redaction module.
 *
 * "Redaction is not optional and cannot be disabled — only *extended*.
 * There is no `redact: false`." v0 ships `redactText`, `redactUrl`, every shape
 * rule .3 and `isSensitiveValue` — because `CaptureContext.url` needs the
 * first two and the selector generation needs the third. `redactObject` and the
 * record-time pipeline arrive with breadcrumbs in v0.1.
 *
 * ── Why this file lives in the RUNTIME chunk ──
 *
 * The design says the module lives in `snag.capture.js`. It cannot at v0:
 * tags that artefact v0.1 so it does not exist, forbids activation
 * fetching any capture chunk, and the `createElementAnchor` calls
 * `isSensitiveValue` SYNCHRONOUSLY at pin time so it cannot await an import.
 * Rules on it: "One copy, in snag.runtime.js; snag.capture.js
 * imports from it." The spec edit that records the inversion is still owed.
 *
 * ── The one thing to know before editing ──
 *
 * Every constant below carries `/g`, and `RegExp.prototype.test` on a global
 * regex is STATEFUL — it advances `lastIndex` and the next call starts from
 * there. `isSensitiveValue` is called once per candidate attribute per element,
 * so a naive `EMAIL.test(v)` returns true, then false, then true on identical
 * input. `hits()` exists for exactly that reason.
 */

/**
 * The key vocabulary, byte-for-byte.
 *
 * "if the two ever differ, 00 wins." `pin` and `sig` are DELIBERATELY
 * absent — the design gives the reason, and adding them is not a fix.
 */
const KEY =
  `pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|auth(?:orization)?|` +
  `credential|session|sid|cookie|jwt|bearer|otp|mfa|totp|cvv|cvc|ssn|nino|iban|` +
  `card(?:[_-]?number)?|account[_-]?number|private[_-]?key|signature|` +
  `client[_-]?secret|refresh[_-]?token|access[_-]?token`;

/**
 * key = value, in any of the shapes real payloads use., verbatim.
 *
 * THE LEADING BOUNDARY IS A LOOKBEHIND, NOT `\b`. `_` is a word character, so
 * `\b` finds no boundary between the `B` and the `P` of `DB_PASSWORD` and the
 * whole snake_case convention was invisible to this rule: `db_password=…`,
 * `oauth_token=…`, `csrf_token=…`, `app_secret=…` and every SCREAMING_SNAKE
 * environment variable came back byte-identical, while the bare `password=…`
 * and the hyphenated `X-API-KEY=…` were redacted correctly. `refresh_token`,
 * `access_token`, `client_secret`, `api_key`, `private_key`, `card_number` and
 * `account_number` escaped only because KEY happens to spell those exact
 * compounds out. `(?<![A-Za-z0-9])` allows a preceding `_`, `-`, `.`, quote,
 * space or start-of-string and still refuses a letter or digit, so `mypassword`
 * stays unmatched exactly as `\b` intended.
 *
 * Group 1 is the optional quote BEFORE the key; group 2 is the value's opening
 * quote; group 3 the quoted value body; group 4 the unquoted value. The only
 * backreference in the whole rule set is this one's `\2`, which is deliberate:
 * The design makes catastrophic backtracking a hard review criterion, because it
 * is a denial of service on the reviewer's own main thread.
 */
const KV = new RegExp(
  `(["'\`]?)(?<![A-Za-z0-9])(?:${KEY})[\\w-]*\\b\\1?\\s*[:=]\\s*` +
    `(?:(["'\`])((?:\\\\.|(?!\\2)[^\\\\])*)\\2|([^\\s,;&}\\])]{3,}))`,
  "gi",
);

/** The auth schemes AUTH_SCHEME knows. Used by the carve-out below. */
const SCHEME_WORD = /^(?:Bearer|Basic|Digest|Negotiate|Token)$/i;

/**
 * Replace the VALUE and keep everything else — the key, the separator, the
 * whitespace and the quotes. A redaction that ate the key name would destroy
 * the one part of the pair that is diagnostic rather than secret.
 *
 * THE CARVE-OUT, and the leak that forced it. KV's unquoted-value branch stops
 * at whitespace, so on the single most canonical secret in existence —
 *
 *     Authorization: Bearer abcdefgh12345
 *
 * — it matched the key `Authorization`, took `Bearer` as the whole value, and
 * emitted `Authorization: [redacted] abcdefgh12345`. The word was redacted and
 * THE TOKEN WAS PUBLISHED. AUTH_SCHEME could no longer help, because the scheme
 * it keys on had just been replaced. Found by running the rules rather than
 * reading them, which is what the own preamble asks for.
 *
 * So AUTH_SCHEME runs first (see redactText), and KV then leaves a scheme word
 * alone *only when the credential after it is already gone*. Both halves are
 * needed: skipping unconditionally would let `Bearer abc` — too short for
 * AUTH_SCHEME's 8-char floor — survive untouched, which is worse than the bug.
 */
const kvReplace = (
  m: string,
  _q0: string,
  q: string,
  qv: string,
  uv: string,
  offset: number,
  whole: string,
): string => {
  if (!q && SCHEME_WORD.test(uv) && whole.slice(offset + m.length).startsWith(" [redacted]")) {
    return m;
  }
  /**
   * IDEMPOTENCE. The unquoted-value class `[^\s,;&}\])]{3,}` excludes `]`, so
   * against an already-redacted `token=[redacted]` it matches `[redacted`,
   * substitutes `[redacted]`, and strands the original bracket — producing
   * `token=[redacted]]`. Found end-to-end: `redactUrl` redacts structurally and
   * then runs the text rules over its own output, so this fired on every
   * captured URL with a query string. A redaction that corrupts its own marker
   * reads as a bug in the export rather than as a redaction.
   */
  if ((q ? qv : uv).startsWith("[redacted")) return m;
  const val = q ? `${q}${qv}${q}` : uv;
  const head = m.slice(0, m.length - val.length);
  return head + (q ? `${q}[redacted]${q}` : "[redacted]");
};

// The shape rules, verbatim.
const DATA_URL = /data:[a-z0-9.+-]*\/?[a-z0-9.+-]*;base64,[A-Za-z0-9+/=]{16,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{0,}/g;
const KEY_PREFIX =
  /\b(sk-[A-Za-z0-9]+-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ya29\.[A-Za-z0-9_-]{20,}|SG\.[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|dop_v1_[a-f0-9]{40,}|shpat_[a-f0-9]{30,}|sbp_[a-f0-9]{30,}|hf_[A-Za-z0-9]{30,}|nvapi-[A-Za-z0-9_-]{20,})\b/g;
const AUTH_SCHEME = /\b(Bearer|Basic|Digest|Negotiate|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const EMAIL =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z]{2,24})+\b/g;
const CARD_CAND = /\b(?:\d[ -]?){12,18}\d\b/g;
const B64 =
  /\b(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{40,}={0,2}\b/g;
const HEX = /\b[0-9a-f]{32,}\b/gi;

/**
 * EXTENSIONS.: redaction "cannot be disabled — only *extended*", which
 * makes adding a rule the sanctioned move and rewriting a spec-verbatim one the
 * unsanctioned one. Every constant above is copied from / and
 * stays untouched; each rule below closes a hole an adversarial pass found by
 * running the module, with the shape that got through named in its comment.
 */

/**
 * Base64URL. B64's class is `[A-Za-z0-9+/]`, verbatim — so a single
 * `_` or `-` chops a token into runs under the 40-char floor and B64 never
 * fires at all. A Cloudflare API token is exactly 40 characters of
 * `[A-Za-z0-9_-]` with no vendor prefix for KEY_PREFIX to key on, and walked
 * through untouched.
 */
const B64URL =
  /\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/g;

/**
 * `vendor_prefix_PAYLOAD` — the shape KEY_PREFIX cannot enumerate.
 *
 * KEY_PREFIX lists vendors one by one, so every provider not on the list ships
 * whole: Docker Hub PATs, Stripe webhook signing secrets, Supabase service
 * keys, Netlify and RubyGems tokens. Their payloads are short enough to sit
 * under B64's 40-char floor, so nothing else catches them either. The two
 * lookaheads — payload must contain BOTH an uppercase letter and a digit — are
 * what keep this off ordinary snake_case identifiers.
 */
const VENDOR_TOKEN =
  /\b[a-z][a-z0-9]{1,15}(?:_[a-z0-9]{1,15}){0,2}_(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g;

/**
 * Credentials in a URL authority: `scheme://user:pass@host`.
 *
 * EMAIL does not cover it — it requires a dotted TLD after the `@`, so a bare
 * hostname, an IP or a `+` in the scheme all slip past. `redactUrl` strips
 * these structurally, but a URL sitting inside free text never reaches that
 * path, and neither does `isSensitiveValue`.
 */
const URL_CRED = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi;

/**
 * A whole value that IS one unbroken high-entropy token, whatever vendor minted
 * it (used by `isSensitiveValue` only).
 *
 * ANCHORED, deliberately: it must fire on a value that is a credential and
 * never on prose that merely contains one, or the negative corpus
 * `/orders/2024`, `4 items`, `cardNumber` — starts failing and 03 loses
 * selectors it should have kept. Mixed case AND a digit AND 24+ characters is
 * what separates an Azure client secret from `product-card-item-12345678`.
 */
const OPAQUE =
  /^(?=[A-Za-z0-9_~.+/=-]*[a-z])(?=[A-Za-z0-9_~.+/=-]*[A-Z])(?=[A-Za-z0-9_~.+/=-]*\d)[A-Za-z0-9_~.+/=-]{24,}$/;

/**
 * Does this string contain a match, without the caller inheriting `lastIndex`?
 *
 * `test()` on a `/g` regex mutates the regex. Resetting before each use is the
 * cheap fix and keeps a single copy of every pattern, which AC C1c cares about:
 * it greps for a SECOND definition of any of these shapes outside this
 * directory, so cloning them per call would be the wrong kind of clever.
 */
function hits(re: RegExp, s: string): boolean {
  re.lastIndex = 0;
  const found = re.test(s);
  re.lastIndex = 0;
  return found;
}

/**
 * The Luhn checksum.: "The Luhn gate is not optional and not forkable."
 *
 * Three mechanics the spec asserts without specifying, decided here and written
 * down rather than left as folklore:
 *   · separators are stripped before the checksum, because CARD_CAND matches
 *     digits interleaved with single spaces or hyphens and a checksum over
 *     "4111 1111" is meaningless;
 *   · the length window is 13–19, the range of real PANs;
 *   · a candidate that FAILS is left entirely untouched — no retry on a shorter
 *     window inside the same digit run. A 16-digit order number that happens to
 *     sit next to a date should survive as itself.
 */
function luhn(raw: string): boolean {
  const d = raw.replace(/[ -]/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** CARD_CAND ∧ Luhn — the only card test anywhere. */
function cardHit(s: string): boolean {
  CARD_CAND.lastIndex = 0;
  for (const m of s.matchAll(CARD_CAND)) if (luhn(m[0])) return true;
  return false;
}

/**
 * Free text — messages, serialised data, accessible names.
 *
 * ORDER IS NORMATIVE and the reason is stated: "broader patterns run
 * later so they cannot swallow the input a narrower pattern would have labelled
 * precisely." A JWT is base64-ish and hex-ish; if B64 ran first every token
 * would come out as `[redacted:b64:210]` and the reviewer would lose the one
 * word that told them what leaked. KV runs at position 2, before every shape
 * rule, and both always run.
 *
 * No caps are applied here. The pre/post caps are PER FIELD and this
 * signature carries no field identity — the caller applies them, which at v0
 * means exactly one call site (`CaptureContext.url`).
 */
export function redactText(s: string): string {
  let out = s;
  out = out.replace(DATA_URL, "data:[redacted]"); // 1
  // AUTH_SCHEME is MOVED AHEAD OF KV — numbers it 5. The letter of the
  // table leaks (see kvReplace); its stated principle — "broader patterns run
  // later so they cannot swallow the input a narrower pattern would have
  // labelled precisely" — is exactly why it has to move, because KV is the
  // broader of the two. Following the rule rather than the numbering.
  //
  // `$1 [redacted]`, NOT the literal "Bearer [redacted]" the table cell shows:
  // the pattern captures the scheme, so `Basic …` must produce `Basic
  // [redacted]`. The cell is an example.
  out = out.replace(AUTH_SCHEME, "$1 [redacted]");
  out = out.replace(KV, kvReplace as never); // 2
  out = out.replace(JWT, "[redacted:jwt]"); // 3
  out = out.replace(KEY_PREFIX, "[redacted:key]"); // 4
  out = out.replace(VENDOR_TOKEN, "[redacted:key]"); // 4b — see EXTENSIONS
  out = out.replace(URL_CRED, "[redacted:url-cred]@"); // 4c
  out = out.replace(EMAIL, "[redacted:email]"); // 6
  out = out.replace(CARD_CAND, (m) => (luhn(m) ? "[redacted:card]" : m)); // 7
  // 8 and 9 carry the MATCHED length, which is the only length computable
  // without decoding. It is fixture-visible output, so it is stated here.
  out = out.replace(B64URL, (m) => `[redacted:b64:${m.length}]`); // 8b
  out = out.replace(B64, (m) => `[redacted:b64:${m.length}]`);
  out = out.replace(HEX, (m) => `[redacted:hex:${m.length}]`);
  // 10 (UUID) is gated on `redact.redactUuids`, v0.1, default false.
  // 11 (server-supplied patterns) is v1. Neither is reachable at v0.
  return out;
}

/** Our own registered query parameters. Values are KEPT — see redactUrl. */
const OURS: readonly string[] = RESERVED_URL_PARAMS.query;
/** The review-link secret. It lives in the FRAGMENT and is redacted
 *  wherever it appears — the one parameter whose value is never displayable. */
const SECRET_PARAMS: readonly string[] = RESERVED_URL_PARAMS.fragment;

/**
 * A URL: a structured pass first, then `redactText` over the serialisation
 *
 * ALLOW-LIST, NOT DENY-LIST. Parameter *names* survive because the name alone is
 * diagnostic; values do not. The default is empty and stays empty — the design is
 * explicit that "the failure mode of a too-loose default (leaking a magic-link
 * token in every captured URL) is catastrophic". A starter list worth
 * documenting, never defaulting: page, tab, view, sort, filter, locale, lang.
 *
 * Our own parameters keep their values, because a report about the wrong
 * permalink is unreadable without the permalink — except `snag_k`, which is the
 * review-link secret and is always redacted.
 *
 * URL PATHS ARE NOT FULLY REDACTED. Path segments get no
 * structural treatment; they are covered only by the trailing `redactText`.
 * That is deliberate and documented, not an oversight.
 */
export function redactUrl(raw: string, allow: readonly string[] = []): string {
  let u: URL;
  try {
    // `globalThis.location`, reached through a cast, rather than the bare
    // `location` global. The runtime guard was always right; the TYPE was
    // browser-only, and the design requires this module to be usable
    // server-side ("publish that module as an isomorphic export usable
    // server-side, not only inside widget-core"). Under Node's lib the bare
    // global does not exist to name, so the file did not compile there at all.
    const here = (globalThis as { location?: { href?: string } }).location?.href;
    u = new URL(raw, here);
  } catch {
    // Not parseable as a URL — it still goes through the text rules rather than
    // through untouched.: nothing reaches a surface un-redacted.
    return redactText(raw);
  }
  u.username = "";
  u.password = "";
  for (const k of [...u.searchParams.keys()]) {
    // From the registry, not typed: `snag_k` is a registered name and
    // a rename would have left this literal behind — so the ONE parameter that
    // must always be redacted would quietly stop being.
    if (SECRET_PARAMS.includes(k)) {
      u.searchParams.set(k, "[redacted]");
      continue;
    }
    if (OURS.includes(k)) continue;
    if (!allow.includes(k)) {
      u.searchParams.set(k, "[redacted]");
      continue;
    }
    // AN ALLOWED PARAMETER IS NOT A LICENCE. The trailing text pass runs over
    // the SERIALISED url, where the value is still percent-encoded — so
    // `?filter=password%3DSuperSecret123` defeated KV outright, because `%3D`
    // is not `=`. `searchParams.get` decodes, so checking here is the only
    // place the rules see what the value actually says. If they recognise
    // anything in it, the whole value goes: an operator allow-listing a
    // parameter is saying its values are ordinarily safe, not promising it.
    const decoded = u.searchParams.get(k) ?? "";
    if (redactText(decoded) !== decoded) u.searchParams.set(k, "[redacted]");
  }
  // The fragment is redacted WHOLE, not per key: it is where the review-link
  // secret lives, and a per-key pass would leave its shape visible.
  if (u.hash && u.hash.length > 1) u.hash = allow.includes("#") ? u.hash : "#[redacted]";

  // `URLSearchParams` serialises form-urlencoded, which escapes [ and ] — so
  // `set(k, "[redacted]")` comes back out as `token=%5Bredacted%5D` and the own
  // illustration (`?utm_source=[redacted]&token=[redacted]`) is unreachable.
  // Un-escaping just our own marker is narrower than hand-building the query
  // string and does not touch any value the host page owns.
  return redactText(u.toString().replace(/%5Bredacted%5D/gi, "[redacted]"));
}

/**
 * Should this attribute value stay out of a generated selector?
 *
 * THE SINGLE NORMATIVE DEFINITION — 03 imports this symbol rather than carrying
 * its own copy, and AC C1c greps for a second one. The 120-char clause is the
 * value; the 100 is deleted. The hex threshold is 32; the 24 is deleted.
 *
 * Composed from exactly seven shapes plus the length clause — deliberately NOT
 * from KV, AUTH_SCHEME or UUID, which describe text that contains a secret
 * rather than a value that IS one.
 *
 * The design is careful about what this does not do: "This does not make selectors
 * private" — `a[href="/users/jane.doe/invoices"]` still passes the guard. It
 * keeps credentials out of selectors, not personal data.
 */
/**
 * The key test for OBJECT keys — the "key-first" step for
 * `Breadcrumb.data` and (v1) `custom`. Same vocabulary, same boundary
 * semantics as KV: the lookbehind is what lets `DB_PASSWORD` and the
 * `[\w-]*` tail is what lets `refreshToken`/`token_count` match, exactly as
 * the string form `db_password=…` would. One list, two syntaxes — a separate
 * key list here is the fork the design forbids.
 */
const KEY_NAME = new RegExp(`(?<![A-Za-z0-9])(?:${KEY})[\\w-]*$`, "i");

export function isSensitiveKey(k: string): boolean {
  return KEY_NAME.test(k);
}

export function isSensitiveValue(v: string): boolean {
  if (v.length > 120) return true;
  return (
    hits(EMAIL, v) ||
    hits(JWT, v) ||
    hits(KEY_PREFIX, v) ||
    hits(HEX, v) ||
    hits(B64, v) ||
    hits(DATA_URL, v) ||
    // The extensions. This predicate is the ENTIRE defence for AnchorRecord
    // .label — the design gives that field redaction "none" precisely because this
    // gate stands in front of it — so a shape that gets past here goes verbatim
    // into storage, the dock, the Markdown export and any issue built from it.
    hits(B64URL, v) ||
    hits(VENDOR_TOKEN, v) ||
    hits(URL_CRED, v) ||
    OPAQUE.test(v) ||
    cardHit(v)
  );
}
