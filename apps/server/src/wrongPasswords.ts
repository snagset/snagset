/**
 * The count of wrong passwords (row 21; the numbers are
 * The maintainer's, 2026-11-12). In a window of fifteen minutes: ten for one address
 * from anywhere, thirty from one caller across every address. The first stops
 * guessing at an account from many places; the second stops one place trying
 * a common password on many accounts.
 *
 * ONE count for every route that checks a password somebody outside typed:
 * `/auth/login`, and an invite's accept for an account that already exists
 * (which is a sign-in by another door, and was a way round the first).
 *
 * An attempt is counted BEFORE the password is looked at (`admit`) and taken
 * back when it turns out right (`right`). Counting afterwards is not a count:
 * the look-up and the scrypt in between are a quarter of a second in which
 * any number of requests sent together would each see the number as it was.
 *
 * Somebody can lock a known address out of PASSWORD sign-in for the window
 * by typing ten wrong ones. That is the price of the first count, and it is
 * bounded: the mailed reset still works, and it signs them in.
 *
 * In process memory, as every count in this server is (orgs.ts says why that
 * is a weaker limit on serverless rather than a missing one).
 */
export const WRONG_WINDOW_MS = 15 * 60 * 1000;
export const WRONG_PER_ACCOUNT = 10;
export const WRONG_PER_CALLER = 30;
/** Longer than any address that can be an account; a longer one is refused before it is a key in a map. */
export const MAX_EMAIL_LENGTH = 320;
const KEYS = 50_000;

export interface WrongPasswords {
  /**
   * One attempt at `email` from `caller`. 0 when it may go ahead, and then it
   * is counted; otherwise the milliseconds to wait, and nothing is counted.
   */
  admit(email: string, caller: string): number;
  /** The attempt just admitted was right: forgotten for the address (all of them), taken back for the caller (that one). */
  right(email: string, caller: string): void;
}

export function wrongPasswords(now: () => number = Date.now, enabled: () => boolean = () => true): WrongPasswords {
  const at = new Map<string, number[]>();
  const recent = (key: string): number[] => {
    const t = now();
    const list = (at.get(key) ?? []).filter((x) => t - x < WRONG_WINDOW_MS);
    if (list.length) at.set(key, list);
    else at.delete(key);
    return list;
  };
  const wait = (key: string, limit: number): number => {
    const list = recent(key);
    return list.length < limit ? 0 : list[list.length - limit]! + WRONG_WINDOW_MS - now();
  };
  const note = (key: string): void => {
    const list = recent(key);
    list.push(now());
    // Re-inserted, so the map's order is "least recently tried first" and
    // the oldest is what a flood of new keys pushes out — never all of it.
    at.delete(key);
    at.set(key, list);
    while (at.size > KEYS) at.delete(at.keys().next().value!);
  };
  return {
    admit(email, caller) {
      if (!enabled()) return 0;
      const a = `a:${email}`;
      const c = `c:${caller}`;
      const held = Math.max(wait(a, WRONG_PER_ACCOUNT), wait(c, WRONG_PER_CALLER));
      if (held > 0) return held;
      note(a);
      note(c);
      return 0;
    },
    right(email, caller) {
      at.delete(`a:${email}`);
      const list = at.get(`c:${caller}`);
      if (!list) return;
      list.pop();
      if (!list.length) at.delete(`c:${caller}`);
    },
  };
}

/** The 429's sentence, the same from every door. */
export const tooManyWrong = (waitMs: number): string =>
  `Too many wrong passwords. Try again in ${Math.max(1, Math.ceil(waitMs / 60_000))} minutes, or reset the password with "Forgot your password?".`;
