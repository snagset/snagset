import { NPM_PACKAGE, SCHEMA_VERSION } from "@snagset/types/names";
import { count, format, when } from "../strings/capture.ts";
import { statusLabel, type Snag } from "../storage/types.ts";

/**
 * Export (the v0 row): Markdown to paste into a ticket, JSON to keep.
 *
 * v0 has no backend, so export is the ONLY way a round of comments leaves the
 * browser it was made in. That makes it load-bearing rather than a nicety: it
 * is the honest answer to "what happens to my work if I clear this site's
 * data", and it is how a snag reaches a developer who is not doing the review.
 *
 * Both carry the anchor's own words. On a bucket-less install there is no
 * screenshot to fall back on, so `anchor.label` is the whole record of what was
 * pointed at, and an export that dropped it would be unreadable a week later.
 */

export interface ExportMeta {
  /** Where the round was made — origin, not full URL. */
  origin: string;
  /** ISO 8601. Passed in rather than read here, so the output is testable. */
  exportedAt: string;
}

/**
 * Attachment id → data: URI, resolved from the blob store BEFORE these
 * functions run (attachments.ts) — blob reads are async and both serialisers
 * stay synchronous and pure on purpose (testability is the whole point of
 * ExportMeta's shape, and it holds here too).
 */
export type AttachmentUris = ReadonlyMap<string, string>;

/**
 * A snag as the FILE should carry it: runtime-only fields dropped (a Blob
 * JSONifies to `{}`; `anchorPending`/`anchorReasons` are per-pass judgements
 * the type marks "never persisted"), and attachment urls swapped for their
 * export-time data: URIs (stored as Blobs, inlined ONLY here).
 */
function exportable(s: Snag, uris?: AttachmentUris): Snag {
  const { anchorPending: _p, anchorReasons: _r, screenshotBlob: _b, ...clean } = s;
  void _p; void _r; void _b;
  if (clean.attachments?.length && uris?.size) {
    clean.attachments = clean.attachments.map((a) => {
      const uri = uris.get(a.id);
      return uri ? { ...a, url: uri } : a;
    });
  }
  return clean;
}

/**
 * The device/viewport line.
 *
 * NO SPEC GIVES THIS A TEMPLATE. The design names it in three words and the design says
 * only "all of the above". The one normative rendering in the spec set is the
 * detail's capture block, lines 3 and 4 — so those exact two keys are reused
 * rather than a richer format being invented here. Same rules apply: an empty
 * `os` drops its separator, and @1x is suppressed.
 *
 * Empty for a record written before capture existed, and the caller drops the
 * line entirely rather than printing an empty field.
 */
function device(s: Snag): string {
  const c = s.context;
  const d = c?.derived;
  // The VIEWPORT is checked too, not only the context and the derived block.
  // Its absence threw `Cannot read properties of undefined (reading 'dpr')`
  // one line down — and this function is reached from the dock, so a single
  // thread with a partial context took the whole detail panel with it.
  //
  // `POST /threads` accepts `context: { url }`, so any API caller can create
  // one. The widget always sends a full CaptureContext, which is why nothing
  // caught it; found by creating a thread with curl to test a permalink.
  //
  // Empty string, which the caller already drops as a line — the honest
  // rendering of "we do not know what device this was".
  const v = c?.viewport;
  if (!c || !d || !v) return "";
  const dpr = Math.round(v.dpr * 100) / 100;
  const agent = d.os
    ? format("capture.agent", { browser: d.browser, os: d.os })
    : format("capture.agent.noos", { browser: d.browser });
  const box =
    dpr === 1
      ? format("capture.device.at1x", { device: d.device, w: v.w, h: v.h })
      : format("capture.device", { device: d.device, w: v.w, h: v.h, dpr });
  return `${agent} · ${box}`;
}

