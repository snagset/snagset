import { BRAND, MENTION_SCHEME } from "@snagset/types/names";

/**
 * The outbound sanitiser, the ONE function everything that leaves
 * the system on a channel we do not control passes through.
 *
 * Built BEFORE its first call site, deliberately. The alternative is not "no
 * sanitiser" — it is eight ad-hoc scrubs, one per transport, each written by
 * whoever added that transport, each subtly different, and the differences only
 * visible when one of them is the one that lets a bidi override through.
 *
 * ── WHY A BRAND AND NOT A CONVENTION ──
 *
 * `Safe<T>` is a string that carries, in the type system, the target it was
 * sanitised FOR. The constructor is not exported, so the only way to obtain one
 * is to call a function in this file. That makes "the provider never sees a raw
 * Comment" a compile error rather than a code-review habit
 * and it makes the per-target distinction real: a string escaped for Slack's
 * mrkdwn is NOT safe to drop into a GitHub issue body, and the type says so.
 *
 * ── THE ORDER OF THE STEPS IS LOAD-BEARING ──
 *
 * Step 3 strips invisible characters; step 5 inserts one (a word joiner) on
 * purpose. Running them the other way round would strip the joiner back out and
 * silently undo the marker neutralisation — the literal would reach the wire
 * intact and a reviewer could forge a dedupe marker. The design states the order
 * for exactly this reason and it is not an implementation preference.
 */

/**
 * A string already sanitised for exactly one target syntax.
 *
 * The `unique symbol` is what makes this unforgeable: a plain string is not
 * assignable to it, and nothing outside this module can produce one.
 */
declare const SAFE: unique symbol;
export type Safe<T extends OutboundTarget> = string & { readonly [SAFE]: T };

export type OutboundTarget =
  | "github"
  | "linear"
  | "slack-mrkdwn"
  | "slack-plain"
  | "json"
  | "plain";

export interface SanitiseOptions {
  /** Single-line targets (issue titles, Slack `text`, webhook `actor.name`)
   *  additionally lose `\n` and `\t` — step 2's second half. */
  readonly singleLine?: boolean;
  /** Clamp to this many characters, appending an ellipsis (step 8). */
  readonly max?: number;
}

// ── Step 2 ────────────────────────────────────────────────────────────────
// C0 is U+0000–U+001F, C1 is U+0080–U+009F, plus DEL at U+007F. `\n` (000A)
// and `\t` (0009) are exempted here and removed separately for single-line
// targets, because "strip control characters" and "collapse to one line" are
// different decisions and only one of them depends on the target.
const C0_C1 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const NEWLINES_TABS = /[\n\t\r]+/g;

// ── Step 3 ────────────────────────────────────────────────────────────────
// Three families, and each is a real attack rather than tidiness:
//   · BIDI overrides reorder the rendered string, so a comment can display as
//     something other than what is stored — the classic "trojan source" trick.
//   · ZERO-WIDTH characters break substring matching (including ours, in step
//     5) while being invisible to a reader.
//   · The Unicode TAG block encodes arbitrary ASCII invisibly, and is the
//     current favourite for smuggling instructions past a human reviewer into
//     an LLM — which matters directly here, because routes the MCP
//     server through this same pipeline.
const INVISIBLE =
  /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

/** Step 5's word joiner. Invisible in every provider's rendering, and enough
 *  to break a literal for any substring matcher. */
const WJ = "\u2060";

/**
 * Steps 1–3 — normalise, strip control characters, strip invisibles.
 *
 * Split from steps 5–6 at exactly the seam the numbering requires,
 * because step 4 (the personal-data guard) goes BETWEEN them and the order is
 * load-bearing in both directions:
 *
 *   · After step 3, so a zero-width space cannot hide an email address from
 *     the redactor's matcher.
 *   · Before step 5, so the redactor never sees the word joiner we insert —
 *     and never has the chance to treat our own neutralised marker as text
 *     worth redacting.
 *
 * The first version of this file ran the redactor after the whole common pass,
 * which put step 4 after step 5. The test for it failed on the second
 * assertion, which is the only reason this comment is describing a seam rather
 * than a bug.
 */
function normalise(input: string, opts: SanitiseOptions): string {
  // Step 1 — NFC. Two visually identical strings with different code point
  // sequences are two different strings to every matcher downstream.
  let s = input.normalize("NFC");

  // Step 2.
  s = s.replace(C0_C1, "");
  if (opts.singleLine) s = s.replace(NEWLINES_TABS, " ");

  // Step 3.
  s = s.replace(INVISIBLE, "");

  return s;
}

