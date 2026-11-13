import { AwsClient } from "aws4fetch";
import { createHash, randomUUID } from "node:crypto";

/**
 * The bucket — –L4.
 *
 * *"if no bucket then you just save the information… some people just might
 * use it for annotation."* Bytes never live in Postgres; `pg_dump` carries
 * every row and the pixels sit in a bucket that was already yours.
 *
 * `aws4fetch`, and `@aws-sdk/client-s3` is BANNED ((b)). The reason is
 * size and shape: the AWS SDK is tens of megabytes of middleware stack for
 * what is, here, four signed HTTP requests. A9 promises one npm package that
 * `npx` can run; a dependency an order of magnitude larger than the product
 * is not that.
 */

export interface BucketConfig {
  /** e.g. `https://<account>.r2.cloudflarestorage.com` — scheme required. */
  endpoint: string;
  bucket: string;
  region: string;
  /** Optional CDN origin for public reads (`SNAGSET_STORAGE_S3_PUBLIC_BASE_URL`
   *  in the deleted env-var world; opt-in, and carries its warnings). */
  publicBaseUrl?: string;
}

export interface BucketCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface Bucket {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  del(key: string): Promise<void>;
  /** A real write-read-delete round trip. Requires it at connect time:
   *  credentials that are merely well-formed are the ones that fail on the
   *  first screenshot, in front of a reviewer, an hour later. */
  probe(): Promise<{ ok: true } | { ok: false; step: string; detail: string }>;
}


/**
 * Turn an S3 error into a sentence that names the fix.
 *
 * Every S3-compatible service answers with the same XML `<Code>`, and those
 * codes map cleanly onto the four things an operator actually got wrong. The
 * raw XML is 200 characters of RequestId and HostId around one useful word —
 * and the first real attempt at connecting a bucket failed with
 * `InvalidAccessKeyId`, where the useful next step ("that is the secret, not
 * the access key id") is not in the response at all.
 */
async function describeS3Error(method: string, res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? "";
  const hint: Record<string, string> = {
    InvalidAccessKeyId:
      "the ACCESS KEY ID is not recognised. On DigitalOcean Spaces it is the short value " +
      "(20 chars, usually starting DO00…), not the 43-character secret beside it — and a DO " +
      "API token is a different credential that cannot sign S3 requests.",
    SignatureDoesNotMatch:
      "the SECRET does not match that access key. Check for a truncated paste, and that the " +
      "region matches the one in the endpoint (ams3 with ams3, fra1 with fra1).",
    NoSuchBucket: "there is no bucket/Space with that name in this region.",
    AccessDenied:
      "the credentials are valid but not permitted to do this. The key needs write, read AND " +
      "delete — delete is what an erasure request needs.",
    RequestTimeTooSkewed: "this machine's clock is too far from the server's for the signature to validate.",
  };
  const known = hint[code];
  if (known) return `${code} — ${known}`;
  return `${method} ${res.status}${code ? ` ${code}` : ""}: ${body.replace(/\s+/g, " ").slice(0, 160)}`;
}

export function createBucket(config: BucketConfig, creds: BucketCredentials): Bucket {
  const aws = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    service: "s3",
    region: config.region,
  });
  const base = `${config.endpoint.replace(/\/+$/, "")}/${config.bucket}`;
  const url = (key: string): string => `${base}/${encodeURI(key)}`;

  return {
    async put(key, body, contentType) {
      const res = await aws.fetch(url(key), {
        method: "PUT",
        body,
        headers: {
          "content-type": contentType,
          // (c): the disposition is signed into the object
          // itself, not decided at read time. This is the XSS-on-bucket-domain
          // prevention — a stored `text/html` served inline from the bucket's
          // own origin is a script running beside whatever else is in there.
          "content-disposition": "attachment",
        },
      });
      if (!res.ok) throw new Error(await describeS3Error("PUT", res));
    },

    async get(key) {
      const res = await aws.fetch(url(key));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(await describeS3Error("GET", res));
      return new Uint8Array(await res.arrayBuffer());
    },

    async del(key) {
      const res = await aws.fetch(url(key), { method: "DELETE" });
      // 204 and 404 are both "it is not there", which is what was asked for.
      if (!res.ok && res.status !== 404) throw new Error(await describeS3Error("DELETE", res));
    },

    async probe() {
      const key = `.snagset-probe/${randomUUID()}`;
      const payload = new TextEncoder().encode("snagset");
      try {
        await this.put(key, payload, "application/octet-stream");
      } catch (e) {
        return { ok: false, step: "write", detail: (e as Error).message };
      }
      try {
        const back = await this.get(key);
        if (!back || Buffer.compare(Buffer.from(back), Buffer.from(payload)) !== 0) {
          return { ok: false, step: "read", detail: "the object read back did not match what was written" };
        }
      } catch (e) {
        return { ok: false, step: "read", detail: (e as Error).message };
      }
      try {
        await this.del(key);
      } catch (e) {
        // Write and read work, delete does not: usable for uploads and unable
        // to honour erasure. Worth failing the connect over, because
        // discovering it during a deletion request is far worse.
        return { ok: false, step: "delete", detail: (e as Error).message };
      }
      return { ok: true };
    },
  };
}

/**
 * The object key for an attachment.
 *
 * Hash-based, never the reviewer's filename: The comment says "storage
 * keys are hashes ", and the reason is that a key derived from user
 * input is a path traversal, a collision and an information leak in one
 * field. The project id prefixes it so a bucket shared between projects can
 * still be reasoned about, and so erasure can list by prefix.
 */
export function storageKeyFor(projectId: string, bytes: Uint8Array, ext: string): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `${projectId}/${digest.slice(0, 2)}/${digest}.${ext}`;
}
