import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchPublicImage, isPublicAddress, PublicFetchError } from "../src/net/publicFetch.ts";

/**
 * The image proxy's fetcher — the part that decides what the server may
 * connect to. Found reviewing Acme, whose images came out blank in the
 * screenshot because their host sends no CORS headers.
 *
 * The address checks are the point of this file: a route that fetches URLs a
 * browser hands it is a route that can be aimed at localhost, the private
 * network or the cloud metadata address, and none of that may ever answer.
 */

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000100e5270de40000000049454e44ae426082",
  "hex",
);

let server: http.Server;
let base = "";

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/pic.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<h1>not a picture</h1>");
    }
    if (req.url === "/huge.png") {
      res.writeHead(200, { "content-type": "image/png" });
      // No Content-Length: the cap must hold on bytes counted, not declared.
      return res.end(Buffer.alloc(64 * 1024));
    }
    if (req.url === "/hop") {
      res.writeHead(302, { location: "/pic.png" });
      return res.end();
    }
    if (req.url === "/to-file") {
      res.writeHead(302, { location: "file:///etc/passwd" });
      return res.end();
    }
    if (req.url === "/loop") {
      res.writeHead(302, { location: "/loop" });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

const open = { maxBytes: 1024 * 1024, timeoutMs: 2_000, allowPrivate: true };
const real = { maxBytes: 1024 * 1024, timeoutMs: 2_000 };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    assert.ok(e instanceof PublicFetchError, `expected PublicFetchError, got ${String(e)}`);
    return e.code;
  }
}

test("private, loopback, link-local and metadata addresses are not public", () => {
  for (const a of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "64:ff9b::a00:1",
    "not-an-ip",
  ]) {
    assert.equal(isPublicAddress(a), false, a);
  }
  for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(a), true, a);
  }
});

test("an image comes back with its type", async () => {
  const r = await fetchPublicImage(`${base}/pic.png`, open);
  assert.equal(r.contentType, "image/png");
  assert.deepEqual(Buffer.from(r.bytes), PNG);
});

test("a redirect is followed to the image", async () => {
  const r = await fetchPublicImage(`${base}/hop`, open);
  assert.equal(r.contentType, "image/png");
});

test("anything that is not an image is refused", async () => {
  assert.equal(await code(fetchPublicImage(`${base}/page`, open)), "not_an_image");
});

test("the size cap holds on the bytes that arrive, not the header", async () => {
  assert.equal(await code(fetchPublicImage(`${base}/huge.png`, { ...open, maxBytes: 1024 })), "too_large");
});

test("localhost is refused by default — by name and by literal address", async () => {
  // The same server the cases above reached, now without the test switch.
  const port = (server.address() as AddressInfo).port;
  assert.equal(await code(fetchPublicImage(`http://localhost/pic.png`, real)), "blocked_address");
  assert.equal(await code(fetchPublicImage(`http://127.0.0.1/pic.png`, real)), "blocked_address");
  assert.equal(await code(fetchPublicImage(`http://[::1]/pic.png`, real)), "blocked_address");
  // A port off the web's two is refused before any connection is tried.
  assert.equal(await code(fetchPublicImage(`http://127.0.0.1:${port}/pic.png`, real)), "bad_url");
});

test("the cloud metadata address is refused", async () => {
  assert.equal(await code(fetchPublicImage("http://169.254.169.254/latest/meta-data/", real)), "blocked_address");
  assert.equal(await code(fetchPublicImage("http://[fd00:ec2::254]/latest/meta-data/", real)), "blocked_address");
});

test("every redirect hop is judged again, and the chain is bounded", async () => {
  // The first hop is fine; where it points is not. A redirect is the easy way
  // round a check made only on the URL the browser handed over.
  assert.equal(await code(fetchPublicImage(`${base}/to-file`, open)), "bad_url");
  assert.equal(await code(fetchPublicImage(`${base}/loop`, open)), "too_many_redirects");
});

test("only http and https, and no credentials in the URL", async () => {
  assert.equal(await code(fetchPublicImage("file:///etc/passwd", real)), "bad_url");
  assert.equal(await code(fetchPublicImage("ftp://example.com/a.png", real)), "bad_url");
  assert.equal(await code(fetchPublicImage("https://user:pw@example.com/a.png", real)), "bad_url");
  assert.equal(await code(fetchPublicImage("not a url", real)), "bad_url");
});
