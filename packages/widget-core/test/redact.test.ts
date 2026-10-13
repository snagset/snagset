import { test } from "node:test";
import assert from "node:assert/strict";
import { isSensitiveValue, redactText, redactUrl } from "../src/redact/predicates.ts";

/**
 * The redaction rules, executed.
 *
 * The own preamble is the reason this file is not optional: "Draft 1's rule
 * was verified non-functional (A11 corrigendum). The corrected key/value rule,
 * **executed against fixtures**." A redaction regex that reads correctly and
 * leaks is the exact failure this project has already had once — verify-dist's
 * header records a version that "read correctly and leaked 7 of 8 secrets".
 *
 * The per-alternative fixture suite and its independent extractor are plan task
 * 23 and still owed; this is the behavioural core it will sit on.
 */

const secret = (s: string): void => {
  assert.ok(!redactText(s).includes(s), `leaked verbatim: ${s.slice(0, 40)}`);
};

test("key = value is redacted in every shape a real payload uses", () => {
  assert.equal(redactText("password=hunter2xyz"), "password=[redacted]");
  assert.equal(redactText('"apiKey": "abc123456"'), '"apiKey": "[redacted]"');
  assert.equal(redactText("Authorization: abc123456"), "Authorization: [redacted]");
  assert.equal(redactText("access_token=abcdefghij"), "access_token=[redacted]");
  // The KEY and the separator SURVIVE. They are the diagnostic half of the pair
  // — "something called password was here" is the useful part.
  assert.match(redactText("password=hunter2xyz"), /^password=/);
});

test("`pin` and `sig` are deliberately absent from the vocabulary", () => {
  // Excludes them on purpose and the design says so in bold. Asserted so a
  // future "obviously they should be in there" is a failing test, not a commit.
  assert.equal(redactText("pin=1234"), "pin=1234");
  assert.equal(redactText("sig=abcdef"), "sig=abcdef");
});

test("a JWT is labelled as a JWT, not swallowed by a broader rule", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9";
  assert.equal(redactText(`token is ${jwt} ok`), "token is [redacted:jwt] ok");
  // Order is the whole point: B64 and HEX would both match parts of a
  // JWT, and the reviewer would lose the one word that says what leaked.
  assert.ok(!redactText(jwt).includes("b64"));
});

test("provider key prefixes are recognised", () => {
  for (const k of [
    "sk-ant-api03-abcdefghijklmnopqrstuvwx",
    "ghp_abcdefghijklmnopqrstuvwxyz0123",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-1234567890-abcdefghij",
    "glpat-abcdefghijklmnopqr",
  ]) {
    assert.equal(redactText(`key ${k} end`), "key [redacted:key] end", k);
  }
});

test("AN AUTHORIZATION HEADER DOES NOT LEAK ITS TOKEN", () => {
  // The regression this file exists for, found by running the rules rather than
  // reading them. Numbers KV at 2 and AUTH_SCHEME at 5. In that order,
  // KV matches the key `Authorization`, its unquoted-value branch stops at the
  // first whitespace so it takes `Bearer` as the entire value, and the output is
  //
  //     Authorization: [redacted] abcdefgh12345
  //
  // The word is redacted and THE TOKEN IS PUBLISHED — on the single most
  // canonical secret there is. AUTH_SCHEME cannot recover it, because the scheme
  // word it keys on has just been replaced.
  const out = redactText("Authorization: Bearer abcdefgh12345");
  assert.ok(!out.includes("abcdefgh12345"), `LEAKED: ${out}`);
  assert.equal(out, "Authorization: Bearer [redacted]");
});

test("…and a credential too short for AUTH_SCHEME is still not left whole", () => {
  // The other half of the carve-out. Skipping a scheme word unconditionally
  // would let `Bearer abc` — under AUTH_SCHEME's 8-char floor — pass through
  // untouched, which is a worse bug than the one being fixed.
  const out = redactText("Authorization: Bearer abc");
  assert.ok(!out.includes("Bearer abc"), `passed through whole: ${out}`);
});

test("the auth SCHEME survives — a Basic credential is not labelled Bearer", () => {
  // The table cell writes the replacement as the literal "Bearer
  // [redacted]", but the pattern captures the scheme, so the cell is an example
  // and not the rule. Getting this wrong mislabels every non-Bearer credential.
  assert.equal(redactText("Authorization: Bearer abcdefgh12345"), "Authorization: Bearer [redacted]");
  assert.equal(redactText("Proxy: Basic dXNlcjpwYXNz"), "Proxy: Basic [redacted]");
  assert.equal(redactText("x: Digest abcdefgh12345"), "x: Digest [redacted]");
});

