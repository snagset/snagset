import { HTTP_HEADER, NPM_PACKAGE, SCHEMA_VERSION, storageKey } from "@snagset/types/names";
import { holderId, holderSecretOrUndefined, readIdentity, rememberHolder, rememberHolderId } from "./identity.ts";
import { dropList, readList, writeList, type ListClass } from "./listcache.ts";
import { clearSession, isFinished, needsRefresh, readSession, writeSession, type StoredSession } from "./session.ts";
import type {
  AnchorReport,
  Attachment,
  AttachmentMeta,
  AdapterContext,
  Comment,
  CreateCommentRequest,
  CreateThreadRequest,
  MemberSession,
  ProjectConfig,
  Reviewer,
  Snag,
  StorageAdapter,
  Thread,
  ThreadList,
  ThreadPatch,
  ThreadQuery,
} from "./types.ts";

/**
 * The HTTP adapter, the other half of the seam `createLocalAdapter`
 * has occupied alone since M1.
 *
 * Everything above this file already talks to `StorageAdapter` and nothing
 * else, which is what makes the walking skeleton a matter of choosing an
 * adapter rather than of teaching the UI about a server. The local adapter is
 * still the default and still the fallback; this one is selected by
 * `data-snag-host`.
 *
 * WHAT IS DELIBERATELY ABSENT AT, so the shape does not lie about it:
 *
 *  · No outbox. A failed write throws and the composer reports it. The
 *    queue-and-retry is v1, and a half-built one that silently drops a comment
 *    is worse than a failure a reviewer can see and retry themselves.
 *  · Attachments arrive with a bucket. `capabilities.attachments` starts
 *    `"none"` and `init()` sets it from the server's `features.screenshots`,
 *    which is derived from bucket presence (A9b). No bucket, no control —
 *    annotation mode is a complete product, not a degraded one.
 *  · No polling. `realtime: "none"` — a reload is the refresh, which is
 *    exactly what the skeleton is defined to prove.
 */

export class HttpAdapterError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpAdapterError";
    this.status = status;
    this.code = code;
  }
}

interface Wire {
  id: string;
  key: string;
  status: Snag["status"];
  anchor: Snag["anchor"];
  anchorState: Snag["anchorState"];
  context: Snag["context"];
  comments: { id: string; body: string; createdAt: string; author: Reviewer }[];
  createdBy: Reviewer;
  /** Always present on an instance from on, null for nobody. */
  assignee?: Reviewer | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  /** The list carries these too (threads.ts) — `url` is the server's
   *  ROOT-RELATIVE proxy route, never a bucket URL. */
  attachments?: (Omit<Attachment, "url"> & { url?: string })[];
}

/** Wire → `Snag`. One place, so a field the server renames breaks here and
 *  not in five components. */
/** The reverse of `toWireAnchor` — the engine below expects its own shape, and
 *  a record read back has to re-anchor exactly as one just created does. */
function fromWireAnchor(a: Record<string, any>): Snag["anchor"] {
  const { offset, testId, domId, page, schemaVersion, ...rest } = a;
  return {
    ...rest,
    ...(testId ? { testid: testId } : {}),
    ...(domId ? { domid: domId } : {}),
    ...(offset ? { offset: { fx: offset.x, fy: offset.y } } : {}),
  } as Snag["anchor"];
}

/**
 * A wire attachment → one the widget can FETCH from the host page.
 *
 * The server hands out `/api/v1/attachments/<id>/blob` — root-relative, which
 * is right for the dashboard (same origin as the API) and wrong for the
 * widget, whose relative URLs resolve against the CLIENT'S site. Absolutised
 * against the API base here, at the boundary, and derived from the id when a
 * payload carries none: that route is the server's public contract, and
 * `uploadAttachment` below already builds the same string.
 */
function wireAttachment(a: NonNullable<Wire["attachments"]>[number], base: string): Attachment {
  const raw = a.url ?? "";
  const url = /^https?:/i.test(raw)
    ? raw
    : raw
      ? `${base}${raw.startsWith("/") ? "" : "/"}${raw}`
      : `${base}/api/v1/attachments/${encodeURIComponent(a.id)}/blob`;
  return { ...a, url } as Attachment;
}

function toSnag(w: Wire, env: string | undefined, base: string): Snag {
  return {
    id: w.id,
    /**
     * The ROUTE, recovered from the wire anchor's `page`.
     *
     * `Snag.route` is what the dock groups by — "on this page" versus
     * everywhere else — and it is NOT part of the widget's internal
     * `AnchorRecord`, so `fromWireAnchor` strips `page` and the route went
     * with it. Every thread read back from the server arrived with
     * `route: undefined` and was filed under "some other page".
     *
     * Invisible within one session, because a snag you just created is still
     * the in-memory object that has a route. It shows up on RELOAD, when
     * every snag comes from the server — which is exactly when a reviewer
     * expects to find their own comments where they left them.
     */
    route: (w.anchor as { page?: { route?: string } } | undefined)?.page?.route ?? "",
    key: w.key,
    status: w.status,
    anchor: fromWireAnchor(w.anchor as unknown as Record<string, any>),
    anchorState: w.anchorState,
    context: w.context,
    comments: w.comments ?? [],
    createdBy: w.createdBy,
    // Null kept as null: a PATCH response merged over a row must be able to
    // CLEAR the name, which an absent key cannot.
    assignee: w.assignee ?? null,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    ...(w.resolvedAt ? { resolvedAt: w.resolvedAt } : {}),
    /**
     * The screenshot ref, which this function used to DROP.
     *
     * The server has sent `attachments` on the list since the dock learned to
     * draw thumbnails, but nothing here copied them across, so every thread
     * read back from an instance arrived without one and the detail's `Shot`
     * had nothing to render — on every browser, including the one that took
     * the picture, from its first reload on. The dashboard showed the same
     * screenshot fine because it reads the server's shape directly. Found
     * self-hosting an instance and reviewing a client site with it.
     */
    ...(w.attachments?.length ? { attachments: w.attachments.map((a) => wireAttachment(a, base)) } : {}),
    ...(env ? { scope: { environment: env } } : {}),
  } as unknown as Snag;
}

