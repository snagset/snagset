import { fenced, DATA_BOUNDARY } from "@snagset/adapters/outbound/fence";
import { sanitise, trusted } from "@snagset/adapters/outbound/sanitise";
import { briefMarkdown, type BriefFenceKind, type BriefThread } from "@snagset/types/brief";

/**
 * The view an agent sees, and the four mitigations that live in
 * a projection rather than in a policy.
 *
 * `ThreadSummary` and `ThreadDetail` are projections of
 * `OutboundThreadView<'plain'>`, *"not of `Thread`. That is deliberate and load
 * bearing: the MCP server gets the same sanitiser, the same clamps and the same
 * fixture corpus as every provider."* So every string that a reviewer could
 * have typed goes through `@snagset/adapters` on the way to a model, and this
 * package holds no scrubbing logic of its own.
 *
 * ── WHAT IS DELIBERATELY MISSING ──
 *
 * On orphans, states the general rule this file follows everywhere:
 * *"a payload that promises fields the release does not have is worse than a
 * short one."* `OutboundThreadView` lists `branch`, `labels`, `assigneeName`,
 * `viewport`, `browser`, `platform` and `prefersColorScheme`; the L1 API does
 * not serve most of them yet. They are absent here rather than emitted empty,
 * because an agent that reads `labels: []` concludes the thread has no labels.
 *
 * ── THE FENCE ──
 *
 * Every Class R and Class P string is WRAPPED, not merely escaped:
 * `<untrusted-content kind="…">…</untrusted-content>`.
 * `author` is fenced too — the review found it emitted bare while already
 * listed `Reviewer.name` among the untrusted strings reaching the model, *"the
 * kind of contradiction that survives because the two facts sat four pages
 * apart."*
 */

/** The third place the token becomes irreversible. */
export const SCHEMA_VERSION = "snagset.v1";

/** The clamp: comments capped at 50, oldest first. */
export const MAX_COMMENTS = 50;
/** `limit` ≤ 50 on `list_threads`. */
export const MAX_THREADS = 50;

/**
 * Clamps on the fenced strings themselves.
 *
 * A comment body is capped at 10 000 characters server-side, and fifty of them
 * is half a megabyte of a model's context spent on one tool call. 4 000 is the
 * length at which a snag's text stops being a snag and starts being a document
 * somebody pasted *(calibration, like every number)*.
 */
const CLAMP = { body: 4_000, name: 200, label: 400, selector: 600 } as const;

/** The wire shapes this package reads — `threads.ts`'s `shape()`, narrowed. */
export interface WireComment {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; name: string; kind: string };
}
export interface WireThread {
  id: string;
  key: string;
  status: string;
  anchorState?: string;
  anchor?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  commentCount?: number;
  route?: string;
  environment?: string;
  round?: number;
  roundNumber?: number;
  createdBy?: { id?: string; name?: string; kind?: string };
  comments?: WireComment[];
  attachments?: { id: string; kind: string; url: string; width?: number; height?: number }[];
}

/**
 * The anchor's human-readable half, fenced.
 *
 * `sourceRef` is NOT read here and that is: source locations never leave
 * the machine. It is the one field the local MCP server *may* read — but only
 * in `map_thread_to_source`, where it never leaves either.
 */
function element(anchor: Record<string, unknown> | null | undefined): Record<string, string> {
  if (!anchor || typeof anchor !== "object") return {};
  const out: Record<string, string> = {};
  const el = (anchor["element"] ?? anchor) as Record<string, unknown>;
  const put = (key: string, kind: "label" | "selector", max: number) => {
    const v = el[key];
    if (typeof v === "string" && v) out[key] = fenced(kind, v, max);
  };
  put("role", "label", CLAMP.label);
  put("accessibleName", "label", CLAMP.label);
  put("testId", "label", CLAMP.label);
  put("selector", "selector", CLAMP.selector);
  return out;
}

/** `Thread` → what `list_threads` returns per row. */
export function summary(t: WireThread): Record<string, unknown> {
  return {
    id: t.id,
    key: t.key,
    status: t.status,
    anchorState: t.anchorState ?? "unknown",
    // Class S — ids, enums and timestamps we minted. `trusted()` is greppable
    // on purpose: the review question is "is this genuinely ours?" rather than
    // "what does this do?".
    createdAt: trusted<"plain">(t.createdAt),
    updatedAt: trusted<"plain">(t.updatedAt),
    ...(t.environment ? { environment: t.environment } : {}),
    ...(t.round !== undefined ? { round: t.round } : {}),
    ...(t.route ? { route: fenced("label", t.route, CLAMP.label) } : {}),
    commentCount: t.commentCount ?? 0,
    ...(t.createdBy?.name ? { author: fenced("name", t.createdBy.name, CLAMP.name) } : {}),
    // The first comment IS the snag (writes them in one transaction),
    // so a summary without it is a list of keys. Clamped harder than the
    // detail's: this one appears fifty times in a single result.
    ...(t.comments?.[0] ? { firstComment: fenced("body", t.comments[0].body, 500) } : {}),
    element: element(t.anchor),
  };
}

