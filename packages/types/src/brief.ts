/**
 * A thread as a BRIEF — the markdown an agent, a ticket or a clipboard wants:
 * Where to look · What's wrong · Environment · Breadcrumbs · Screenshot.
 *
 * ONE formatter in the shared package, so the dashboard's
 * Copy button, the MCP server's `get_thread` and the server's own markdown
 * route cannot drift from one another. Pure: a thread in, a string out, no
 * clock, so the same thread always produces the same brief.
 *
 * STRUCTURAL INPUT. `BriefThread` is the intersection of what the dashboard's
 * `Thread` and the MCP's `WireThread` both carry — nothing here imports
 * either, which is what lets both hand their own type in unchanged.
 *
 * THE FENCE. Every string a reviewer could have typed — a comment body, a
 * name, an element label, a breadcrumb message — passes through `fence`
 * before it is written. The dashboard passes nothing (the clipboard is the
 * studio's own), the MCP server passes `@snagset/adapters`' fence so a model
 * reads `<untrusted-content kind="body">…</untrusted-content>` around the
 * client's words. Ids, keys, timestamps and enums we
 * minted are written bare.
 */

import { param } from "./names.ts";

export type BriefFenceKind = "body" | "name" | "label" | "selector" | "breadcrumb";

export interface BriefComment {
  /** Null is a tombstone and is left out. */
  body: string | null;
  createdAt: string;
  author?: { name?: string; kind?: string };
}

export interface BriefAttachment {
  kind: string;
  url: string;
  width?: number;
  height?: number;
}

export interface BriefThread {
  key: string;
  status: string;
  anchor?: Record<string, unknown> | null;
  anchorState?: string;
  context?: Record<string, unknown> | null;
  comments?: BriefComment[];
  attachments?: BriefAttachment[];
  createdBy?: { name?: string };
  assignee?: { name: string } | null;
  createdAt: string;
  route?: string;
}

export interface BriefSite {
  name: string;
  /** The site's address for the page link; empty when unknown. */
  origin?: string;
  /** Where the instance lives, for the screenshot's absolute URL. */
  dashboardOrigin?: string;
}

export interface BriefOptions {
  /** Wrap one untrusted string. Identity when absent. */
  fence?: (kind: BriefFenceKind, value: string) => string;
  /** Status keys → words; the key itself when absent. */
  statusLabel?: (status: string) => string;
}

const STATUS_WORDS: Record<string, string> = { open: "Open", progress: "In progress", review: "In review", resolved: "Resolved" };