test("a card number passes the Luhn gate; a look-alike does not", () => {
  // The gate is what stops every 16-digit order number becoming [redacted:card].
  assert.equal(redactText("card 4111 1111 1111 1111 here"), "card [redacted:card] here");
  assert.equal(redactText("card 4111111111111111 here"), "card [redacted:card] here");
  const notACard = "4111111111111112"; // one digit off — fails Luhn
  assert.equal(redactText(`ref ${notACard} here`), `ref ${notACard} here`);
});

test("emails, base64 blobs and long hex are labelled with their kind", () => {
  assert.equal(redactText("write to jane.doe@example.co.uk now"), "write to [redacted:email] now");
  assert.match(redactText("a".repeat(20) + "B".repeat(20) + "1".repeat(20)), /\[redacted:b64:60\]/);
  assert.match(redactText("deadbeef".repeat(4)), /\[redacted:hex:32\]/);
});

test("a data: URL never survives, at any length", () => {
  secret("data:image/png;base64," + "A".repeat(400));
  assert.match(redactText("data:image/png;base64," + "A".repeat(40)), /^data:\[redacted\]$/);
});

test("redactUrl: allow-list, not deny-list", () => {
  const out = redactUrl("https://a.dev/reset?token=abc123&page=2&utm_source=news", ["page"]);
  // The NAMES survive — a URL with its parameters stripped is unreadable, and
  // the name alone is diagnostic. The values do not.
  assert.match(out, /token=\[redacted\]/);
  assert.match(out, /utm_source=\[redacted\]/);
  assert.match(out, /page=2/, "an allowed parameter keeps its value");
  // …and specifically NOT percent-encoded. URLSearchParams form-encodes [ and ],
  // so the naive serialisation emits token=%5Bredacted%5D and the own
  // worked example becomes unreachable.
  assert.ok(!out.includes("%5B"), "the marker must be readable, not form-encoded");
});

test("redactUrl: our own parameters keep their values — except the secret", () => {
  const out = redactUrl("https://a.dev/p?snag_t=SN-14&snag_debug=1&other=x");
  assert.match(out, /snag_t=SN-14/, "a report about the wrong permalink is unreadable");
  assert.match(out, /snag_debug=1/);
  assert.match(out, /other=\[redacted\]/);
});

