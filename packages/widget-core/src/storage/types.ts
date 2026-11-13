import { format } from "../strings/en.ts";
import type { AnchorRecord, AnchorState } from "../anchor/types.ts";
import type { CaptureContext } from "../capture/types.ts";

/**
 * Domain types at v0 (narrowed to what a backend-less release
 * actually persists). Server-only fields — projectId, externalRefs — arrive
 * with v1 and are deliberately absent rather than stubbed, so nothing reads a
 * field that has never been populated.
 *
 * CORRECTION: this comment used to list `CaptureContext` alongside them as v1.
 * It is not — and both tag the metadata object v0, and three v0
 * surfaces render it: the detail's capture block, the list row's device glyph
 * and the Markdown export's device/viewport line. It read as a deliberate
 * scoping statement rather than a mistake, which is why it survived this long.
 */

/**
 * The four statuses. Colour is normative and shared by EVERY surface — the pin,
 * the list row, the detail's field and the round trip through the dashboard all
 * read this one table. Never a per-surface palette.
 *
 * The LABELS are deliberately absent: they live in the strings module, because
 * the v0 row requires that translating *In progress* never means touching
 * a colour. One table for the thing that is normative, one for the thing that
 * is language.
 */
export const STATUS = {
  // Pastel's four — the normative values, back in the code. The decision
  // had moved them for colour-blind separation; the maintainer: "the current ones
  // don't make sense — borrow the same colours as Pastel". The mapping a
  // reviewer recognises is the whole value of a status palette.
  open: { colour: "#4f6ef7" },
  progress: { colour: "#f59e0b" },
  review: { colour: "#8b5cf6" },
  resolved: { colour: "#10b981" },
} as const;

export type Status = keyof typeof STATUS;

/**
 * F-07b: a status this build does not know — written by a newer
 * build, or a future server — renders NEUTRAL GREY and its raw value, and
 * must never crash a surface. Every colour lookup goes through here, because
 * `STATUS[s].colour` on a stray value is a TypeError that takes the whole
 * dock down with it (found by the filter suite's seeded `wontfix`).
 */
export const statusColour = (s: string): string =>
  (STATUS as Record<string, { colour: string }>)[s]?.colour ?? "#8a8f98";

/**
 * The INK on a status fill, which names this exact
 * trap: "the status-tinted fills are the exact place this rule gets broken".
 *
 * The one-source rule locks the four FILLS and this does not touch them
 * the ink on a fill is not part of that table. On Pastel's values the
 * dark fills take white and the light fills take dark ink, measured: white on
 * `open` 4.28 and on `review` 4.23 — a hair under item 7's 4.5, the one
 * exception records, and what Pastel itself ships; dark on `progress`
 * 8.40 and on `resolved` 7.11. The stray-status grey takes dark ink at 5.51.
 *
 * It is also the RING, not just the numeral. The ring used to be
 * `--snag-onAccent` — white in the light theme — which was safe only while
 * every fill was dark. `resolved` is a pale grey, and a pale fill inside a
 * white ring on a white page is an invisible pin. Deriving both from here
 * means fill and ring always out-contrast each other by at least 5.5:1, so
 * the pin is findable on any ground a customer's page hands it.
 */
export const statusInk = (s: string): string =>
  s === "open" || s === "review" ? "#fff" : "#16161a";

/** *Active*, *In progress*, … — the label half of the pair above. F-07b:
 *  a stray status shows its raw value, not a formatted sentence. */
export const statusLabel = (s: Status): string =>
  s in STATUS ? format(`status.${s}`) : (s as string);

/**
 * What a pin points at, and how honest the answer is — the ONE place this is
 * phrased. It used to be written three times, in pins.ts, dock.tsx and
 * serialize.ts, in three different wordings, which is what happens when a
 * sentence is assembled at the call site rather than looked up.
 *
 * It lives HERE, beside `statusLabel`, and not in the pin layer that first
 * needed it. Three chunks render it, and reaching it where it was meant
 * `panels/dock.tsx` importing `runtime/pins.ts` — pulling the whole pin layer
 * into the panels module graph for one four-line formatter, and making it
 * impossible to tell by inspection which catalogue the pin strings belong in.
 */
