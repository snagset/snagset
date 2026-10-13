/**
 * What the CLI says when it fails — in its own module, and that is the point.
 *
 * `bin.ts` calls `main()` at import time, so anything living in it cannot be
 * unit-tested: importing the module runs the server. `create-snagset`'s
 * scaffold.ts records the same lesson in its own header. This is the half
 * worth testing, so it lives where a test can reach it.
 */
/** Node hides the useful part of a connection failure on `.code`. */
export function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string"
    ? (e as { code: string }).code
    : undefined;
}

/**
 * Say what went wrong, in a sentence an operator can act on.
 *
 * THE FAILURE THIS EXISTS FOR: `postgres` throws an AggregateError whose
 * `.message` is the EMPTY STRING and whose only own property is `.code`. The
 * catch-all below printed `✗ ${e.message}`, so a server that could not reach
 * its database said:
 *
 *     ✗
 *
 * and stopped. That is the first thing a self-hoster meets — more so since
 * the decision removed the compose file that used to provide the database, which makes
 * "bring your own Postgres" step one and forgetting to start it the ordinary
 * mistake rather than an exotic one.
 *
 * The address is reported HOST AND PORT ONLY. An operator needs to know which
 * one was tried; nobody needs the password in their scrollback.
 */
export function explain(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (raw) return `✗ ${raw}`;

  let where = "";
  try {
    const u = new URL(process.env["DATABASE_URL"] ?? "");
    where = ` at ${u.hostname}:${u.port || "5432"}`;
  } catch {
    /* an unparseable URL is its own problem, and loadConfig reports that one */
  }

  switch (errCode(e)) {
    case "ECONNREFUSED":
      return (
        `✗ no Postgres answered${where}.\n` +
        `  Start one, or point DATABASE_URL at a database that is running —\n` +
        `  a free Supabase or Neon project works, so does a local install.`
      );
    case "ENOTFOUND":
      return `✗ that database host does not resolve${where}.\n  Check the hostname in DATABASE_URL.`;
    case "ETIMEDOUT":
      return (
        `✗ the database did not answer in time${where}.\n` +
        `  A firewall or a sleeping serverless branch is the usual cause.`
      );
    default:
      return `✗ ${errCode(e) ?? "the server failed to start, and said nothing about why"}`;
  }
}
