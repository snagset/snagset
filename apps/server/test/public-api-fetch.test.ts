import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { publicApiFetch, PublicFetchError } from "../src/net/publicFetch.ts";

/**
 * The guarded fetch the Jira client uses for a typed site URL (0.1.55). Two
 * local servers stand in for "the tracker" and "somewhere else"; both are on
 * 127.0.0.1, so `allowPrivate` is on except where the block itself is tested.
 */

let a: Server;
let b: Server;
let aUrl = "";
let bUrl = "";
const seen: { path: string; method: string; auth: string; body: string }[] = [];

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  });
}

before(async () => {
  ({ server: b, url: bUrl } = await listen((req, res) => {
    seen.push({ path: req.url!, method: req.method!, auth: String(req.headers.authorization ?? ""), body: "" });
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  }));
  ({ server: a, url: aUrl } = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ path: req.url!, method: req.method!, auth: String(req.headers.authorization ?? ""), body: Buffer.concat(chunks).toString("utf8") });
      if (req.url === "/json") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      if (req.url === "/same") return res.writeHead(302, { location: "/json" }).end();
      if (req.url === "/elsewhere") return res.writeHead(302, { location: `${bUrl}/steal` }).end();
      if (req.url === "/loop") return res.writeHead(302, { location: "/loop" }).end();
      if (req.url === "/empty") return res.writeHead(204).end();
      if (req.url === "/big") return res.writeHead(200).end("x".repeat(5000));
      if (req.url === "/hang") return; // never answers
      res.writeHead(404).end();
    });
  }));
});

after(() => {
  a?.close();
  b?.close();
});

const open = publicApiFetch({ allowPrivate: true, timeoutMs: 1500, maxBytes: 1000 });

test("an answer comes back as a Response: status, JSON, headers and body sent as given", async () => {
  const res = await open(`${aUrl}/json`, { method: "POST", headers: { authorization: "Basic x", "content-type": "application/json" }, body: '{"a":1}' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const got = seen.find((s) => s.path === "/json" && s.method === "POST")!;
  assert.equal(got.auth, "Basic x");
  assert.equal(got.body, '{"a":1}');
  assert.equal((await open(`${aUrl}/empty`)).status, 204);
});

test("a redirect within the same origin is followed", async () => {
  const res = await open(`${aUrl}/same`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("a redirect to another origin is refused, and the credentials never reach it", async () => {
  seen.length = 0;
  await assert.rejects(open(`${aUrl}/elsewhere`, { headers: { authorization: "Basic secret" } }), (e) => e instanceof PublicFetchError && e.code === "bad_url");
  assert.ok(!seen.some((s) => s.path === "/steal"), "the other server was never asked");
});

test("a redirect loop ends", async () => {
  await assert.rejects(open(`${aUrl}/loop`), (e) => e instanceof PublicFetchError && e.code === "too_many_redirects");
});

test("an address that never answers times out; an answer too large is cut off", async () => {
  const t0 = Date.now();
  await assert.rejects(open(`${aUrl}/hang`), (e) => e instanceof PublicFetchError && e.code === "timeout");
  assert.ok(Date.now() - t0 < 4000);
  await assert.rejects(open(`${aUrl}/big`), (e) => e instanceof PublicFetchError && e.code === "too_large");
});

test("without the operator's word, a private address is refused before anything is sent — literal or by name", async () => {
  const guarded = publicApiFetch({ timeoutMs: 1500 });
  seen.length = 0;
  for (const url of [`${aUrl}/json`, "http://169.254.169.254/latest", "http://[::1]:5432/", "http://10.1.2.3/"]) {
    await assert.rejects(guarded(url), (e) => e instanceof PublicFetchError && e.code === "blocked_address", url);
  }
  // `localhost` is a name: judged by what it resolves to, inside the socket's
  // lookup. On port 80, so the port rule is not what refuses it.
  await assert.rejects(guarded("http://localhost/json"), (e) => e instanceof PublicFetchError && e.code === "blocked_address");
  assert.equal(seen.length, 0, "nothing reached the local server");
  await assert.rejects(guarded("file:///etc/passwd"), (e) => e instanceof PublicFetchError && e.code === "bad_url");
  await assert.rejects(guarded("http://user:pw@example.com/"), (e) => e instanceof PublicFetchError && e.code === "bad_url");
  // A public host on any port but the web's is a probe, not a tracker.
  await assert.rejects(guarded("http://93.184.216.34:22/"), (e) => e instanceof PublicFetchError && e.code === "bad_url");
});