test("redactUrl: the fragment goes WHOLE, and credentials in the authority go", () => {
  // The fragment is where the review-link secret lives (the design puts snag_k there
  // precisely so it never reaches a server), so a per-key pass would leave its
  // shape visible.
  assert.match(redactUrl("https://a.dev/p#snag_k=deadbeefcafe"), /#\[redacted\]$/);
  const auth = redactUrl("https://user:hunter2@a.dev/p");
  assert.ok(!auth.includes("hunter2") && !auth.includes("user:"), auth);
});

test("redactUrl: a path that carries a token is still caught by the text pass", () => {
  // The design is explicit that paths are NOT structurally redacted — segments
  // are diagnostic and mostly retained. The trailing redactText is the net.
  const out = redactUrl("https://a.dev/reset/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh");
  assert.match(out, /\[redacted:jwt\]/);
  assert.match(out, /a\.dev\/reset\//, "the readable part of the path survives");
});

test("redactUrl: an unparseable string still goes through the rules", () => {
  // No captured datum reaches a surface before the redactor. "Could not
  // parse it" must not become "shipped it".
  assert.match(redactUrl("not a url at all password=hunter2xyz"), /password=\[redacted\]/);
});

test("isSensitiveValue is NOT stateful — the /g regexes must not leak lastIndex", () => {
  // `test()` on a global regex advances lastIndex, so the same input returns
  // true, then false, then true. This is the bug that ships if the guard is
  // written the obvious way, and it fails OPEN — a selector containing a real
  // credential passes on every other element.
  const email = "jane.doe@example.com";
  for (let i = 0; i < 6; i++) assert.equal(isSensitiveValue(email), true, `call ${i}`);
  const plain = "Browse the autumn range";
  for (let i = 0; i < 6; i++) assert.equal(isSensitiveValue(plain), false, `call ${i}`);
});

test("isSensitiveValue covers exactly the seven shapes plus the length clause", () => {
  assert.equal(isSensitiveValue("a".repeat(121)), true, "the 120-char clause — the value, not the 100");
  assert.equal(isSensitiveValue("deadbeef".repeat(4)), true, "hex at 32 — not the deleted 24");
  assert.equal(isSensitiveValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh"), true);
  assert.equal(isSensitiveValue("4111 1111 1111 1111"), true);
  assert.equal(isSensitiveValue("ghp_abcdefghijklmnopqrstuvwxyz0123"), true);

  // NOT composed from KV or AUTH_SCHEME: those describe text that CONTAINS a
  // secret, not a value that IS one, and an attribute value is the latter.
  assert.equal(isSensitiveValue("password=hunter2"), false);
  // And the honest limit, stated: this keeps credentials out of
  // selectors. It does not make selectors private.
  assert.equal(isSensitiveValue("/users/jane.doe/invoices"), false);
});

test("no rule is catastrophically slow on adversarial input", () => {
  // The design makes backtracking a hard review criterion because it is a denial of
  // service on the reviewer's own main thread. Deliberately nasty: long runs of
  // the characters each pattern's quantifiers accept.
  const nasty = [
    "a".repeat(50_000),
    "eyJ" + "A".repeat(20_000),
    "4".repeat(20_000),
    "password=" + '"'.repeat(10_000),
    ("Bearer " + "A".repeat(200)).repeat(200),
  ];
  for (const s of nasty) {
    const t0 = performance.now();
    redactText(s);
    const ms = performance.now() - t0;
    assert.ok(ms < 250, `${ms.toFixed(1)}ms on ${s.slice(0, 12)}… — looks like backtracking`);
  }
});

/**
 * ── The adversarial pass ──
 *
 * Six leaks found by six independent hunters running the module rather than
 * reading it, each reproduced by a separate verifier before it was believed.
 * Every one is pinned below with the exact input that got through.
 *
 * The thread running through four of them is worth stating once: `isSensitiveValue`
 * is the ENTIRE defence for `AnchorRecord.label`. The design gives that field
 * redaction "none" — justified explicitly by this predicate standing in front of
 * it — so a credential shape that gets past here does not merely survive in
 * free text. It goes verbatim into storage, into the rendered dock, into the
 * Markdown export, and into any issue built from that export.
 */

test("LEAK 1 — snake_case keys were invisible to KV", () => {
  // `_` is a word character, so `\b` found no boundary between the B and the P
  // of DB_PASSWORD. The bare `password=` was redacted correctly the whole time,
  // which is what made this survive review: the rule looked like it worked.
  for (const s of [
    "DB_PASSWORD=SuperSecret123",
    "db_password=SuperSecret123",
    "oauth_token=Sup3rSecretVal",
    "csrf_token=Sup3rSecretVal",
    "app_secret=Sup3rSecretVal",
    "AWS_SESSION_TOKEN=FwoGZXIvYXdzEBYaDF",
  ]) {
    assert.match(redactText(s), /\[redacted\]/, `LEAKED: ${redactText(s)}`);
  }
  // …and the anti-over-fire property `\b` was buying is preserved.
  assert.equal(redactText("mypassword=hunter2xyz"), "mypassword=hunter2xyz");
});

test("LEAK 2 — base64url tokens split under B64's floor", () => {
  // B64's class is [A-Za-z0-9+/] — verbatim — so one `_` or `-` cuts
  // the token into runs below 40 chars and the rule never fires. That is the
  // exact shape of a Cloudflare API token.
  const tok = "kZ8Xj_9pQwErTyUiOpAsDfGhJkLzXcVbNm12-4Ty";
  assert.ok(!redactText(`t ${tok}`).includes(tok), redactText(`t ${tok}`));
  assert.equal(isSensitiveValue(tok), true, "and the label gate must catch it too");
});

test("LEAK 3 — vendor tokens KEY_PREFIX does not enumerate", () => {
  // Enumerating vendors cannot keep up. These payloads also sit under B64's
  // 40-char floor, so nothing caught them at all.
  // Assembled at run time: written whole, a secret scanner (GitHub's push
  // protection) reads the fixture as a real credential and blocks the push.
  const body = "A9fK2mQxWzYbNc3VdEfGhJkLmNp";
  for (const t of [["dckr", "pat", body].join("_"), ["whsec", body + "Qr"].join("_"), ["nfp", body + "QrSt"].join("_")]) {
    assert.ok(!redactText(t).includes(t), `LEAKED: ${redactText(t)}`);
    assert.equal(isSensitiveValue(t), true, t);
  }
});

test("LEAK 4 — segmented sk- keys fell through the generic branch", () => {
  // KEY_PREFIX's generic branch is sk-[A-Za-z0-9]{20,} with no hyphen or
  // underscore, so every modern segmented key escaped whole.
  for (const k of [
    "sk-svcacct-Kd82nZqPwL4mXeRt7YbVc1JhGs9AoUiNfTgB",
    "sk-proj-A9fK2mQx_WzYbNc3VdEfGhJkLmNpQrStUvWxYz",
  ]) {
    assert.equal(redactText(`key ${k}`), "key [redacted:key]", k);
    assert.equal(isSensitiveValue(k), true, k);
  }
});

test("LEAK 5 — credentials in a URL authority", () => {
  // EMAIL requires a dotted TLD after the @, so a bare host or an IP slips past
  // it. redactUrl strips these structurally, but a URL inside free text never
  // reaches that path and neither does the label gate.
  const u = "postgres://admin:s3cr3tpassw0rd@db-primary:5432/app";
  assert.ok(!redactText(u).includes("s3cr3tpassw0rd"), redactText(u));
  assert.equal(isSensitiveValue(u), true);
});

test("LEAK 6 — a high-entropy value with no vendor prefix at all", () => {
  // An Azure client secret has no prefix to key on and no shape rule matched
  // it. Closed in isSensitiveValue only, anchored, so free text keeps its
  // diagnostic value.
  assert.equal(isSensitiveValue("8Q~rT4mKp2XvNb7YcLd3WsEf6GhJ9AzQ"), true);
});

test("…and the guard still says NO to the things the design wants kept", () => {
  // The negative corpus. An over-firing predicate is not a safe predicate — it
  // silently costs 03 every selector it would have built, and anchoring is the
  // product. This is the assertion that stops the next fix over-reaching.
  for (const v of [
    "/orders/2024",
    "4 items",
    "cardNumber",
    "email",
    "Browse the autumn range",
    "product-card-item-12345678901234",
    "btn btn-primary btn-lg",
    "Start a 14-day trial",
    "submit-order-button",
    "/users/jane.doe/invoices",
  ]) {
    assert.equal(isSensitiveValue(v), false, `over-fired on: ${v}`);
  }
});

test("LEAK 7 — percent-encoding defeated the rules on an allow-listed parameter", () => {
  // The trailing text pass runs over the SERIALISED url, where the value is
  // still encoded — so %3D is not = and KV never matched. An allow-listed
  // parameter is the one place where the text rules are the only defence left,
  // which is exactly where this bit.
  const out = redactUrl("https://a.dev/x?filter=password%3DSuperSecret123", ["filter"]);
  assert.ok(!out.includes("SuperSecret123"), `LEAKED: ${out}`);

  // …and an ordinary allowed value is still kept, or the allow-list would mean
  // nothing at all.
  assert.match(redactUrl("https://a.dev/x?page=2", ["page"]), /page=2/);
  assert.match(redactUrl("https://a.dev/x?sort=name%20asc", ["sort"]), /sort=name/);
});

test("LEAK 8 — a snake_case key inside a URL PATH", () => {
  // Keeps path segments deliberately un-redacted structurally, so
  // the text rules are the whole defence there. `/logs/password=x` was caught
  // and `/logs/DB_PASSWORD=x` was not — the module was already trying to cover
  // this case and missed it by one character class.
  const out = redactUrl("https://ci.a.dev/logs/DB_PASSWORD=SuperSecret123");
  assert.ok(!out.includes("SuperSecret123"), `LEAKED: ${out}`);
  assert.match(out, /ci\.a\.dev\/logs\//, "the readable part of the path survives");
});

test("REDACTION IS IDEMPOTENT — it does not corrupt its own marker", () => {
  // Found end to end, in the stored URL of a real snag: `token=[redacted]]`.
  // KV's unquoted-value class excludes `]`, so against an already-redacted
  // value it matched `[redacted`, substituted `[redacted]` and stranded the
  // original bracket. redactUrl redacts structurally and then runs the text
  // rules over its OWN output, so this fired on every captured URL with a query
  // string — and a redaction that mangles its own marker reads as a bug in the
  // export rather than as a redaction.
  for (const s of [
    "https://a.dev/x?token=[redacted]&page=[redacted]",
    'password="[redacted]"',
    "Authorization: Bearer [redacted]",
    "a=[redacted], b=[redacted]",
  ]) {
    assert.equal(redactText(s), s, `not stable: ${redactText(s)}`);
    assert.equal(redactText(redactText(s)), redactText(s));
  }

  // …and the property holds for freshly-redacted input too, which is the form
  // it actually reaches redactUrl in.
  for (const s of [
    "https://a.dev/reset?token=abc123def456&page=2",
    "password=hunter2xyz and api_key=abcdefghij",
    "Authorization: Bearer abcdefgh12345",
  ]) {
    const once = redactText(s);
    assert.equal(redactText(once), once, `redactText is not idempotent on: ${s}`);
  }
});