/**
 * The widget's internal `AnchorRecord` → the.
 *
 * These are two different types wearing one name, and the walking skeleton is
 * what found it: the first real POST was refused by
 * `CHECK (anchor ? 'offset' AND anchor ? 'page')` — the guard on the
 * generated `route`/`pathname`/`origin` columns, which are projections off
 * those keys and would silently be NULL without them.
 *
 * Three divergences, all in `anchor/types.ts`:
 *
 *   `offset: {x, y}` REQUIRED   · widget `offset?: {fx, fy}`
 *   `page: PageRef` REQUIRED   · widget has no `page` at all
 *   `schemaVersion`             · widget omits it
 *
 * (and `testId`/`domId` against the widget's `testid`/`domid`.)
 *
 * The translation lives HERE, at the boundary, rather than by renaming fields
 * through the anchoring engine: The design defines the STORED and WIRE record
 * what an export, a webhook payload and the MCP contract all read — while
 * `anchor/types.ts` is the matching engine's working shape. A rename inside
 * the engine would touch every facet comparison in 03 for no gain in what any
 * consumer sees. What matters is that the two are reconciled in one visible
 * place instead of diverging silently, which is what they were doing.
 *
 * `offset` defaults to the centre rather than being omitted: a pin with no
 * offset is placed at the element's middle by the renderer anyway, so writing
 * that explicitly stores what will actually be drawn.
 */
function toWireAnchor(a: Record<string, any>, route: string): Record<string, unknown> {
  const { offset, testid, domid, ...rest } = a;
  return {
    ...rest,
    schemaVersion: SCHEMA_VERSION,
    ...(testid ? { testId: testid } : {}),
    ...(domid ? { domId: domid } : {}),
    offset: offset ? { x: offset.fx, y: offset.fy } : { x: 0.5, y: 0.5 },
    page: {
      route,
      pathname: location.pathname,
      origin: location.origin,
    },
  };
}

export interface HttpAdapterOptions {
  /**
   * The raw `#snag_k` token, IN MEMORY ONLY, from the loader.
   *
   * Present exactly once per page load and never persisted.
   * It is exchanged at `init()` and then forgotten; after the session's
   * absolute cap the reviewer re-opens their link, which is the trade the spec
   * takes deliberately over storing a long-lived bearer in web storage.
   */
  reviewToken?: string | undefined;
  /** Told when the session ends for good — F-18b at the cap, F-19 on revoke. */
  onSessionEnded?: (reason: "expired" | "revoked") => void;
  /**
   * A session was successfully established — the OTHER half of
   * `onSessionEnded`, and it exists because that callback had no retraction.
   *
   * The sequence that forced it: a reviewer whose session was revoked is sent
   * a fresh link. Opening it, the adapter first tries to refresh the dead
   * session (401 `session_revoked` -> F-19 raised), and only then exchanges
   * the new fragment token, which succeeds. Everything works — and the
   * reviewer is looking at "This review link was turned off" over a page full
   * of their own comments. The worst possible moment to say it, on the one
   * page that disproves it.
   */
  onSessionStarted?: () => void;
}

/**
 * The page and the API are the same SITE — naively: the last two
 * labels of their hostnames agree (an IP or IPv6 literal only with itself).
 * Only a hint for whether the silent member sign-in is worth one request:
 * the server makes the real, stricter decision (shared hosting and registry
 * suffixes, Fetch Metadata, the cookie), so a `true` here for two
 * `*.vercel.app` hosts costs one refused request, while a `false` means a
 * client's page on an unrelated domain never sends it at all.
 */
export function sameSiteHint(a: string, b: string): boolean {
  const site = (h: string): string => (/^[\d.]+$|:/.test(h) ? h : h.split(".").slice(-2).join("."));
  return site(a) === site(b);
}

/** How long a "no" from the silent sign-in is remembered by this tab. */
const SILENT_QUIET_MS = 10 * 60_000;

