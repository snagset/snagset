import { createHash, hkdfSync, timingSafeEqual } from "node:crypto";
import { SCHEMA_VERSION } from "@snagset/types/names";

/**
 * One secret in, every key out — and.
 *
 * There are no per-purpose secret environment variables. Everything is
 * HKDF-SHA256 over `SNAGSET_SECRET_KEY`, and the union below is CLOSED: a
 * purpose not on the list is a failure, not a warning, because an
 * unrecognised derivation would silently produce a perfectly valid key for the
 * wrong thing. That is the worst available failure shape — nothing throws,
 * nothing logs, and every artefact signed under it verifies nowhere.
 *
 * Two purposes are deleted and must stay deleted:
 *   'review-link' — links are opaque random and REVOKED, not rotated; there is
 *                   no signing key to derive.
 *   'ip-hash'     — replaced by `projects.ip_salt`, a column, because a salt
 *                   that is data is erasable with the project and a derived
 *                   key is instance-wide and outlives the erasure.
 *
 * 'session' is not a member either: signs with 'reviewer-session', and
 * a server that derived 'session' would sign tokens nothing could verify. The
 * dashboard session needs no purpose at all — it is 32 random bytes checked by
 * row lookup, not by signature.
 */
export type KeyPurpose =
  | "reviewer-session"
  | "credential-enc"
  | "attachment-url"
  | "webhook-sign"
  /** HMAC over a reviewer id: one-click unsubscribe, authenticated by being unforgeable rather than by a session (B2). */
  | "unsubscribe";

const PURPOSES: readonly KeyPurpose[] = [
  "reviewer-session",
  "credential-enc",
  "attachment-url",
  "webhook-sign",
  "unsubscribe",
];

/**
 * The salt: the 32 RAW bytes of `sha256(SCHEMA_VERSION)`, not its hex text.
 *
 * Hex would be a 64-byte salt wearing a 32-byte name, and the difference is
 * invisible until two builds disagree. Tying it to the schema id means the
 * same secret under a future schema derives different keys, which is the point
 * the design makes: keys do not leak across schema generations.
 */
const SALT = createHash("sha256").update(SCHEMA_VERSION).digest();

/** 32 bytes for every purpose. HS256 wants ≥ 32; AES-256-GCM wants exactly 32. */
const KEY_BYTES = 32;

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

/**
 * `kid` — which key signed this, so verification does not have to guess.
 *
 * Mandates it in the JWT header and defines it nowhere; now
 * does. First 8 bytes of `sha256(secret)`, base64url, 11 characters. It is not
 * a secret — it is a fingerprint of one, and 8 bytes is far more than enough to
 * tell two keys apart while revealing nothing about either.
 */
export function keyId(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url").slice(0, 11);
}

export interface Keyring {
  /** The 32-byte key for a purpose, under the CURRENT secret. */
  derive(purpose: KeyPurpose): Buffer;
  /** The current secret's `kid` — what a freshly signed token carries. */
  kid: string;
  /**
   * Resolve a token's `kid` to the key that signed it, or null.
   *
   * Deliberately NOT "try both keys": that makes `kid` decorative and keeps a
   * retired key live past the 24-hour rotation overlap it exists to bound
   * A token whose kid matches nothing is rejected, which is the
   * behaviour that makes rotation finish.
   */
  forKid(kid: string, purpose: KeyPurpose): Buffer | null;
}

export function createKeyring(secret: string, previous?: string | undefined): Keyring {
  if (!secret) throw new KeyError("no signing key — SNAGSET_SECRET_KEY is empty");

  const cache = new Map<string, Buffer>();
  const derive = (s: string, purpose: KeyPurpose): Buffer => {
    if (!PURPOSES.includes(purpose)) {
      // Unreachable through the type, reachable through JSON, a plugin, or a
      // future edit. Loud, because the silent version signs with a real key.
      throw new KeyError(
        `"${purpose}" is not a KeyPurpose. The union is closed: ${PURPOSES.join(", ")}.`,
      );
    }
    const memo = `${keyId(s)}:${purpose}`;
    let k = cache.get(memo);
    if (!k) {
      // `info` is the UTF-8 bytes of the purpose literal — the only thing
      // separating the four keys. A case or separator difference is a
      // different key, and nothing anywhere would say so.
      k = Buffer.from(hkdfSync("sha256", Buffer.from(s, "utf8"), SALT, Buffer.from(purpose, "utf8"), KEY_BYTES));
      cache.set(memo, k);
    }
    return k;
  };

  const currentKid = keyId(secret);
  const previousKid = previous ? keyId(previous) : null;

  return {
    kid: currentKid,
    derive: (purpose) => derive(secret, purpose),
    forKid(kid, purpose) {
      // Constant-time on the kid too. It is not secret, but comparing it with
      // `===` makes one more thing in the auth path timing-variable for no
      // saving at all.
      const eq = (a: string, b: string): boolean =>
        a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
      if (eq(kid, currentKid)) return derive(secret, purpose);
      if (previous && previousKid && eq(kid, previousKid)) return derive(previous, purpose);
      return null;
    },
  };
}