export const whereText = (s: Snag): string =>
  format(`where.${s.anchorState}`, { label: s.anchor.label });

export interface Reviewer {
  id: string;
  name: string;
  /** Self-declared, unverified, optional. A display courtesy and a
   *  notification address — never proof of identity, and it never moves `kind`. */
  email?: string;
  kind: "guest" | "link" | "verified";
}

export interface Comment {
  id: string;
  snagId: string;
  body: string | null;
  author: Reviewer;
  createdAt: string;
  /** Team-only: present, and `true`, only in a list read by
   *  someone who may see it — a studio member's or a team link's session.
   *  A client's list never holds the reply at all, so never the field. */
  private?: true;
}

/**
 * A **Snag** — one issue: a pin, its anchor, and its thread of comments.
 * `key` is the permanent human-facing id (SN-14) used in permalinks and exports.
 */
/**
 * The `scope`, with `round` present in the TYPE and never set at v0.
 *
 * `round?: string` rather than `round?: never`: `never` would make the field
 * unassignable, so M2 could not fill it without changing the type — which is
 * exactly the migration this exists to avoid. The v0 guarantee is that nothing
 * WRITES it, and `local.test.ts` asserts that rather than the type doing it.
 */
export interface ThreadScope {
  environment: string;
  branch?: string;
  /** []'s rounds, at M2. Declared now so the key layout never changes. */
  round?: string;
}

export interface Snag {
  id: string;
  key: string;
  route: string;
  anchor: AnchorRecord;
  /** Last settled resolution. Recomputed on every load; persisted for the list. */
  anchorState: AnchorState;
  /** RUNTIME-ONLY: true while the pin holds in the retry window.
   *  Never persisted, never reported — recomputed by every pass. */
  anchorPending?: boolean;
  /** RUNTIME-ONLY: the last resolution's reasons, for the detail view's
   *  honesty notes (F-04b). Recomputed per pass; never persisted. */
  anchorReasons?: string[];
  /** RUNTIME-ONLY: the captured screenshot, held in memory until
   *  the blob store persists it. Never serialised — a Blob JSONifies to
   *  an empty object, so it must never reach a storage request. */
  screenshotBlob?: Blob;
  /** Blob-store refs. Additive-optional — the local record shape is
   *  ours to extend, and exported JSON stays `Thread[]`-valid (the design makes
   *  additive-optional free). */
  attachments?: Attachment[];
  status: Status;
  /**
   * Who this snag is with. Null or absent: nobody. Only an
   * instance assigns (`capabilities.assignees`); a local record never carries
   * it, and the dock shows the field only when one does.
   */
  assignee?: Reviewer | null;
  /** The whole thread is team-only — the same rule as
   *  `Comment.private`: only ever `true`, only for a reader who sees it. */
  private?: true;
  comments: Comment[];
  createdBy: Reviewer;
  createdAt: string;
  updatedAt: string;
  /**
   * WHERE this thread was reviewed — the `Thread.scope`, and plan task 37's
   * single forward-compat assertion: *"`Thread.scope` is `{environment,
   * branch?, round?}` with `round` undefined, so []'s rounds do not change
   * the key layout."*
   *
   * The whole point is the SHAPE, not today's values. The decision makes rounds a real
   * feature at M2, and a round is a property of where-and-when a comment was
   * made. If `scope` arrives then, every record written before it has to be
   * migrated and every reader needs two code paths. If it is here now with
   * `round` simply absent, M2 sets a field.
   *
   * `environment` and `branch` are not decoration either. A studio reviews the
   * same site on staging, on a branch preview and in production, and today the
   * only trace of which one a comment came from is the `env` segment buried in
   * a storage key — invisible to an export, and gone the moment two
   * environments are read together. `branch` is what makes two preview deploys
   * of one PR distinguishable.
   *
   * Optional on the stored record for the same reason `context` is: records
   * written before this existed are read back by this build, and dropping them
   * to satisfy a type would lose a reviewer's words to a refactor.
   */
  scope?: ThreadScope;
  /**
   * What the page was when this was pinned.
   *
   * OPTIONAL ON THE STORED RECORD, required on the request. Every snag created
   * from now on carries one; records written before capture existed do not, and
   * dropping them on load to satisfy a type would be worse than rendering a
   * capture block with fewer lines. The design makes it required on the WIRE shape,
   * which is v1's concern — the v0 local record's shape is not stated by any
   * spec (the design lists keys, not shapes).
   */
  context?: CaptureContext;
}

