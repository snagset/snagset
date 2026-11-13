import { test } from "node:test";
import assert from "node:assert/strict";
import { briefMarkdown, type BriefThread } from "../src/brief.ts";

const thread: BriefThread = {
  key: "SN-14",
  status: "progress",
  anchor: {
    label: "table “Plans”",
    css: "main .pricing > table",
    page: { origin: "https://kilnwork.studio", pathname: "/pricing", route: "/pricing" },
    text: { exact: "Plans" },
  },
  anchorState: "anchored",
  context: {
    derived: { browser: "Chrome 131", os: "macOS", device: "Desktop" },
    viewport: { w: 1440, h: 900, dpr: 2 },
    breadcrumbs: [{ t: "2026-09-03T10:11:12.000Z", type: "console", level: "error", message: "TypeError: x is not a function" }],
  },
  comments: [
    { body: "The pricing table wraps at 1280.\nOn my laptop it looks broken.", createdAt: "2026-09-03T10:12:00.000Z", author: { name: "Marta", kind: "guest" } },
    { body: null, createdAt: "2026-09-03T10:13:00.000Z", author: { name: "Marta", kind: "guest" } },
  ],
  attachments: [{ kind: "screenshot", url: "/api/v1/attachments/att_1/blob", width: 1440, height: 900 }],
  createdBy: { name: "Marta" },
  createdAt: "2026-09-03T10:12:00.000Z",
};
const site = { name: "Kilnwork", dashboardOrigin: "https://review.example.dev" };

test("the brief leads with where to look, then the words, then the environment, then the picture", () => {
  const md = briefMarkdown(thread, site);
  assert.match(md, /^# SN-14 — table “Plans”\n/);
  assert.match(md, /Kilnwork · In progress · left by Marta on 2026-09-03\n/);
  const order = ["## Where to look", "## What's wrong", "## Environment", "## Breadcrumbs", "## Screenshot"].map((h) => md.indexOf(h));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!)), `sections out of order: ${order.join(",")}`);
  assert.match(md, /- Open on the page: https:\/\/kilnwork\.studio\/pricing\?snag_t=SN-14/);
  assert.match(md, /- Selector: `main \.pricing > table`/);
  assert.match(md, /- Viewport: 1440 × 900 @2x/);
  assert.match(md, /!\[SN-14 at 1440×900\]\(https:\/\/review\.example\.dev\/api\/v1\/attachments\/att_1\/blob\)/);
});

test("a tombstone is left out; a multi-line comment stays quoted line by line", () => {
  const md = briefMarkdown(thread, site);
  assert.match(md, /> \*\*Marta\*\* — 2026-09-03 10:12\n> The pricing table wraps at 1280\.\n> On my laptop it looks broken\.\n/);
  assert.doesNotMatch(md, /10:13/);
});

test("the fence wraps every string a reviewer could have typed, and nothing we minted", () => {
  const md = briefMarkdown(thread, site, { fence: (kind, v) => `<u kind="${kind}">${v}</u>` });
  assert.match(md, /^# SN-14 — <u kind="label">table “Plans”<\/u>/);
  assert.match(md, /left by <u kind="name">Marta<\/u>/);
  assert.match(md, /- Selector: `<u kind="selector">main \.pricing > table<\/u>`/);
  assert.match(md, /console\/error: <u kind="breadcrumb">TypeError: x is not a function<\/u>/);
  // The body is fenced as ONE string and then quoted line by line, so the
  // fence opens on the first line and closes on the last.
  assert.match(md, /> <u kind="body">The pricing table wraps at 1280\.\n> On my laptop it looks broken\.<\/u>/);
  // Keys, dates and the status are ours.
  assert.doesNotMatch(md, /<u kind="[a-z]+">SN-14/);
  assert.doesNotMatch(md, /<u kind="[a-z]+">In progress/);
});

test("nothing is invented: no screenshot, no breadcrumbs, no assignee — no section, no line", () => {
  const bare: BriefThread = { ...thread, attachments: [], context: { viewport: { w: 390, h: 844 } }, assignee: null };
  const md = briefMarkdown(bare, { name: "Kilnwork" });
  assert.doesNotMatch(md, /## Screenshot/);
  assert.doesNotMatch(md, /## Breadcrumbs/);
  assert.doesNotMatch(md, /assigned to/);
  assert.match(md, /- Viewport: 390 × 844\n/);
});

test("the header names the assignee when there is one", () => {
  const md = briefMarkdown({ ...thread, assignee: { name: "Joel Rocha" } }, site);
  assert.match(md, /left by Marta on 2026-09-03 · assigned to Joel Rocha\n/);
});
