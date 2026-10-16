/**
 * Functions and database on different continents — the slowness nobody sees
 * the cause of.
 *
 * Found on a real deployment: `vercel.json` set no `regions`, so Vercel ran
 * the functions in its default (iad1, Washington) while the database sat in
 * London. Every query crossed the Atlantic, and a dashboard request makes
 * several. Nothing failed; it was just slow, for a week, until someone read
 * an `x-vercel-id` header. This names the mismatch where the owner will see
 * it, with the one-line fix.
 *
 * Both sides are read from what is already there: Vercel sets VERCEL_REGION
 * in every function, and Neon and the Supabase pooler put the AWS region in
 * the database host. Anything else (another platform, a host without a
 * region in its name) is "unknown" and says nothing — a guess shown as a
 * warning is worse than silence.
 */

/** Vercel function regions → the AWS region they run in. */
const VERCEL_TO_AWS: Record<string, string> = {
  iad1: "us-east-1",
  cle1: "us-east-2",
  pdx1: "us-west-2",
  sfo1: "us-west-1",
  yul1: "ca-central-1",
  gru1: "sa-east-1",
  dub1: "eu-west-1",
  lhr1: "eu-west-2",
  cdg1: "eu-west-3",
  fra1: "eu-central-1",
  arn1: "eu-north-1",
  bom1: "ap-south-1",
  sin1: "ap-southeast-1",
  syd1: "ap-southeast-2",
  hnd1: "ap-northeast-1",
  icn1: "ap-northeast-2",
  kix1: "ap-northeast-3",
  hkg1: "ap-east-1",
  cpt1: "af-south-1",
};

const PLACE: Record<string, string> = {
  "us-east-1": "Washington", "us-east-2": "Ohio", "us-west-1": "San Francisco", "us-west-2": "Oregon",
  "ca-central-1": "Montréal", "sa-east-1": "São Paulo", "eu-west-1": "Dublin", "eu-west-2": "London",
  "eu-west-3": "Paris", "eu-central-1": "Frankfurt", "eu-north-1": "Stockholm", "ap-south-1": "Mumbai",
  "ap-southeast-1": "Singapore", "ap-southeast-2": "Sydney", "ap-northeast-1": "Tokyo",
  "ap-northeast-2": "Seoul", "ap-northeast-3": "Osaka", "ap-east-1": "Hong Kong", "af-south-1": "Cape Town",
};

/** The AWS region in a Neon (`ep-x.eu-west-2.aws.neon.tech`) or Supabase pooler (`aws-0-eu-central-1.pooler…`) host. */
export function databaseRegion(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const neon = /\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/.exec(host);
  if (neon) return neon[1]!;
  const pooler = /^aws-\d+-([a-z]{2}-[a-z]+-\d)\.pooler\.supabase\.com$/.exec(host);
  if (pooler) return pooler[1]!;
  return null;
}

export interface RegionMismatch {
  /** Where the functions run, e.g. "iad1 (Washington)". */
  functions: string;
  /** Where the database is, e.g. "eu-west-2 (London)". */
  database: string;
  /** The Vercel region to put in vercel.json's `regions`, when one matches. */
  suggest: string | null;
}

export function regionMismatch(vercelRegion: string | null | undefined, databaseUrl: string | null | undefined): RegionMismatch | null {
  const fn = vercelRegion ? VERCEL_TO_AWS[vercelRegion] : undefined;
  const db = databaseRegion(databaseUrl);
  if (!fn || !db || fn === db) return null;
  const suggest = Object.entries(VERCEL_TO_AWS).find(([, aws]) => aws === db)?.[0] ?? null;
  return {
    functions: `${vercelRegion} (${PLACE[fn] ?? fn})`,
    database: `${db} (${PLACE[db] ?? db})`,
    suggest,
  };
}
