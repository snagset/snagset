/**
 * What the platform already knows.
 *
 * Two facts a deploy would otherwise have to repeat by hand, read from
 * variables the PLATFORM sets (never from a request — a domain taken from
 * the Host header is host-header poisoning, and every link the server
 * mails or posts would follow it):
 *
 *   · `PORT` — Railway, Render, Fly and Heroku tell a process where to
 *     listen this way, and route traffic there. The design has promised to
 *     honour it since draft 3; this is where it is honoured.
 *   · The public address — Vercel's `VERCEL_PROJECT_PRODUCTION_URL` (the
 *     stable domain) or `VERCEL_URL` (this deployment's), Railway's
 *     `RAILWAY_PUBLIC_DOMAIN`, Render's `RENDER_EXTERNAL_URL`, Fly's
 *     `FLY_APP_NAME`. With one of these, `SNAGSET_BASE_URL` is a variable
 *     the operator never types.
 *   · The database — `POSTGRES_URL`, when `DATABASE_URL` is unset. Vercel's
 *     Supabase integration writes the pooled string under that name and
 *     never under `DATABASE_URL` (Neon's writes both), so the one deploy
 *     blesses booted "DATABASE_URL is required" on one of the two
 *     marketplace databases it names. Only the pooled name is read; the
 *     integration's `POSTGRES_URL_NON_POOLING` is the direct string, which
 *     is exactly what serverless must not use.
 *
 * Only fills what is unset. Anything the operator set wins, so a custom
 * domain behind a platform's default one is one line, exactly as before.
 * Runs before `loadConfig`, so the validator and every link see the result.
 */
export interface PlatformDefaults {
  port: string | null;
  baseUrl: { value: string; from: string } | null;
  /** The variable `DATABASE_URL` was filled from, when it was. */
  database: string | null;
}

const asHttps = (host: string): string => (/^https?:\/\//.test(host) ? host : `https://${host}`).replace(/\/+$/, "");

export function applyPlatformDefaults(env: Record<string, string | undefined>): PlatformDefaults {
  const out: PlatformDefaults = { port: null, baseUrl: null, database: null };
  if (!env.SNAGSET_PORT && env.PORT && /^\d+$/.test(env.PORT)) {
    env.SNAGSET_PORT = env.PORT;
    out.port = env.PORT;
  }
  if (!env.DATABASE_URL && env.POSTGRES_URL && env.POSTGRES_URL.trim()) {
    env.DATABASE_URL = env.POSTGRES_URL.trim();
    out.database = "POSTGRES_URL";
  }
  if (!env.SNAGSET_BASE_URL && !env.SNAGSET_PUBLIC_URL) {
    const candidates: [string, string | undefined][] = [
      ["VERCEL_PROJECT_PRODUCTION_URL", env.VERCEL_PROJECT_PRODUCTION_URL],
      ["VERCEL_URL", env.VERCEL_URL],
      ["RAILWAY_PUBLIC_DOMAIN", env.RAILWAY_PUBLIC_DOMAIN],
      ["RENDER_EXTERNAL_URL", env.RENDER_EXTERNAL_URL],
      ["FLY_APP_NAME", env.FLY_APP_NAME ? `${env.FLY_APP_NAME}.fly.dev` : undefined],
    ];
    for (const [from, host] of candidates) {
      if (host && host.trim()) {
        const value = asHttps(host.trim());
        env.SNAGSET_BASE_URL = value;
        out.baseUrl = { value, from };
        break;
      }
    }
  }
  return out;
}
