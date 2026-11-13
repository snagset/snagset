import { test } from "node:test";
import assert from "node:assert/strict";
import { briefMarkdown } from "../src/lib/brief.ts";
import type { Thread } from "../src/lib/api.ts";

const thread: Thread = {
  id: "thr_1",
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
    prefersColorScheme: "light",
    breadcrumbs: [{ t: "2026-09-03T10:11:12.000Z", type: "console", level: "error", message: "TypeError: x is not a function" }],
  },
  roundNumber: 3,
  comments: [
    { id: "c1", body: "The pricing table wraps at 1280.\nOn my laptop it looks broken.", createdAt: "2026-09-03T10:12:00.000Z", author: { id: "r1", name: "Marta", kind: "reviewer" } },
    { id: "c2", body: null, createdAt: "2026-09-03T10:13:00.000Z", author: { id: "r1", name: "Marta", kind: "reviewer" } },
  ],
  attachments: [{ id: "att_1", kind: "screenshot", contentType: "image/webp", width: 1440, height: 900, url: "/api/v1/attachments/att_1/blob" }],
  createdBy: { name: "Marta", kind: "reviewer" },
  createdAt: "2026-09-03T10:12:00.000Z",
  updatedAt: "2026-09-03T10:40:00.000Z",
  commentCount: 2,
};

test("the brief leads with where to look, then the words, then the environment", () => {
  const md = briefMarkdown(thread, { name: "Kilnwork", dashboardOrigin: "https://snagset.example.dev" });
  const i = (s: string) => md.indexOf(s);
  assert.ok(i("# SN-14 — table “Plans”") === 0);
  assert.ok(i("## Where to look") < i("## What's wrong"));
  assert.ok(i("## What's wrong") < i("## Environment"));
  assert.ok(i("## Environment") < i("## Breadcrumbs"));
  assert.ok(i("## Breadcrumbs") < i("## Screenshot"));
  assert.match(md, /- Page: https:\/\/kilnwork\.studio\/pricing\n/);
  assert.match(md, /\?snag_t=SN-14/);
  assert.match(md, /- Selector: `main \.pricing > table`/);
  assert.match(md, /- Anchor: anchored/);
});

test("a tombstoned comment is left out; a multi-line one stays quoted line by line", () => {
  const md = briefMarkdown(thread, { name: "Kilnwork" });
  assert.match(md, /> \*\*Marta\*\* — 2026-09-03 10:12\n> The pricing table wraps at 1280\.\n> On my laptop it looks broken\./);
  assert.doesNotMatch(md, /10:13/);
});

test("the screenshot is an absolute URL with the instruction an agent needs", () => {
  const md = briefMarkdown(thread, { name: "Kilnwork", dashboardOrigin: "https://snagset.example.dev" });
  assert.match(md, /Examine this screenshot/);
  assert.match(md, /!\[SN-14 at 1440×900\]\(https:\/\/snagset\.example\.dev\/api\/v1\/attachments\/att_1\/blob\)/);
});

test("nothing is invented: no screenshot, no breadcrumbs, no section", () => {
  const bare: Thread = { ...thread, attachments: [], context: { viewport: { w: 390, h: 844, dpr: 3 } } };
  const md = briefMarkdown(bare, { name: "Kilnwork" });
  assert.doesNotMatch(md, /## Screenshot/);
  assert.doesNotMatch(md, /## Breadcrumbs/);
  assert.match(md, /- Viewport: 390 × 844 @3x/);
});

test("the header names the assignee when there is one, and says nothing when there is none", () => {
  const site = { name: "Kilnwork" };
  const held = briefMarkdown({ ...thread, assignee: { id: "rev_2", name: "Joel Rocha", kind: "verified", isTeam: true } }, site);
  assert.match(held, /left by Marta on 2026-09-03 · assigned to Joel Rocha/);
  assert.doesNotMatch(briefMarkdown({ ...thread, assignee: null }, site), /assigned to/);
});
