/**
 * Does this look like an email address? One place for the answer, because
 * the answer is two checks in an order that matters.
 *
 * The pattern is the loose one this server has always used: something, an
 * `@`, something, a dot, something. It is right about every address a person
 * types and it BACKTRACKS on a string built for it. `a@.a.a.a…@` makes it try
 * each dot as the last one and fail at the final `@` every time, so the work
 * is the square of the length: a second and a half at 64 KB, and a quarter of
 * a minute at the 200 KB a test sent to `/auth/register`, which answers
 * anybody. A JSON body may be 256 KB.
 *
 * So the LENGTH is asked first and the pattern never reads more than an
 * address can hold: 64 characters, an `@`, and 255.
 *
 * And it is ONE PLAIN ADDRESS. The pattern refuses what a mail program reads
 * as more than that — angle brackets, parentheses, square brackets, quotes,
 * commas, semicolons, colons, a backslash, a control character — and a dot at
 * the very end. `a<b@c.d>` used to pass: a display name and the address
 * `b@c.d` to whatever sends the mail, so what this server counted and stored
 * as one mailbox was delivered to another. Every character people do type in
 * an address is still allowed.
 */
const SHAPE = /^[^\s@<>()[\],;:"\\\x00-\x1f\x7f]+@[^\s@<>()[\],;:"\\\x00-\x1f\x7f]+\.[^\s@.<>()[\],;:"\\\x00-\x1f\x7f]+$/;

export const MAX_EMAIL_LENGTH = 320;

export function looksLikeEmail(value: string): boolean {
  return value.length <= MAX_EMAIL_LENGTH && SHAPE.test(value);
}