/** `get_thread` — the same row plus its conversation. */
export function detail(t: WireThread): Record<string, unknown> {
  const comments = (t.comments ?? []).slice(0, MAX_COMMENTS).map((c) => ({
    id: c.id,
    createdAt: trusted<"plain">(c.createdAt),
    author: fenced("name", c.author?.name ?? "Someone", CLAMP.name),
    authorKind: c.author?.kind ?? "guest",
    body: fenced("body", c.body ?? "", CLAMP.body),
  }));
  return {
    ...summary(t),
    // Replaced rather than merged: the summary's excerpt would be a second,
    // shorter copy of `comments[0]` sitting beside the real thing.
    firstComment: undefined,
    comments,
    ...(t.comments && t.comments.length > MAX_COMMENTS
      ? {
          // Said out loud. The own rule about silent caps: an agent that reads
          // 50 of 200 comments and is not told will answer as if it read them
          // all.
          commentsTruncated: `showing the oldest ${MAX_COMMENTS} of ${t.comments.length} comments`,
        }
      : {}),
    ...(t.attachments?.length
      ? {
          attachments: t.attachments.map((a) => ({
            id: a.id,
            kind: a.kind,
            // A path on the instance, never a bucket URL. There is no tool that
            // fetches it: — no arbitrary-fetch tool.
            url: a.url,
            ...(a.width ? { width: a.width, height: a.height } : {}),
          })),
        }
      : {}),
  };
}

/**
 * `get_thread_context` — `context:read`, the personal-data-bearing half.
 *
 * `CaptureContext` minus `sourceRef`, plus breadcrumbs and
 * `capture.reasons[]` / `capture.blindSpots[]`. Breadcrumb messages are Class R
 * — a console log on somebody else's site is text an attacker can write — so
 * every one is fenced.
 */
export function context(t: WireThread): Record<string, unknown> {
  const ctx = (t.context ?? {}) as Record<string, unknown>;
  const crumbs = Array.isArray(ctx["breadcrumbs"]) ? (ctx["breadcrumbs"] as Record<string, unknown>[]) : [];
  const { sourceRef: _dropped, ...rest } = ctx as { sourceRef?: unknown };
  return {
    // Everything except the breadcrumbs, which are re-emitted fenced below.
    ...Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "breadcrumbs")),
    breadcrumbs: crumbs.slice(-50).map((b) => ({
      t: b["t"],
      type: b["type"],
      ...(b["level"] ? { level: b["level"] } : {}),
      message: fenced("breadcrumb", String(b["message"] ?? ""), CLAMP.body),
    })),
  };
}

/**
 * Wrap a result for the model — mitigation 1's preamble, then the data.
 *
 * Text and not a JSON content block, deliberately: the preamble has to be the
 * FIRST thing read, and a structured result puts the boundary statement
 * somewhere inside an object where it reads as one more field.
 */
export function envelope(payload: unknown): string {
  return `${DATA_BOUNDARY}\n\n${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...(payload as object) }, null, 2)}`;
}

/**
 * A tool's failure, in words an agent can relay.
 *
 * Sanitised, because the string may carry a server message that quoted the
 * caller's own input back — an error path is exactly where an unfenced string
 * gets emitted by accident.
 */
export function failure(message: string): string {
  return `${DATA_BOUNDARY}\n\n${sanitise(message, "plain", { max: 1_000 })}`;
}

/**
 * `get_thread`'s default answer — the BRIEF, as markdown: where
 * to look, what's wrong, the screenshot. The same formatter the dashboard's
 * Copy button and the server's `…/threads/:id.md` use, with two differences
 * that belong to this package:
 *
 *   · every string a reviewer could have typed is FENCED,
 *     through the same clamps the JSON view applies;
 *   · the capture CONTEXT is left out. It is the personal-data-bearing half
 *     (`context:read`, `get_thread_context`), and a token is not given that
 *     scope by default — so the brief says where it is rather than printing it.
 */
export function brief(t: WireThread, site: { name: string; dashboardOrigin?: string }): string {
  const clamp: Record<BriefFenceKind, number> = {
    body: CLAMP.body,
    name: CLAMP.name,
    label: CLAMP.label,
    selector: CLAMP.selector,
    breadcrumb: CLAMP.body,
  };
  const md = briefMarkdown({ ...t, context: null } as BriefThread, site, {
    fence: (kind, value) => fenced(kind, value, clamp[kind]),
  });
  return `${DATA_BOUNDARY}\n\n${md}\n_Environment, breadcrumbs and capture reasons: get_thread_context (needs context:read)._\n`;
}