export function briefMarkdown(t: BriefThread, site: BriefSite, opts: BriefOptions = {}): string {
  const f = opts.fence ?? ((_k: BriefFenceKind, v: string) => v);
  const word = opts.statusLabel ?? ((s: string) => STATUS_WORDS[s] ?? s);
  const anchor = (t.anchor ?? {}) as Record<string, unknown>;
  const ctx = (t.context ?? {}) as Record<string, any>;
  const page = anchor["page"] as { origin?: string; pathname?: string; route?: string } | undefined;
  const route = page?.route ?? t.route ?? "/";
  const origin = page?.origin ?? site.origin ?? "";
  const pathname = page?.pathname ?? route;
  const url = origin ? `${origin}${pathname}` : pathname;
  const label = typeof anchor["label"] === "string" ? f("label", anchor["label"]) : "";
  // The element's fields sit at the top level on the wire the widget writes,
  // and under `element` in the MCP fixtures; both are read.
  const el = ((anchor["element"] as Record<string, unknown> | undefined) ?? anchor) as Record<string, unknown>;
  const lines: string[] = [];

  lines.push(`# ${t.key}${label ? ` — ${label}` : ""}`);
  lines.push("");
  lines.push(
    `${site.name} · ${word(t.status)} · left by ${t.createdBy?.name ? f("name", t.createdBy.name) : "someone"} on ${t.createdAt.slice(0, 10)}` +
      (t.assignee ? ` · assigned to ${f("name", t.assignee.name)}` : ""),
  );
  lines.push("");

  lines.push("## Where to look");
  lines.push("");
  lines.push(`- Page: ${url}`);
  if (origin) lines.push(`- Open on the page: ${origin}${pathname}?${param("t")}=${encodeURIComponent(t.key)}`);
  if (label) lines.push(`- Element: ${label}`);
  const css = typeof anchor["css"] === "string" ? anchor["css"] : typeof el["selector"] === "string" ? el["selector"] : "";
  if (css) lines.push(`- Selector: \`${f("selector", css)}\``);
  if (typeof anchor["domid"] === "string") lines.push(`- DOM id: \`#${f("selector", anchor["domid"])}\``);
  if (typeof el["role"] === "string") {
    const name = typeof el["accessibleName"] === "string" ? ` “${f("label", el["accessibleName"])}”` : "";
    lines.push(`- Role: ${f("label", el["role"])}${name}`);
  }
  if (typeof el["testId"] === "string") lines.push(`- Test id: ${f("label", el["testId"])}`);
  const text = anchor["text"] as { exact?: string } | undefined;
  if (text?.exact) lines.push(`- Text: “${f("label", text.exact)}”`);
  lines.push(`- Anchor: ${t.anchorState ?? "unknown"}`);
  lines.push("");

  lines.push("## What's wrong");
  lines.push("");
  const readable = (t.comments ?? []).filter((c) => c.body !== null);
  if (readable.length === 0) lines.push("> (no comment — a pin with no words)");
  for (const c of readable) {
    const who = c.author?.name ? f("name", c.author.name) : "Anonymous";
    lines.push(`> **${who}${c.author?.kind === "agent" ? " (agent)" : ""}** — ${c.createdAt.slice(0, 16).replace("T", " ")}`);
    for (const l of f("body", String(c.body)).split("\n")) lines.push(`> ${l}`);
    lines.push(">");
  }
  if (lines[lines.length - 1] === ">") lines.pop();
  lines.push("");

  lines.push("## Environment");
  lines.push("");
  const d = ctx.derived as { browser?: string; os?: string; device?: string } | undefined;
  const vp = ctx.viewport as { w?: number; h?: number; dpr?: number } | undefined;
  if (d?.browser || d?.os) lines.push(`- Browser: ${[d.browser, d.os, d.device].filter(Boolean).join(" · ")}`);
  if (vp?.w) lines.push(`- Viewport: ${vp.w} × ${vp.h}${vp.dpr ? ` @${Math.round(vp.dpr * 10) / 10}x` : ""}`);
  if (ctx.prefersColorScheme) lines.push(`- Colour scheme: ${ctx.prefersColorScheme}`);
  if (ctx.language) lines.push(`- Language: ${ctx.language}`);
  if (ctx.ua) lines.push(`- User agent: ${f("label", String(ctx.ua))}`);
  const build = ctx.build as Record<string, unknown> | undefined;
  if (build && Object.keys(build).length) {
    lines.push(`- Build: ${Object.entries(build).map(([k, v]) => `${k}=${f("label", String(v))}`).join(", ")}`);
  }
  lines.push("");

  const crumbs = ctx.breadcrumbs as { t: string; type: string; level?: string; message: string }[] | undefined;
  if (crumbs?.length) {
    lines.push(`## Breadcrumbs (${crumbs.length}, oldest first)`);
    lines.push("");
    for (const b of crumbs) {
      lines.push(`- \`${String(b.t).slice(11, 19)}\` ${b.type}${b.level ? `/${b.level}` : ""}: ${f("breadcrumb", String(b.message))}`);
    }
    lines.push("");
  }

  const shot = t.attachments?.find((a) => a.kind === "screenshot") ?? t.attachments?.[0];
  if (shot) {
    lines.push("## Screenshot");
    lines.push("");
    lines.push("Examine this screenshot for visual context — it is the viewport at the moment of the click.");
    lines.push("");
    const abs = shot.url.startsWith("http") ? shot.url : `${site.dashboardOrigin ?? ""}${shot.url}`;
    lines.push(`![${t.key}${shot.width ? ` at ${shot.width}×${shot.height}` : ""}](${abs})`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