/** Steps 5 and 6 — marker neutralisation and mention flattening. */
function neutralise(input: string): string {
  let s = input;

  // Step 5. All three literals derive from the constants module, so a product
  // rename moves them in one place. The HTML-entity form stops a
  // provider that renders HTML from parsing ours as a real comment; the word
  // joiner stops `origin=` matching our own loop-prevention scanner.
  for (const literal of MARKER_LITERALS) {
    s = s.split(literal.from).join(literal.to);
  }

  // Step 6 — mention rewriting. `@[Name](snag:user/rev_…)` becomes `@Name`.
  // Our reviewer ids mean nothing in GitHub, Linear or Slack; emitting them as
  // live links either 404s or leaks an id into a third party. Mapping to a
  // provider identity happens only through an explicit assigneeMap.
  s = s.replace(MENTION, (_m, name: string) => `@${name}`);

  // Step 8 is deliberately NOT here. It has to run after step 7's escaping —
  // clamping first then escaping can push the string back over the limit, one
  // backslash at a time. `clamp()` is called by the two public functions.
  return s;
}

/**
 * The mention URI form. Non-greedy on the display name so two
 * mentions in one line do not collapse into one.
 */
const MENTION = new RegExp(`@\\[([^\\]]*?)\\]\\(${MENTION_SCHEME}[^)]*\\)`, "g");

/**
 * The fence tag. Exported for `fence.ts`, which builds
 * the wrapper.
 *
 * Declared ABOVE `MARKER_LITERALS` rather than beside `fence.ts` for two
 * reasons. Step 5 has to neutralise its closing form, so the two must never
 * drift apart — and module-level `const` initialisers run in source order, so
 * a declaration below the list that reads it would be a temporal-dead-zone
 * ReferenceError at import time, not a compile error.
 */
export const FENCE_TAG = "untrusted-content";

/**
 * The literals step 5 neutralises — the first three DERIVED from the brand,
 * never typed.
 *
 * "All three literals derive from the constants module, so a product
 * rename changes them in one place." `BRAND` is that place, and building the
 * markers from `long`/`short` here is what keeps `test/rename.test.ts`'s claim
 * true — flip the brand and there are no survivors, including in this file.
 * The fourth is the exception, and says why it is one on its own line.
 *
 * The two HTML-comment openers are broken with an entity, because they are
 * HTML and a provider that renders it would otherwise parse ours as a real
 * comment. `snag:origin=` is broken with a word joiner instead: it appears in
 * webhook JSON and inside our own markers, where `&lt;` would be both wrong
 * and visible.
 */
const MARKER_LITERALS: readonly { from: string; to: string }[] = [
  { from: `<!-- ${BRAND.pkg}:`, to: `&lt;!-- ${BRAND.pkg}:` },
  { from: `<!-- ${BRAND.short}:`, to: `&lt;!-- ${BRAND.short}:` },
  { from: `${BRAND.short}:origin=`, to: `${BRAND.short}${WJ}:origin=` },
  // The fence, closed early. This is the ONLY marker whose
  // literal is not brand-derived — the tag name is fixed by the spec, because
  // it is read by a model rather than by our own scanner and renaming it would
  // silently retrain nothing. It lives in this list rather than in `fence.ts`
  // so "close the fence early" is a fixture in the shared hostile-string
  // corpus instead of a check one consumer remembers to run.
  { from: `</${FENCE_TAG}>`, to: `&lt;/${FENCE_TAG}>` },
];


// ── Step 7 — target-specific escaping ─────────────────────────────────────

/**
 * One function per target syntax. Each one answers a single question: what does
 * this provider parse, that a reviewer could type?
 */
/** Slack's three characters, then the broadcast words a reviewer could type bare. */
function escapeSlack(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(channel|here|everyone)\b/gi, "@\u200b$1");
}

