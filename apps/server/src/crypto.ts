import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Keyring } from "./keys.ts";

/**
 * Secrets at rest — AES-256-GCM under `HKDF(SNAGSET_SECRET_KEY,
 * 'credential-enc')`.
 *
 * ONE shape for every stored credential. `integrations.credentials` and
 * `orgs.storage_credentials` are the same `(bytea, bytea)` pair for the same
 * reason: two ways to hold a secret at rest is one way too many, and the
 * second one is always the one nobody rotated.
 *
 * GCM, not CBC: the auth tag means a tampered ciphertext fails to decrypt
 * rather than decrypting to garbage that some later parser has to survive.
 * The tag is appended to the ciphertext so the pair of columns stays a pair —
 * a third column for it would be a third thing to forget.
 *
 * The key rotation applies here and is the reason `decrypt` takes a keyring
 * rather than a key: during the 24-hour overlap a value encrypted under the
 * previous key must still open, which is what `snagset keys reencrypt`
 * then walks. That command does not exist yet; this shape is what lets
 * it be written without a migration.
 */

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
}

export function seal(keys: Keyring, plaintext: string): Sealed {
  // 12 bytes is GCM's canonical nonce length — the one at which the counter
  // construction needs no extra hashing step.
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keys.derive("credential-enc"), iv);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { ciphertext: Buffer.concat([body, c.getAuthTag()]), iv };
}

export function open(keys: Keyring, sealed: Sealed): string | null {
  try {
    const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - 16);
    const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16);
    const d = createDecipheriv("aes-256-gcm", keys.derive("credential-enc"), sealed.iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    // The overwhelmingly likely cause is a changed `SNAGSET_SECRET_KEY` —
    // which the design warns makes stored credentials "unrecoverable
    // ciphertext". Null rather than throwing, so a boot with a lost key
    // degrades to "storage disconnected" instead of failing to start.
    return null;
  }
}