export function toMarkdown(rawSnags: Snag[], meta: ExportMeta, uris?: AttachmentUris): string {
  const snags = rawSnags.map((s) => exportable(s, uris));
  const openCount = snags.filter((s) => s.status !== "resolved").length;
  /** Reference-style definitions, collected per thread and emitted at the
   *  FOOT (the "references them"). An inline `![…](data:…)` would put
   *  ~350 KB of base64 mid-sentence; the reference form keeps the body
   *  readable in exactly the paste-into-a-ticket case the export exists for. */
  const refs: string[] = [];
  const out: string[] = [
    `# ${format("export.title", { origin: meta.origin })}`,
    "",
    // Two keys selected by an `if`, not `comment${n === 1 ? "" : "s"}`. The
    // hand-rolled English plural cannot be translated at all, and this is the
    // exact shape `Intl.PluralRules` slots into at v1.
    format(snags.length === 1 ? "export.summary.one" : "export.summary.many", {
      total: count(snags.length),
      unresolved: count(openCount),
      date: when(meta.exportedAt),
    }),
  ];

  // GROUPED BY PAGE, and exporting every page rather than the one on screen.
  // Exporting only the current route seemed right — you get what you are
  // looking at — until a week of real review work spread twenty comments over
  // three routes and the only way to get them out was to visit each one and
  // export separately. A review round is the unit people think in, and it does
  // not stop at a page boundary.
  const byRoute = new Map<string, Snag[]>();
  for (const s of snags) byRoute.set(s.route, [...(byRoute.get(s.route) ?? []), s]);

  for (const [route, group] of byRoute) {
    out.push("", "---", "", `## ${route}`);
    group.forEach((s, i) => {
      const first = s.comments[0];
      out.push(
        "",
        // Numbered WITHIN its page, because that is the number on the pin: the
        // count restarts per route on screen, and an export that renumbered
        // across pages would stop matching what anyone is looking at.
        `### ${format("export.heading", { n: i + 1, key: s.key, status: statusLabel(s.status) })}`,
        "",
        // The field list has no separate "Where" — `On “<label>”` IS the
        // where, and rendering both put the same label on two adjacent lines.
        // The label goes through byte-for-byte as stored (AC G3); it carries its
        // own typographic quotes, so the key adds none.
        `**${format("export.on", { label: s.anchor.label })}**`,
        // …and when the anchor did not settle, the export says so in the same
        // sentence the detail view uses. A developer reading this needs to know
        // the pin is a best guess before they go looking for the element.
        ...(s.anchorState === "anchored"
          ? []
          : [format(`detail.${s.anchorState}`, { label: s.anchor.label })]),
        // And both list the selector, and it is the field the
        // export exists FOR: the case the design describes is a developer reading
        // a `.md` for a page they cannot open — a staging site behind a login,
        // or one already torn down. "On “Continue”" locates nothing in a
        // codebase; `button.checkout-cta` locates it in one grep.
        //
        // Fenced as inline code so a selector containing `_`, `*` or `[` is not
        // eaten by Markdown emphasis on the way to a developer's eyes.
        ...(s.anchor.css ? [`**${format("export.selector")}** \`${s.anchor.css}\``] : []),
        ...(device(s) ? [`**${format("export.device")}** ${device(s)}`] : []),
        `**${format("export.by")}** ${first?.author.name ?? s.createdBy.name} · ${when(s.createdAt)}`,
        "",
        first?.body ?? format("export.nobody"),
      );
      for (const a of s.attachments ?? []) {
        if (!a.url.startsWith("data:")) continue; // unresolved — nothing to reference
        out.push("", `![${format("export.screenshot", { key: s.key })}][${a.id}]`);
        refs.push(`[${a.id}]: ${a.url}`);
      }
      for (const c of s.comments.slice(1)) {
        out.push("", `- **${c.author.name}** — ${c.body ?? ""}`);
      }
    });
  }

  if (refs.length) out.push("", "---", "", ...refs);
  return out.join("\n") + "\n";
}

/**
 * `{ schemaVersion, …, threads }` — the shape three specs print identically.
 *
 * (`{ schemaVersion: 'snagset.v1', threads: Thread[] }`, tagged
 * v0-widget), and plan task 39 all say the same two key names. This
 * emitted `{ schema, …, snags }`, which is the vocabulary the CODE uses
 * internally — `Snag` is the runtime type — leaking into the file format.
 *
 * That distinction is the whole point of a schema version. The stated
 * evidence is *"schema validation in CI"*, and the first external consumers are
 * the `snagset export` CLI and the M2 importer; every one of them reads
 * `schemaVersion` and `threads`, so what we wrote validated against nothing.
 *
 * Changed rather than aliased, because the design is explicit that v0 persists
 * nothing outside one browser's localStorage — so a rename now costs a
 * find-and-replace, and after v1 ships real data it costs a migration.
 */
export function toJSON(snags: Snag[], meta: ExportMeta, uris?: AttachmentUris): string {
  // SCHEMA_VERSION is the one token deliberately frozen against a rename: a
  // file exported today must still be readable by a build that renamed itself.
  return JSON.stringify(
    { schemaVersion: SCHEMA_VERSION, ...meta, threads: snags.map((s) => exportable(s, uris)) },
    null,
    2,
  );
}

export interface ExportFile {
  name: string;
  mime: string;
  text: string;
}

export function buildExport(kind: "md" | "json", snags: Snag[], meta: ExportMeta, uris?: AttachmentUris): ExportFile {
  const day = meta.exportedAt.slice(0, 10);
  return kind === "md"
    ? { name: `${NPM_PACKAGE}-${day}.md`, mime: "text/markdown", text: toMarkdown(snags, meta, uris) }
    : {
        name: `${NPM_PACKAGE}-${day}.json`,
        mime: "application/json",
        text: toJSON(snags, meta, uris),
      };
}

/**
 * Hand a file to the browser. The anchor is created, clicked and removed inside
 * one task, and the object URL is revoked after — a download must not leave a
 * node or a blob behind on a page we are a guest on.
 */
export function download(into: ParentNode, file: ExportFile, win: Window): void {
  const doc = (into as Node).ownerDocument ?? (into as Document);
  const url = URL.createObjectURL(new Blob([file.text], { type: `${file.mime};charset=utf-8` }));
  const a = doc.createElement("a");
  a.href = url;
  a.download = file.name;
  a.style.display = "none";

  // Appended into OUR shadow root, never `document.body`. The old version put a
  // node in the host's DOM for a moment — transient, invisible to a snapshot
  // diff, and still a plain A3 violation that a MutationObserver sees.
  into.appendChild(a);

  // NOT `a.click()`. That dispatches a composed, bubbling event, so a host
  // page's own delegated click handler sees it — and an SPA router that calls
  // preventDefault() on link clicks silently cancels the download. The demo
  // page does exactly that, which is how this was found, and it is realistic:
  // intercepting link clicks IS what a client-side router does. A non-composed,
  // non-bubbling event never leaves the shadow root, and an anchor's activation
  // behaviour fires regardless of whether the event bubbles.
  a.dispatchEvent(new MouseEvent("click", { bubbles: false, cancelable: true, composed: false }));
  a.remove();

  // Revoking synchronously cancels the download in Safari; a task is enough.
  win.setTimeout(() => URL.revokeObjectURL(url), 0);
}