const ESCAPE: Record<OutboundTarget, (s: string) => string> = {
  /**
   * GitHub and Linear both render GitHub-flavoured Markdown and both autolink
   * `@name` and `#123`. The autolink is the reason this is not just HTML
   * escaping: `#42` in a comment body becomes a live cross-reference to
   * somebody's issue 42, and `@acme` pings a real user or team. A zero-width
   * space would be invisible but step 3 strips it; a backslash is the escape
   * GFM documents and it survives the round trip.
   */
  github: (s) => escapeMarkdown(s),
  // Linear resolves `ENG-123` references the way GitHub resolves
  // `#123`, so a key-like token becomes an inert code span after the shared
  // Markdown escape (backticks are not escaped by it, so the span survives).
  linear: (s) => escapeMarkdown(s).replace(/(^|[^\w`])([A-Z][A-Z0-9]{1,7}-\d{1,6})\b/g, "$1`$2`"),

  /**
   * Slack's mrkdwn is NOT Markdown and escapes exactly three characters, which
   * Slack's own documentation is explicit about. Escaping more breaks the
   * rendering; escaping fewer lets `<!channel>` through, which notifies
   * everybody in the workspace — the highest-impact thing a comment body can
   * do to a third party.
   */
  // Defence in depth: the bare forms are inert under
  // `parse=none`, which the client sets, but `chat.update` defaults to
  // `parse=client`, which expands them the way the Slack app would. A
  // zero-width space after the `@` keeps the word readable and unexpandable.
  "slack-mrkdwn": (s) => escapeSlack(s),
  "slack-plain": (s) => escapeSlack(s),

  /** JSON is escaped by the serialiser, so the string itself needs nothing.
   *  Named rather than omitted: an absent case reads as an oversight. */
  json: (s) => s,

  /** Plain text — an email body, a log line, an issue title. Nothing parses
   *  it, so nothing is escaped. Steps 1–3 have already done the work that
   *  matters. */
  plain: (s) => s,
};

/**
 * GFM escaping, restricted to what a comment body can actually weaponise.
 *
 * Not every punctuation mark: escaping all of them turns ordinary prose into
 * backslash soup, and the reviewer's words are the point of the message. What
 * is escaped is the set that changes the STRUCTURE of the rendered document or
 * addresses a third party.
 */
function escapeMarkdown(s: string): string {
  return (
    s
      // Structural characters FIRST, because this pass inserts backslashes and
      // a later pass that escaped them again would double every one.
      .replace(/([\\`*_[\]<>])/g, "\\$1")
      // Then the two autolinkers, which are the ones that reach OUTSIDE the
      // message: `@name` pings a real account, `#42` cross-references someone
      // else's issue. Both are guarded by a lookahead so an `@` or `#` that
      // autolinks nothing is left as the reviewer typed it.
      .replace(/@(?=[A-Za-z0-9_-])/g, "\\@")
      .replace(/#(?=\d)/g, "\\#")
  );
}

// ── The public surface ────────────────────────────────────────────────────

/**
 * Sanitise a Class R string (reviewer-supplied, not personal data) for one
 * target. This is the ordinary case.
 */
export function sanitise<T extends OutboundTarget>(
  input: string,
  target: T,
  opts: SanitiseOptions = {},
): Safe<T> {
  // Order: common steps, then escape, then clamp. Clamping before escaping is
  // the subtle mistake — escaping can only ADD characters, so a string clamped
  // to the limit first comes back over it.
  const escaped = ESCAPE[target](neutralise(normalise(input, opts)));
  return clamp(escaped, opts.max) as Safe<T>;
}

/**
 * Sanitise a Class P string (may contain personal data) — step 4 included.
 *
 * The redactor is INJECTED rather than imported, and that is the
 * requirement rather than a testing convenience: 04 owns the redaction
 * vocabulary and forbids forks, and a direct import from this package would
 * make `@snagset/adapters` depend on `widget-core` — a browser bundle — for a
 * server-side transport. The caller passes the own exported function.
 */
export function sanitiseWithRedactor<T extends OutboundTarget>(
  input: string,
  target: T,
  redact: (s: string) => string,
  opts: SanitiseOptions = {},
): Safe<T> {
  // Step 4 sits between step 3 and step 5, .2's numbering: after
  // the invisible characters are gone (so a zero-width space cannot hide an
  // email address from the matcher) and before marker neutralisation (so the
  // redactor never sees our own inserted word joiner).
  const escaped = ESCAPE[target](neutralise(redact(normalise(input, opts))));
  return clamp(escaped, opts.max) as Safe<T>;
}

/**
 * Clamp, without leaving a dangling escape.
 *
 * `"a\\*b"` cut at 3 characters is `"a\\"` — a backslash escaping nothing,
 * which GitHub renders as a literal backslash and Linear renders as nothing.
 * Trimming the odd trailing backslash costs one character and removes the
 * class of bug entirely.
 */
function clamp(s: string, max: number | undefined): string {
  if (max === undefined || s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  let cut = s.slice(0, max - 1);
  let backslashes = 0;
  for (let i = cut.length - 1; i >= 0 && cut[i] === "\\"; i--) backslashes++;
  if (backslashes % 2 === 1) cut = cut.slice(0, -1);
  return cut + "…";
}

/**
 * Escape hatch for a value that is already known safe — an id we minted, an
 * enum, a timestamp.
 *
 * Exported because the alternative is worse: without it a caller assembling a
 * view model has to run `sanitise()` over `'thr_01J…'` to satisfy the types,
 * and a team that has learned to launder Class S values through the sanitiser
 * will eventually launder a Class R one the same way without thinking. Named
 * so it is greppable, and documented so the review question is "is this
 * genuinely ours?" rather than "what does this do?".
 */
export function trusted<T extends OutboundTarget>(value: string): Safe<T> {
  return value as Safe<T>;
}
