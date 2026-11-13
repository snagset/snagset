/**
 * What a failed `listen` should say — one sentence, naming the fix.
 *
 * Found 2026-09-07 by starting a second instance beside the dogfood: Node's
 * own report is an unhandled 'error' event and a stack trace, which reads
 * as a crash in our code when the whole story is "8080 is taken". Every
 * other boot failure here is a sentence with the variable to change; this
 * was the one that was not. `null` means the error is not one we know how
 * to explain, and the caller rethrows it.
 */
export function listenFailure(err: unknown, port: number, hostname: string): string | null {
  const code = (err as { code?: string } | null)?.code;
  if (code === "EADDRINUSE") {
    return (
      `✗ port ${port} is already in use on ${hostname} — another Snagset, or something else, is listening there. ` +
      `Stop it, or set SNAGSET_PORT to a free port (and SNAGSET_BASE_URL to match, since review links are built from it).`
    );
  }
  if (code === "EACCES") {
    return `✗ this user may not listen on port ${port} — ports below 1024 need a privileged user. Set SNAGSET_PORT to a port above 1023.`;
  }
  if (code === "EADDRNOTAVAIL") {
    return `✗ ${hostname} is not an address on this machine — check SNAGSET_BIND_ADDRESS.`;
  }
  return null;
}

/**
 * Roam to the next free port — but only when nothing pinned one.
 *
 * The maintainer, 2026-09-07, after a second instance died on 8080: *"can't it just
 * ask if another can be used, like Next does?"* It can, and for a laptop
 * that is the right default. What stops it being the default everywhere is
 * that review links and the claim URL are built from `SNAGSET_BASE_URL`, and
 * a deploy's reverse proxy points at the port the operator chose: a server
 * that quietly moved to 8081 there would report success while the site was
 * down. So the rule is Next's rule. Set neither the port nor the address and
 * the server finds a free port and moves its address to match; set either,
 * and a taken port is the sentence from `listenFailure`, because you chose.
 */
export function pinned(env: Record<string, string | undefined>): boolean {
  // `PORT` is the platform's (Railway, Render, Fly) and honours it as
  // ours; a platform that set it routes traffic to it, so roaming away from
  // it would be the worst possible answer.
  return !!(env.SNAGSET_PORT || env.PORT || env.SNAGSET_BASE_URL || env.SNAGSET_PUBLIC_URL);
}

/** The first port at or after `start` that can be bound on `hostname`, or null after `tries`. */
export async function freePort(start: number, hostname: string, tries = 10): Promise<number | null> {
  const { createServer } = await import("node:net");
  for (let port = start; port < start + tries; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, hostname, () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  return null;
}
