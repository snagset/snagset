import { IDENTITY_KEY } from "@snagset/types/names";

/**
 * `snag:identity` — the ONE reader and writer, the shape.
 *
 * ```
 * { name, email?, projects: { "prj_…": { holderSecret, holderId? } } }
 * ```
 *
 * WHY THIS FILE EXISTS. The key had two writers with incompatible shapes:
 * `panels/composer.tsx` wrote `{name, email?}` when the reviewer typed their
 * name, and `storage/http.ts` wrote a bare 32-byte hex string as the holder
 * secret. Same key, last writer wins — and the composer writes last, so
 * `holderSecret()` began returning the literal text `{"name":"the maintainer"}` and
 * sending it to the server as the secret.
 *
 * The consequence is not cosmetic. `reviewers.holder_secret_hash` is
 * `sha256(secret)` under a unique index, and the design calls it "one row
 * PERSON". With the name as the secret, two different people who both type
 * "the maintainer" hash identically and become ONE reviewer row — the precise failure
 * the holder secret exists to prevent, reintroduced by the thing meant to
 * prevent it. One person renaming themselves becomes two.
 *
 * So: one module, one shape, and the two call sites import from here.
 *
 * PER PROJECT, not global. A reviewer on two Snagset-instrumented sites is two
 * unrelated people to two unrelated servers; a shared secret would let either
 * server recognise them on the other. The name is shared because it is a
 * convenience the reviewer typed, and a secret is not.
 */

export interface Identity {
  name: string;
  email?: string;
}

interface Holder {
  /** 32 random bytes, unpadded base64url (43 chars), MINTED BY THE SERVER and
   *  returned exactly once. Never leaves this origin except back
   *  to the project's own API, which stores only its sha256. */
  holderSecret: string;
  /** The `rev_…` the server minted for this secret. Filled in after the first
   *  exchange; absent until then, which is not an error. */
  holderId?: string;
}

interface Stored {
  name?: string;
  email?: string;
  projects?: Record<string, Holder>;
}

/**
 * Read leniently, and MIGRATE the two shapes already in the wild.
 *
 * Both legacy forms exist on real machines right now — a bare name string from
 * and `{name, email?}` from the version this file replaces. Neither
 * is rejected: the only copies are on the devices of people mid-round,
 * including a phone with a real comment on it, and losing a reviewer's name to
 * a schema change is a worse trade than three lines that accept what is there.
 */
function load(): Stored {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(IDENTITY_KEY);
  } catch {
    // Private-mode Safari and partitioned iframes throw on access. A reviewer
    // with storage disabled still comments — as a new person each visit, which
    // is the honest degradation and not a broken widget.
    return {};
  }
  if (!raw) return {};
  if (raw[0] !== "{") return { name: raw }; // pre-: a bare name
  try {
    const v = JSON.parse(raw) as Stored;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function save(v: Stored): void {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(v));
  } catch {
    /* see load() — the comment still sends, it just asks again next time */
  }
}

/** What the composer prefills. Never the secret. */
export function readIdentity(): Identity {
  const v = load();
  return {
    name: typeof v.name === "string" ? v.name : "",
    ...(v.email ? { email: v.email } : {}),
  };
}

/** Merges — writing a name must not drop the project secrets beside it, which
 *  is the whole bug this module was written to end. */
export function writeIdentity(id: Identity): void {
  const v = load();
  save({ ...v, name: id.name, ...(id.email ? { email: id.email } : {}) });
}

/**
 * This browser's holder for one project, or nothing yet.
 *
 * The secret is MINTED BY THE SERVER and returned once — this
 * module stores what came back and presents it on later exchanges. It does not
 * mint: a client-minted secret is one the server never agreed to, and the
 * first version of this file did exactly that because the session exchange did
 * not exist yet.
 */
export function holderId(uid: string): string | undefined {
  return load().projects?.[uid]?.holderId;
}

export function holderSecretOrUndefined(uid: string): string | undefined {
  const s = load().projects?.[uid]?.holderSecret;
  // Only a well-formed secret is presented. The `{"name":"…"}` that a previous
  // build wrote into this slot is dropped rather than sent, which mints a
  // fresh identity instead of failing a comparison.
  return s && /^[\w-]{43}$/.test(s) ? s : undefined;
}

/** Store what the server returned — the one time it returns it. */
export function rememberHolder(uid: string, holderId: string, holderSecret: string): void {
  const v = load();
  save({ ...v, projects: { ...v.projects, [uid]: { holderId, holderSecret } } });
}

/** Remember the `rev_…` the server bound to an existing secret. */
export function rememberHolderId(uid: string, holderId: string): void {
  const v = load();
  const holder = v.projects?.[uid];
  if (!holder) return;
  save({ ...v, projects: { ...v.projects, [uid]: { ...holder, holderId } } });
}