/**
 * The wire vocabulary is THREAD; the product vocabulary is SNAG. The Name
 * Registry deliberately does not rename schema identifiers, so the adapter
 * boundary — the thing v1 replaces with an HTTP call — speaks `Thread`, while
 * every user-facing surface says *snag*. They are the same object.
 */
export type Thread = Snag;

/**
 * The `Attachment`, the local subset. Attachments hang off a
 * thread; they are NOT collected at pin time — except the automatic
 * screenshot, which the capture flow attaches at creation. Locally `url` is
 * `""`: the id is the resolution handle into the blob store, and the field
 * becomes a `data:` URI only in the export. Max 3 per item.
 */
export interface Attachment {
  id: string;
  kind: "screenshot" | "image";
  /** "" in stored records; a data: URI in exported JSON only. */
  url: string;
  width?: number;
  height?: number;
  bytes?: number;
  contentType?: string;
}

/** What `uploadAttachment` needs beyond the bytes — the design names the type;
 *  the fields mirror endpoint 14's upload headers (kind, width, height). */
export interface AttachmentMeta {
  kind: "screenshot" | "image";
  width?: number;
  height?: number;
}

/** Client-only codes that NEVER cross the wire. */
export type AdapterErrorCode = "local_quota_exceeded" | "attachments_unsupported";

export class AdapterError extends Error {
  // Declared and assigned explicitly, NOT as a constructor parameter property:
  // parameter properties emit runtime code, so they are not erasable syntax and
  // `node --experimental-strip-types` refuses the whole module — which took
  // every test that transitively imports this file down with it.
  readonly code: AdapterErrorCode;
  constructor(code: AdapterErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AdapterError";
    this.code = code;
  }
}

/**
 * What a deployment can actually do. **Advertised, never assumed**
 * the UI renders from this, so an adapter without attachments hides the button
 * rather than failing a call. That is what makes the GitHub adapter shippable.
 */
/** The wire shape. `state` is settled only — 'pending' is not an outcome. */
export interface AnchorReport {
  threadId: string;
  state: import("../anchor/types.ts").AnchorState;
  confidence: number;
  strategy: string;
  build?: string;
  ms?: number;
}

export interface AdapterCapabilities {
  attachments: "direct" | "none";
  realtime: "none" | "poll" | "sse";
  anchorReports: boolean;
  identity: ("guest" | "link" | "verified")[];
  export: ("json" | "md" | "csv" | "zip")[];
  serverSideSearch: boolean;
  /** Can this deployment express team-only threads? False ⇒ the UI drops the
   *  toggle rather than rendering one that does nothing. */
  privateThreads: boolean;
  assignees: boolean;
}

export interface AdapterContext {
  /** Project uid, or the literal `local` when `data-snag-site` is absent. */
  uid: string;
  env: string;
}

/** One row of the project's round history — enough for a
 *  selector: which, called what, and whether it still takes new threads. */
export interface RoundInfo {
  number: number;
  name: string;
  closed: boolean;
}

export interface ProjectConfig {
  uid: string;
  env: string;
  /** Derived from bucket presence server-side (A9b). Both false in annotation mode. */
  features: { screenshots: boolean; uploads: boolean };
  /** Absent on adapters with no round concept (local). One entry per round,
   *  newest first — the dock's selector renders from this and ONLY when there
   *  is more than one, because a dropdown over one option is furniture. */
  rounds?: RoundInfo[];
  /**
   * FALSE when this page's origin is not on the site's allow-list
   * layer 3. The server answers a stranger with the public subset and
   * `reason: "origin_not_allowed"` rather than a 403, precisely so the widget
   * can say something true instead of failing silently.
   *
   * Optional, because a server from before sends neither field and must
   * keep working: absent means "no opinion", which is read as writable.
   */
  writable?: boolean;
  reason?: string;
}

