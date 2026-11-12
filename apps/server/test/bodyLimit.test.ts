import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { bodyLimit, JSON_BODY_CAP } from "../src/routes/bodyLimit.ts";

/** A route that reads the stream itself, as `POST /mcp` does through the SDK. */
function app() {
  const a = new Hono<{ Variables: { requestId: string } }>();
  a.use("*", async (c, next) => {
    c.set("requestId", "req_test");
    await next();
  });
  a.use("*", bodyLimit(() => 1024 * 1024) as never);
  a.post("/read", async (c) => c.json({ bytes: (await c.req.raw.arrayBuffer()).byteLength }));
  return a;
}

/** A body sent in pieces, with no length said up front. */
const chunked = (bytes: number, type = "application/json") =>
  new Request("http://localhost/read", {
    method: "POST",
    headers: { "content-type": type },
    body: new ReadableStream({
      start(controller) {
        const piece = new Uint8Array(64 * 1024).fill(120);
        for (let left = bytes; left > 0; left -= piece.length) controller.enqueue(left >= piece.length ? piece : piece.slice(0, left));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);

test("a chunked JSON body is counted as it is read: over the cap is 413, with no length to take on trust", async () => {
  const over = await app().fetch(chunked(JSON_BODY_CAP + 1));
  assert.equal(over.status, 413);
  const said = (await over.json()) as { error: { code: string; message: string; requestId: string } };
  assert.equal(said.error.code, "body_too_large");
  assert.match(said.error.message, /over the limit; the limit here is 256 KB/);
  assert.equal(said.error.requestId, "req_test");
});

test("a chunked body under the cap reaches the route whole", async () => {
  const res = await app().fetch(chunked(JSON_BODY_CAP));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { bytes: JSON_BODY_CAP });
});

test("a length said twice over is not believed: a small Content-Length beside a chunked body is still counted", async () => {
  const req = chunked(JSON_BODY_CAP + 1);
  req.headers.set("content-length", "10");
  req.headers.set("transfer-encoding", "chunked");
  assert.equal((await app().fetch(req)).status, 413);
});

test("the binary cap is the operator's, and counted the same way; a declared length is still refused before a byte is read", async () => {
  assert.equal((await app().fetch(chunked(1024 * 1024, "application/octet-stream"))).status, 200);
  assert.equal((await app().fetch(chunked(1024 * 1024 + 1, "application/octet-stream"))).status, 413);
  const declared = await app().request("/read", { method: "POST", headers: { "content-type": "application/json", "content-length": String(JSON_BODY_CAP + 1) }, body: "{}" });
  assert.equal(declared.status, 413);
  assert.match(((await declared.json()) as { error: { message: string } }).error.message, /is 256 KB; the limit here is 256 KB/);
});