export function createHttpAdapter(
  host: string,
  uid: string,
  /** The host's `data-snag-env`, or undefined. NOT the local adapter's
   *  `"default"` placeholder: that is a storage-key component, and sending it
   *  as an environment name asks the server for one it has never heard of. */
  env: string | undefined,
  options: HttpAdapterOptions = {},
): StorageAdapter {
  const base = host.replace(/\/+$/, "");
  const root = `${base}/api/v1/projects/${encodeURIComponent(uid)}`;

  // The link token lives here and nowhere else. Cleared after its one use, so
  // a later refresh cannot accidentally re-present it.
  let linkToken = options.reviewToken;
  let session: StoredSession | null = readSession(uid);
  /**
   * The list cache's coordinates (listcache.ts). The CLASS is what a list is
   * read with — a member sees studio-private threads, so a member's copy
   * lives apart from a guest's — and the SLOT is the env and round it was
   * read for, `session.round` being the same field `listThreads` sends.
   */
  const cls = (): ListClass => (session?.member ? "member" : "guest");
  const slot = (): string => `${env ?? ""}:${session?.round ?? ""}`;
  /**
   * The class and slot of the last list this adapter read AND cached, or ""
   * — what `remember` checks the runtime's list against. The runtime's list
   * carries no note of the credential it was read with, so this is that
   * note. After a sign-out the runtime still holds the member's list until
   * the guest's arrives, and a write landing in that window must not file
   * the member's private threads under the guest's key: the class no longer
   * matches, and every session ending and refused list clears this anyway,
   * so nothing recreates a key that was just dropped.
   */
  let listed = "";
  /**
   * Store a list for the class and slot in force — the fresh one from
   * `listThreads`, or the runtime's after a write the server took, so the
   * next page load paints the edit, the reply or the deletion rather than
   * the copy from before it. Only over the list it was read as: `listed`
   * checked NOW, which also covers a round switch whose list has not landed.
   */
  const remember = (d: Snag[]): void => {
    if (listed == cls() + slot()) writeList(uid, cls(), slot(), d);
  };
  /** Every session ending goes through here, and takes both cached lists with
   *  it: a list must never outlive the credential that read it. */
  const end = (): void => {
    listed = "";
    clearSession(uid);
    dropList(uid, "member");
    dropList(uid, "guest");
  };
  /** The config's rounds, so a new thread is only sent into the round
   *  being viewed when that round still takes comments. */
  let rounds: { number: number; closed: boolean }[] = [];

  /**
   * SILENT member sign-in, for a client page on the dashboard's own
   * site (`acme.studio.dev` beside `snagset.studio.dev`). There the browser
   * sends the dashboard's `SameSite=Lax` cookie on a credentialed fetch, so
   * the widget can ask `POST …/sessions/member/silent` "is this a member?"
   * and, on a 201, hold exactly the session the popup would have
   * posted back — "Commenting as the maintainer" with no click. The server decides
   * (Fetch Metadata, a same-site permitted origin, the membership); this
   * side only decides when asking is worth a request:
   *
   *   · only when the page and the API look like one site — a client's page
   *     on an unrelated domain never sends it, the cookie would not ride;
   *   · never while a review link's token is being presented — the link is
   *     an explicit "this is who I am", and a member opening one to see a
   *     client's view gets that view;
   *   · never after "Not you? Sign out" in this browser (`localStorage`,
   *     cleared by the next popup sign-in), or the way out would be a loop;
   *   · and a "no" — a client with no cookie, a signed-out member — is
   *     remembered by the tab for ten minutes (`sessionStorage`), so walking
   *     a staging site does not repeat a refused call on every page.
   *
   * ONE request at a time, shared: the first API calls of a page load run
   * concurrently, and a guest exchange that finished after the member's
   * session was adopted would quietly overwrite it.
   *
   * `credentials: "include"` on this one fetch and on no other; the body is
   * a plain string, so it goes as `text/plain` — a CORS simple request, no
   * preflight on every page load.
   */
  const silentKey = storageKey.silent(uid);
  let silentAt = 0;
  let silentP: Promise<boolean> = Promise.resolve(false);
  function silent(): Promise<boolean> {
    if (linkToken || Date.now() - silentAt < SILENT_QUIET_MS) return silentP;
    try {
      if (!sameSiteHint(location.hostname, new URL(base).hostname)) return silentP;
      if (localStorage.getItem(silentKey) || Date.now() - Number(sessionStorage.getItem(silentKey)) < SILENT_QUIET_MS) {
        return silentP;
      }
    } catch {
      // Storage refused (private mode): asking once per page load is still right.
    }
    silentAt = Date.now();
    return (silentP = (async () => {
      try {
        const res = await fetch(`${root}/sessions/member/silent`, {
          method: "POST",
          credentials: "include",
          ...(env ? { body: JSON.stringify({ environment: env }) } : {}),
        });
        if (res.status === 201) {
          adopt((await res.json()) as MemberSession);
          // A yes is not remembered: the next time a member's session needs
          // renewing (hours later, at the cap) it asks again.
          silentAt = 0;
          return true;
        }
      } catch {
        // A network failure is a "no" like any other: the popup still works.
      }
      try {
        sessionStorage.setItem(silentKey, String(Date.now()));
      } catch {
        /* see readSession */
      }
      return false;
    })());
  }
  /** The page load's one attempt, shared by every call that races to authorize. */
  let firstSilent: Promise<unknown> | null = null;

  /** A member's session, from the popup or the silent path — stored as any other. */
  function adopt(b: MemberSession): void {
    // An identity switch: whatever member list is cached was read by whoever
    // held this browser before.
    dropList(uid, "member");
    session = {
      token: b.sessionToken,
      expiresAt: Date.parse(b.expiresAt),
      refreshableUntil: Date.parse(b.refreshableUntil),
      reviewerId: b.reviewer.id,
      permissions: b.permissions,
      member: b.reviewer.name,
      ...(b.moderator ? { moderator: true } : {}),
    };
    writeSession(uid, session);
    options.onSessionStarted?.();
  }
  /** Read through a function so a check after an `await` sees what `adopt` wrote. */
  const current = (): StoredSession | null => session;

  /**
   * Exchange or refresh — the one redemption endpoint.
   *
   * A link token if we have one, otherwise a guest identity. The design is explicit
   * that a guest exchange SUCCEEDS on a `link-required` project and returns a
   * session with reduced permissions; the `403 link_required` arrives at the
   * first write, not here. So a reviewer without a link still gets a working
   * widget that can read.
   */
  /**
   * @param reidentify Present the identity even though a bearer is held.
   *
   * Without it a held session makes this a REFRESH, which sends no identity at
   * all — so the first version of the name fix re-exchanged forever: it kept
   * noticing the name had changed, kept refreshing, and a refresh can never
   * tell the server the name. Three exchanges for one typed name, and the row
   * still said Anonymous.
   */
  async function exchange(reidentify = false): Promise<StoredSession | null> {
    const bearer = session && !isFinished(session) ? session.token : null;
    const refreshing = Boolean(bearer) && !linkToken && !reidentify;
    // A REFRESH carries no identity, so it must not clobber what we know: only
    // an exchange that actually presents a name updates this.
    const identity = refreshing
      ? undefined
      : linkToken
        ? { kind: "link" as const, token: linkToken, name: readIdentity().name || undefined }
        : {
            kind: "guest" as const,
            name: readIdentity().name || "Anonymous",
            holderId: holderId(uid),
            holderSecret: holderSecretOrUndefined(uid),
          };

    let res: Response;
    try {
      res = await fetch(`${root}/sessions`, {
        method: "POST",
        credentials: "omit",
        headers: {
          "content-type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({
          ...(env ? { environment: env } : {}),
          ...(identity ? { identity } : {}),
          client: { widget: NPM_PACKAGE, schema: SCHEMA_VERSION },
        }),
      });
    } catch (e) {
      throw new HttpAdapterError(0, "network_error", (e as Error).message);
    } finally {
      // One use, whatever happened.: "If the token is invalid the
      // fragment is still stripped" — and a token that failed once will fail
      // the same way on every retry.
      linkToken = undefined;
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code: string } } | null;
      const code = body?.error?.code ?? "unauthorized";
      const wasMember = refreshing && !!session?.member;
      end();
      session = null;
      // A member's refresh refused (the cap, an expired token) is
      // renewed from the dashboard cookie when the page is on its site —
      // before anything says "signed out". A member who LEFT the studio is
      // refused there too, and falls through to the ending below.
      if (wasMember && res.status === 401 && (await silent())) return current();
      if (code === "session_revoked" || code === "token_revoked") options.onSessionEnded?.("revoked");
      else if (res.status === 401) options.onSessionEnded?.("expired");
      throw new HttpAdapterError(res.status, code, "This review session is not valid.");
    }

    const b = (await res.json()) as {
      sessionToken: string;
      expiresAt: string;
      refreshableUntil: string;
      reviewer?: { id: string };
      holderSecret?: string;
      permissions?: string[];
      round?: { id: string; number: number };
    };
    // Returned ONCE, on first creation of this person — so it is
    // stored the one time it appears and presented on every later exchange.
    if (b.holderSecret && b.reviewer) rememberHolder(uid, b.reviewer.id, b.holderSecret);
    else if (b.reviewer) rememberHolderId(uid, b.reviewer.id);

    // `round` is only sent on a fresh EXCHANGE (it comes from the link
    // row, which a bare-bearer refresh never re-reads), so a REFRESH must
    // carry the previous value forward or lose the pin every 15 minutes.
    // A fresh exchange must NOT do that carrying: it used to read
    // `session?.round` unconditionally, and on this project that is live —
    // open Kilnwork through a round-pinned link, then reopen it through a
    // DIFFERENT, unpinned link in the same tab before the first session
    // expires, and the stale round from the old `sessionStorage` entry
    // silently pinned the new, supposedly-unpinned reviewer too. Only a
    // refresh (no `identity` on the request) may fall back to the old value
    // — and so may a RE-IDENTIFY, the same reviewer telling us their name:
    // without it, typing a name in the composer reset the round being viewed
    // and the comment went to the default round instead.
    const round = b.round?.number ?? (refreshing || reidentify ? session?.round : undefined);
    // What this session was minted with, so `authorize()` can tell when the
    // reviewer has since told us their name. A REFRESH presents no identity
    // and must not clobber it.
    const name = identity ? identity.name : session?.name;
    // Somebody else now — a different link opened in this tab. What the last
    // reviewer was shown is not this one's to see, even for a moment.
    if (session && b.reviewer && b.reviewer.id !== session.reviewerId) end();

    session = {
      token: b.sessionToken,
      expiresAt: Date.parse(b.expiresAt),
      refreshableUntil: Date.parse(b.refreshableUntil),
      reviewerId: b.reviewer?.id ?? session?.reviewerId ?? "",
      permissions: b.permissions ?? session?.permissions ?? [],
      ...(round !== undefined ? { round } : {}),
      // A refresh keeps the member a member. Any exchange that presents
      // an identity (a guest, a link) is somebody else, so it does not.
      ...(refreshing && session?.member ? { member: session.member } : {}),
      ...(refreshing && session?.member && session.moderator ? { moderator: true } : {}),
      ...(name ? { name } : {}),
    };
    writeSession(uid, session);
    options.onSessionStarted?.();
    return session;
  }

  /**
   * Re-check the session NOW, whether or not a refresh was due — L1.1b.
   *
   * `authorize()` only exchanges when the session is expiring, so a session
   * that was REVOKED five minutes ago stays unexamined until the reviewer does
   * something. On an idle page that is never: they sit looking at pins that no
   * longer load, and the first they hear of it is a failed comment. F-18b is
   * specified and, on that page, unsurfaced.
   *
   * This forces the exchange, so both endings arrive through the paths that
   * already exist: `onSessionEnded` for a dead one, `onSessionStarted` for a
   * session that is fine. Deliberately NOT a poll (sweep R6 forbids resident
   * loops) — the runtime calls it when the tab becomes visible again, which is
   * the moment a reviewer's attention returns and the only moment the answer
   * changes anything.
   */
  async function revalidate(): Promise<void> {
    if (!session) return;
    if (isFinished(session)) {
      end();
      session = null;
      // A member at the cap is renewed silently where it can be.
      if (!(await silent())) options.onSessionEnded?.("expired");
      return;
    }
    await exchange().catch(() => {
      // exchange() has already told the caller which ending it was; a throw
      // here is that same news arriving twice.
    });
  }

  /** The bearer for the next call, refreshing silently if it is due. */
  /**
   * The name the CURRENT session was minted with — `session.name`, kept on the
   * stored session so a reload remembers it, and compared in `authorize()`.
   *
   * ── WHY THIS EXISTS ──
   *
   * *"a session's identity is decided at exchange and never taken
   * from a request."* Correct, and it has a consequence nobody had followed
   * through: the session is minted when the widget activates, which is BEFORE
   * the composer has asked anybody their name. So the reviewer row was created
   * `Anonymous`, the client then typed "Ana at Acme", `writeIdentity` stored
   * it — and every comment they left was attributed to Anonymous, for the life
   * of that session.
   *
   * On a review tool with three people from the client's side in it, that is
   * the difference between a usable round and a list of anonymous complaints.
   *
   * The server already handles the fix: a guest re-exchange presenting the
   * same `holderId`/`holderSecret` with a typed name UPDATES the existing
   * reviewer row (sessions.ts). Nothing needed to change there. What
   * was missing was anything asking it to.
   *
   * And ONE exchange at a time, shared. `init()` and the first list run
   * concurrently, both found no session, and each exchanged: two
   * `POST …/sessions` on every first load, measured, one of them wasted and
   * racing the other to write the session.
   */
  let exchanging: Promise<unknown> | null = null;

  async function authorize(): Promise<string | null> {
    // The page load's one silent attempt, before anything exchanges as
    // a guest — only when no member is held already.
    await (firstSilent ??= session?.member ? Promise.resolve() : silent());
    if (session && isFinished(session)) {
      end();
      session = null;
      // …and a member whose session reached the cap is renewed the same way.
      if (!(await silent())) {
        options.onSessionEnded?.("expired");
        return null;
      }
    }
    /**
     * A NAME LEARNED SINCE THE EXCHANGE FORCES A NEW ONE.
     *
     * Every write goes through here, so this is the one place that can notice.
     * Compared against what we exchanged with rather than against "is there a
     * name" — a reviewer who corrects their name mid-round gets that too, and
     * a reviewer who never types one exchanges exactly once.
     */
    const stored = readIdentity().name || null;
    // Never for a studio member: their name is the account's, and the
    // re-exchange this triggers is a GUEST one that would sign them out.
    const nameChanged = session !== null && !session.member && stored !== null && stored !== (session.name ?? null);

    if (!session || needsRefresh(session) || linkToken || nameChanged) {
      try {
        await (exchanging ??= exchange(nameChanged).finally(() => (exchanging = null)));
      } catch (e) {
        // A failed exchange must not take down a READ. The call proceeds
        // unauthenticated and the server decides.
        if (!(e instanceof HttpAdapterError) || e.status === 0) throw e;
        return null;
      }
    }
    return session?.token ?? null;
  }

  async function call<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
    const bearer = await authorize();
    let res: Response;
    try {
      res = await fetch(root + path, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(init?.headers ?? {}),
        },
        // The reviewed page is a DIFFERENT origin from the Snagset host, so
        // this is always cross-origin. No credentials: the guest identity is
        // the holder secret in the body, not a cookie, which is also why none
        // of this needs CSRF machinery.
        credentials: "omit",
      });
    } catch (e) {
      // A network failure and a rejected request are different things to a
      // reviewer: one is "try again", the other is "this will not work".
      throw new HttpAdapterError(0, "network_error", (e as Error).message);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
      const code = body?.error?.code ?? "http_error";
      // ONE silent re-up. A token that lapsed between `authorize()` and the
      // server reading it is a race, not a signed-out reviewer — and the design is
      // explicit that the 15-minute boundary must be invisible. Bounded to one
      // retry so a genuinely dead session fails instead of looping.
      if (res.status === 401 && !retried && code !== "session_revoked") {
        const wasMember = !!session?.member;
        end();
        session = null;
        // A member's lapsed token is renewed as a member, not as a guest.
        if (wasMember) await silent();
        return call<T>(path, init, true);
      }
      throw new HttpAdapterError(
        res.status,
        code,
        body?.error?.message ?? `The server answered ${res.status}.`,
      );
    }
    return (await res.json()) as T;
  }

  return {
    kind: "http",
    // Advertised, never assumed. `init()` narrows these from what the
    // server actually reports; until it answers, claim the least.
    capabilities: {
      attachments: "none",
      realtime: "none",
      anchorReports: true,
      identity: ["guest"],
      export: [],
      serverSideSearch: false,
      privateThreads: false,
      // An instance always has the pool; whether THIS session may
      // change who holds a snag is `can("thread:assign")`, asked per render.
      assignees: true,
    },

    async init(ctx: AdapterContext): Promise<ProjectConfig> {
      /**
       * PUBLIC, so asked WITHOUT the session and beside it rather than after
       * it. Through `call()` this waited for the exchange, then carried a
       * bearer — and the `Authorization` header made it a preflighted request
       * the browser cache could not answer. Bare, it is the very request the
       * stub just made (`max-age=60`), so it usually costs nothing, and the
       * exchange the first list needs starts now instead of after it.
       */
      void authorize().catch(() => {});
      const res = await fetch(`${root}/config`).catch((e: Error) => {
        throw new HttpAdapterError(0, "network_error", e.message);
      });
      if (!res.ok) throw new HttpAdapterError(res.status, "http_error", `The server answered ${res.status}.`);
      const cfg = (await res.json()) as {
        features: { screenshots: boolean; uploads: boolean };
        rounds?: { number: number; name: string; closed: boolean }[];
        writable?: boolean;
        reason?: string;
      };
      // A9b: the widget NEVER probes storage. It reads this flag and renders
      // accordingly, so a deployment with no bucket hides the screenshot
      // control rather than offering one whose upload would fail. Mutating
      // `capabilities` here is what makes that one fact, read once.
      (this.capabilities as { attachments: "direct" | "none" }).attachments = cfg.features.screenshots
        ? "direct"
        : "none";
      rounds = cfg.rounds ?? [];
      return {
        uid: ctx.uid,
        env: ctx.env,
        features: cfg.features,
        ...(cfg.rounds ? { rounds: cfg.rounds } : {}),
        // Carried rather than acted on here: the adapter's job is to report
        // what the server said, and WHO gets told is a runtime decision (an
        // archive.org mirror must stay silent).
        ...(cfg.writable === undefined ? {} : { writable: cfg.writable }),
        ...(cfg.reason === undefined ? {} : { reason: cfg.reason }),
      };
    },

    /** The reviewer's explicit round choice, kept ON the stored session
     *  (T8 already seeds it there from a round-pinned link) so a reload keeps
     *  it and `listThreads` sends it without a second source of truth. */
    /**
     * Fire-and-forget by contract, not by laziness.
     *
     * This is the write that replaces `patchThread({ anchorState })`, which
     * against a server was a SILENT NO-OP: does not accept `anchor` or
     * `anchorState` in a PATCH body and never has, so the re-anchor result had
     * been going nowhere since the HTTP adapter existed. It worked locally,
     * which is exactly why nobody noticed.
     *
     * Every failure is swallowed — including the 404 from a server older than
     * this route. A reviewer must never see an error because their browser
     * disagreed with someone else's about a pin, and telemetry that can
     * interrupt the person generating it is worse than no telemetry.
     */
    async reportAnchors(batch: AnchorReport[]): Promise<void> {
      if (batch.length === 0) return;
      // Caps a batch at 50. Chunked rather than truncated: a page with 120
      // pins has 120 real observations and dropping 70 of them would bias the
      // measurement toward pages small enough to fit.
      for (let i = 0; i < batch.length; i += 50) {
        try {
          await call<void>("/anchor-reports", {
            method: "POST",
            body: JSON.stringify({ reports: batch.slice(i, i + 50) }),
          });
        } catch {
          return; // one failure ends the attempt; the next pass reports again
        }
      }
    },
    revalidate,
    /**
     * "Sign in with Snagset". The session arrives from the dashboard
     * popup rather than from `exchange()`, and is stored the same way and in
     * the same place, so every path after this one — refresh, revalidate,
     * the 401 retry, the cap — treats it as any other session.
     */
    member: () => session?.member ?? null,
    adoptSession(b: MemberSession): void {
      // A popup sign-in is the member saying "me" again: the silent path may
      // renew them from now on.
      try {
        localStorage.removeItem(silentKey);
      } catch {
        /* see readSession */
      }
      adopt(b);
    },
    /** Dropped here and nowhere else: a widget session is a signed token with
     *  no server row to revoke, and the next request exchanges as the guest
     *  this browser already was (its holder secret is untouched). */
    signOut(): void {
      end();
      session = null;
      // And not silently signed back in on the next page. Kept for the
      // browser until the popup is used again.
      try {
        localStorage.setItem(silentKey, "out");
      } catch {
        /* see readSession */
      }
    },
    remember,
    // A session past its cap is about to be ended, and a member's may come
    // back a guest's — so it reads as "nothing cached" rather than painting
    // a list its holder may no longer see.
    //
    // An explicit pick of the round the server was ALREADY serving by default
    // (the newest open one, as the dock's selector assumes) falls back to the
    // copy read under no round at all — the same list under two names.
    cached(): Snag[] | null {
      if (session && isFinished(session)) return null;
      const c = cls();
      return (
        readList(uid, c, slot()) ??
        (session?.round === rounds.find((r) => !r.closed)?.number ? readList(uid, c, `${env ?? ""}:`) : null)
      );
    },
    getRound(): number | null {
      return session?.round ?? readSession(uid)?.round ?? null;
    },
    setRound(round: number): void {
      // BOTH copies: `listThreads` reads the in-memory `session` closure, not
      // storage, so writing only sessionStorage would leave the very next
      // list on the old round until a reload — a selector that looks broken.
      if (session) session = { ...session, round };
      const stored = readSession(uid);
      if (stored) writeSession(uid, { ...stored, round });
    },

    /**
     * (b): the image goes to OUR API, not straight to the bucket.
     *
     * It is already inside A9b′'s 256 KB encode budget, so routing it through
     * the server costs nothing and buys the size check, the quota accounting
     * and the project-scoped auth in one place. The presigned direct PUT is
     * for `kind: 'file'`, which is not this.
     *
     * Absent entirely when no bucket is connected — the runtime tests for the
     * method before calling it, so annotation mode simply does not have one.
     */
    async fetchForeignImage(url: string): Promise<Blob | null> {
      try {
        const bearer = await authorize();
        // `?src=`, not a path segment: the URL is the payload, and a query
        // parameter carries it whole, slashes and all.
        const res = await fetch(`${root}/image?src=${encodeURIComponent(url)}`, {
          credentials: "omit",
          ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
        });
        if (!res.ok) return null;
        const blob = await res.blob();
        return blob.type.startsWith("image/") ? blob : null;
      } catch {
        return null;
      }
    },

    async uploadAttachment(blob: Blob, meta: AttachmentMeta): Promise<Attachment> {
      const bearer = await authorize();
      const res = await fetch(`${root}/attachments`, {
        method: "POST",
        credentials: "omit",
        headers: {
          "content-type": blob.type || "image/webp",
          [HTTP_HEADER.attachmentKind]: meta.kind,
          ...(meta.width ? { [HTTP_HEADER.attachmentWidth]: String(meta.width) } : {}),
          ...(meta.height ? { [HTTP_HEADER.attachmentHeight]: String(meta.height) } : {}),
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: blob,
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
        // The rule: a failed attachment costs the picture, never the comment.
        // The caller catches this and sends the thread without one.
        throw new HttpAdapterError(res.status, b?.error?.code ?? "upload_failed", b?.error?.message ?? "Upload failed.");
      }
      const a = (await res.json()) as { id: string; byteSize: number; contentType: string };
      return {
        id: a.id,
        kind: meta.kind,
        contentType: a.contentType,
        byteSize: a.byteSize,
        ...(meta.width ? { width: meta.width } : {}),
        ...(meta.height ? { height: meta.height } : {}),
        url: `${base}/api/v1/attachments/${a.id}/blob`,
      } as Attachment;
    },

    async listThreads(q?: ThreadQuery): Promise<ThreadList> {
      // `authorize()` FIRST, awaited, before `session.round` is read below.
      // `call()` also runs `authorize()` internally, but that happens AFTER
      // this function has already built `params` — reading `session` before
      // that inner call resolves caught it mid-exchange (still null) on the
      // very first list of a page load, silently dropping `round` AND, worse,
      // racing this call's own `authorize()` against the one `init()`'s
      // `/config` triggered: two concurrent callers each found no session and
      // exchanged separately, minting two reviewers for one page load. Proved
      // live against dogfood: the network tab showed two `POST …/sessions`
      // for one reviewer and the `GET …/threads` that followed carried no
      // `round` at all. Awaiting here makes the second `authorize()` inside
      // `call()` the no-op it was supposed to be (session already fresh).
      //
      // …EXCEPT on a first visit, holding no session and presenting no link.
      // The list reads no claim of the session (threads.ts answers it with
      // none), so waiting for the exchange bought nothing but a round trip in
      // series — and asked bare, with no header at all, it is a CORS simple
      // request with no preflight either. The exchange still starts now, for
      // the writes; anything but a 200 falls back to the authorized path.
      const bare = !session && !linkToken;
      if (bare) void authorize().catch(() => {});
      else await authorize();
      const params = new URLSearchParams();
      if (env) params.set("env", env);
      if (q?.route) params.set("route", q.route);
      // A round-pinned link's number, carried on the stored session (see
      // session.ts). Absent when unpinned — the server then applies its own
      // default (latest open round for a non-owner reader). No UI reads or
      // sets this yet; that is T10.
      if (session?.round) params.set("round", String(session.round));
      type List = { data: Wire[]; nextCursor: string | null; serverTime: string };
      const path = `/threads?${params}`;
      const authed = () => call<List>(path);
      // Where this list is cached, decided NOW, with the credential it is
      // about to be read with — not when it lands.
      const c = cls();
      const at = slot();
      const list = await (bare
        ? fetch(root + path, { credentials: "omit" }).then((r) => (r.ok ? (r.json() as Promise<List>) : authed()), authed)
        : authed()
      ).catch((e: unknown) => {
        // Refused (401, 403, `link_required`): what this browser cached is no
        // longer this reviewer's to see. A network failure keeps it.
        if (e instanceof HttpAdapterError && (e.status === 401 || e.status === 403)) dropList(uid, c), (listed = "");
        throw e;
      });
      const data = list.data.map((w) => toSnag(w, env, base));
      // Noted as read with `c` for `at`, and stored only if that is still
      // the credential and slot in force: a member's list is only written
      // while they are still the member (a sign-out that landed mid-flight
      // dropped the cache, and this must not put it back), and a guest whose
      // sign-in landed mid-flight has a member's list coming instead.
      listed = c + at;
      remember(data);
      return {
        data,
        ...(list.nextCursor ? { nextCursor: list.nextCursor } : {}),
        deleted: [],
        serverTime: list.serverTime,
      };
    },

    async getThread(id: string): Promise<Thread | null> {
      // No single-thread route yet; the list is small and already filtered.
      const list = await this.listThreads();
      return list.data.find((t) => t.id === id) ?? null;
    },

    async getThreadByKey(key: string): Promise<Thread | null> {
      // The `?key=`, which overrides every other filter server-side
      // including the round default that made shared permalinks fail.
      // No `authorize()` here: `call()` does it, and the redundant one was
      // copied from `listThreads`, where it is also redundant.
      const params = new URLSearchParams({ key });
      if (env) params.set("env", env);
      const list = await call<{ data: Wire[] }>(`/threads?${params}`);
      const found = list.data[0];
      return found ? toSnag(found, env, base) : null;
    },

    async createThread(input: CreateThreadRequest): Promise<Thread> {
      // The comment goes to the round being VIEWED, when that round is
      // open. No choice, or a closed one, sends none and the server picks
      // (the link's round, else the newest open) — the runtime has already
      // said so in the composer and moved the view there.
      const viewed = session?.round;
      const round = rounds.some((r) => r.number === viewed && !r.closed) ? viewed : undefined;
      const post = (round?: number) => call<Wire>("/threads", {
        method: "POST",
        body: JSON.stringify({
          id: input.id,
          anchor: toWireAnchor(input.anchor as unknown as Record<string, any>, input.route),
          anchorState: input.anchorState,
          context: input.context,
          // The adapter owns the scope it sends, and ignores `input.scope`:
          // the runtime fills that with its own `"default"` placeholder when
          // the host set no `data-snag-env`, and forwarding it asks the server
          // for an environment nobody created. No env configured ⇒ no scope ⇒
          // the server uses the project's default, which is what `is_default`
          // is for.
          ...(env || round ? { scope: { ...(env ? { environment: env } : {}), ...(round ? { round } : {}) } } : {}),
          // No holder secret on the wire any more: the BEARER identifies the
          // author (its `sub` is the reviewer), so a body field claiming an
          // identity would be a second, weaker answer to the same question.
          createdBy: { name: input.createdBy.name },
          ...(input.comment ? { comment: { id: input.comment.id, body: input.comment.body } } : {}),
          // The screenshot was uploaded a moment ago and is a `pending` row
          // with no owner. Sending its id here is what binds it to this
          // thread, in the same transaction (v1's wire binds
          // attachments relationally after the fact).
          ...(input.attachments?.length
            ? { attachments: input.attachments.map((a) => a.id) }
            : {}),
        }),
      });
      // Closed or archived since this page read the config: the comment is
      // not lost over it, it goes where the server would put it anyway.
      const w = await post(round).catch((e: unknown) => {
        if (round && e instanceof HttpAdapterError && e.code.startsWith("round_")) return post();
        throw e;
      });
      return toSnag(w, env, base);
    },

    async patchThread(id: string, patch: ThreadPatch): Promise<Thread | null> {
      const has = "assignee" in patch;
      if (!patch.status && !has) return null;
      const w = await call<Wire>(`/threads/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(patch.status ? { status: patch.status } : {}),
          ...(has ? { assignee: patch.assignee ?? null } : {}),
        }),
      });
      return toSnag(w, env, base);
    },

    /** The pool — the studio, then whoever has written on this site. */
    async listAssignees(q?: string): Promise<Reviewer[]> {
      const r = await call<{ data: Reviewer[] }>(`/assignees${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      return r.data ?? [];
    },

    /**
     * The server lets a reviewer delete a thread only while every comment in
     * it is theirs (threads.ts) — the same rule the dock uses to offer it.
     */
    async deleteThread(id: string): Promise<void> {
      await call(`/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    /**
     * Two ids can be this reviewer: the live session's, and the holder id a
     * guest keeps across sessions (identity.ts) — a guest whose session
     * lapsed overnight still wrote yesterday's comments.
     */
    isMine(author: Reviewer): boolean {
      if (!author.id) return false;
      return author.id === (session ?? readSession(uid))?.reviewerId || author.id === holderId(uid);
    },

    canModerate(): boolean {
      const s = session ?? readSession(uid);
      return !!s?.member && !!s.moderator;
    },

    can(permission: string): boolean {
      return (session ?? readSession(uid))?.permissions.includes(permission) ?? false;
    },

    /**
     * T6 — mirrors `createThread` above. T5's route is mounted at BOTH
     * `/api/v1/threads/:id/comments` and, because `call()` only ever builds
     * `root + path` (`root` is always `.../projects/:uid`), also at
     * `/api/v1/projects/:uid/threads/:id/comments` — so this needs no
     * absolute-path escape hatch, just the same `call()` every other method
     * here uses.
     *
     * `input.author` is not sent: the bearer's `sub` IS the reviewer
     * so a body field claiming an identity would be a second, weaker
     * answer to the same question — exactly `createThread`'s reasoning for
     * dropping the holder secret from the wire.
     */
    async createComment(threadId: string, input: CreateCommentRequest): Promise<Comment | null> {
      const w = await call<{ id: string; body: string; createdAt: string; author: Reviewer }>(
        `/threads/${encodeURIComponent(threadId)}/comments`,
        {
          method: "POST",
          body: JSON.stringify({ id: input.id, body: input.body }),
        },
      );
      return {
        id: w.id,
        snagId: threadId,
        body: w.body,
        author: w.author,
        createdAt: w.createdAt,
      };
    },

    /**
     * 05 endpoints 12 and 13. Both answered `501 not_implemented` while the
     * detail panel rendered Edit and Delete buttons for them — so on every
     * server-backed install a reviewer who made a typo clicked Edit and got an
     * error. The LOCAL adapter implemented both, which is exactly why nothing
     * caught it: the demo worked and the product did not.
     */
    async patchComment(id: string, body: string): Promise<Comment | null> {
      // `null`, not the updated comment. The interface allows either and the
      // ONLY caller discards it — `editComment` has already applied the change
      // optimistically and re-reads on the next poll. Building a `Comment` to
      // throw away cost bytes in the eager envelope, which is the one budget
      // in this product measured in bytes.
      await call(`/comments/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
      return null;
    },

    async deleteComment(id: string): Promise<void> {
      // The response is the tombstone, returned rather than a 204 so a
      // client that wants to render the hole can. This one does not.
      await call(`/comments/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  } as StorageAdapter;
}