export interface ThreadQuery {
  route?: string;
  status?: Status[];
  cursor?: string;
}

export interface ThreadList {
  data: Thread[];
  nextCursor?: string;
  /** Tombstones since the last poll. Always empty locally — nothing else writes. */
  deleted?: string[];
  serverTime: string;
}

export interface CreateThreadRequest {
  id: string;
  key: string;
  route: string;
  anchor: Snag["anchor"];
  anchorState: Snag["anchorState"];
  createdBy: Reviewer;
  /** Client-minted alongside the id, so the optimistic copy and the stored one
   *  are the same object rather than two objects a millisecond apart. */
  createdAt: string;
  /** The first comment, created in the same transaction as the thread. */
  comment?: { id: string; body: string; author: Reviewer };
  /** Snapshotted at T0 — the click, not the send. Never optional
   *  here: a snag created without one could never grow the field later,
   *  because the page it describes is gone by then. */
  context: CaptureContext;
  /** Where this was reviewed. Absent only when the caller is a host
   *  driving `add()` directly and has no environment to name. */
  scope?: ThreadScope;
  /** The automatic screenshot's blob-store ref, already written by
   *  `uploadAttachment` when this request is built. Local-only — v1's wire
   *  binds attachments relationally after the fact and ignores it. */
  attachments?: Attachment[];
}

/**
 * Build the thread a request describes. **Pure**, and shared by the adapter and
 * by the runtime's optimistic copy — if each built its own, the object on
 * screen and the object in storage could differ, and the difference would only
 * show up after a reload.
 */
export function threadFromRequest(input: CreateThreadRequest): Thread {
  return {
    id: input.id,
    key: input.key,
    route: input.route,
    // This task forward-compat field. `round` is deliberately absent, not
    // undefined-valued: `exactOptionalPropertyTypes` treats those as different
    // things, and an absent key is what a v0 record is supposed to look like.
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    anchor: input.anchor,
    anchorState: input.anchorState,
    context: input.context,
    status: "open",
    comments: input.comment
      ? [
          {
            id: input.comment.id,
            snagId: input.id,
            body: input.comment.body,
            author: input.comment.author,
            createdAt: input.createdAt,
          },
        ]
      : [],
    createdBy: input.createdBy,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export interface ThreadPatch {
  status?: Status;
  /** A reviewer id from `listAssignees`, or null to un-assign. */
  assignee?: string | null;
  anchor?: Snag["anchor"];
  anchorState?: Snag["anchorState"];
}

export interface CreateCommentRequest {
  id: string;
  body: string;
  author: Reviewer;
}

/**
 * A8 — adapter-based storage from day one, so v1's HTTP adapter is a swap and
 * not a rewrite. This is the interface,
 * not a paraphrase of it: an earlier version shipped a two-method
 * `load()`/`save()` pair invented in code, which is exactly what the
 * blocker existed to prevent — the spec had been written and nobody re-read it.
 *
 * Deliberately async even for `localStorage`, because the synchronous version
 * is the one that cannot be replaced later. Optional methods are genuinely
 * optional; a missing `uploadAttachment` and `attachments: 'none'` must agree,
 * and local.test.ts asserts they do.
 */
/** What the dashboard posts back — `POST …/sessions/member`'s body. */
export interface MemberSession {
  sessionToken: string;
  expiresAt: string;
  refreshableUntil: string;
  reviewer: { id: string; name: string };
  permissions: string[];
  /** A studio owner or admin: may delete anyone's comment from the widget. */
  moderator?: boolean;
}

export interface StorageAdapter {
  readonly kind: "local" | "http" | "github" | "custom";
  readonly capabilities: AdapterCapabilities;
  init(ctx: AdapterContext): Promise<ProjectConfig>;
  listThreads(q?: ThreadQuery): Promise<ThreadList>;
  getThread(id: string): Promise<Thread | null>;
  /**
   * Resolve a permalink — `SN-14` — asking the SERVER rather than the list.
   *
   * The list is round-scoped: a non-owner reader defaults to the latest open
   * round. So a permalink to a thread from a closed round (which is most of
   * the ones anyone bothers to share) found nothing locally and showed F-the
   * "we could not find that comment", while the thread sat one round back.
   *
   * Optional: the local adapter has one store and no rounds to be wrong about,
   * so it resolves from what it holds and this is `undefined` there.
   */
  getThreadByKey?(key: string): Promise<Thread | null>;
  createThread(input: CreateThreadRequest): Promise<Thread>;
  patchThread(id: string, patch: ThreadPatch): Promise<Thread | null>;
  deleteThread(id: string): Promise<void>;
  createComment(threadId: string, input: CreateCommentRequest): Promise<Comment | null>;
  patchComment(id: string, body: string): Promise<Comment | null>;
  deleteComment(id: string): Promise<void>;
  /**
   * Whether `author` is whoever this adapter is acting as — what decides
   * which comments the dock offers to edit or delete. Absent on adapters
   * with one person behind every comment (local).
   */
  isMine?(author: Reviewer): boolean;
  /** Whether this session holds a permission. Absent: everything. */
  can?(permission: string): boolean;
  /** A signed-in studio owner or admin: Delete on every comment. */
  canModerate?(): boolean;
  export?(format: "json" | "md" | "csv" | "zip"): Promise<Blob | string>;
  uploadAttachment?(blob: Blob, meta: AttachmentMeta): Promise<Attachment>;
  /**
   * The screenshot's way round CORS: fetch one cross-origin image through the
   * server, which is not bound by the browser's rule (the image proxy, found
   * reviewing Acme). Null on any refusal — the caller keeps its placeholder.
   * Absent on adapters with no server (local), so the redraw simply has no
   * second route.
   */
  fetchForeignImage?(url: string): Promise<Blob | null>;
  /** T10/: which round the reviewer is LOOKING AT, and the switch. Both
   *  optional together — an adapter with no round concept (local) has neither
   *  and the dock renders no selector. `getRound() === null` means "no explicit
   *  choice": the server then serves the latest open round (T8's default), and
   *  a link-pinned session's choice was seeded into the store at exchange. */
  /** L1.1b: force a session re-check. Absent on adapters with no session
   *  (local), so the runtime tests for it before calling. */
  revalidate?(): Promise<void>;
  /**
   * A studio member signed in from the widget. Absent on adapters
   * with no server (local), so the composer offers no sign-in there.
   *
   * `member()` is the signed-in account's name, or null for a guest or a
   * link holder. `adoptSession()` stores a session the dashboard minted
   * (`POST …/sessions/member`, posted back by the popup) exactly as an
   * exchange's would be stored; `signOut()` drops it, and the next request
   * exchanges as the guest this browser was before.
   */
  member?(): string | null;
  adoptSession?(b: MemberSession): void;
  signOut?(): void;
  getRound?(): number | null;
  setRound?(round: number): void;
  /**
   * The last list this browser was shown for the round in view, or null —
   * painted while `listThreads` revalidates (storage/listcache.ts). Absent
   * on the local adapter, whose list is already in this browser.
   */
  cached?(): Snag[] | null;
  /**
   * The runtime's list after a write the server accepted (or a rollback of
   * one it refused), so what `cached` paints next follows local changes.
   * The adapter decides whether it may be stored at all; absent where
   * `cached` is.
   */
  remember?(list: Snag[]): void;
  listAssignees?(q?: string): Promise<Reviewer[]>;
  /**
   * Anchor outcome reporting. Present only where `capabilities
   * .anchorReports` is true; the runtime tests for it before calling.
   *
   * It NEVER rejects. A report is telemetry plus a state hint, and the one
   * thing worse than losing a metric is a reviewer seeing an error because
   * their browser re-measured a pin. The server agrees from its side — that
   * route answers 204 to everything it does not consider malformed.
   */
  reportAnchors?(batch: AnchorReport[]): Promise<void>;
}
