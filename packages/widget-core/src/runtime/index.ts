// snag.runtime.js — the core runtime chunk (shield, hit-test, pin layer, anchor
// core, storage). Reached ONLY through the stub's dynamic import, so a
// non-reviewer never downloads it. Vanilla: Preact lives in snag.panels.js.
import { createHost, keepHostMounted, keepHostAnnounced, sealHostEvents, HOST_CSS } from "./host.ts";
import { adopt, applyTheme, themePref, TOKENS_CSS } from "./theme.ts";
import { createPointerController, type PointerController, type PointerMode } from "./pointer.ts";
import { resolveAnchor } from "../anchor/resolve.ts";
import { createPinLayer, type PinLayer } from "./pins.ts";
import { createNotice, type Notice } from "./notice.ts";
import { createPausedNotice, type PausedNotice } from "./paused.ts";
import { watchPage, type PageWatcher } from "./watch.ts";
import { takeHandoff, writeHandoff } from "./jump.ts";
import { defaultFilter, isUnread, pinPass, type ListFilter } from "../storage/filter.ts";
import { glueChrome } from "./vv.ts";
import { LAYER } from "./theme.ts";
import { normalisePath, redactRoute, routeWithHint } from "./route.ts";
import { queryMatches, significantQuery, type QueryPolicy } from "./params.ts";
import { watchMutations, type MutationWatch } from "./mutate.ts";
import { loadChunk } from "./chunks.ts";
import { saveDraft, readDraft, clearDraft, anyDraft, type Draft } from "./draft.ts";
import { createToolbar, type Toolbar } from "./toolbar.ts";
// A SOURCE copy, bundled into the runtime — the navigator must scroll
// with the dock chunk never loaded, and visibleStrip degrades to the full
// viewport when no dock is in the shadow root.
import { scrollToSnag } from "../panels/scroll.ts";
import type { CaptureContext } from "../capture/types.ts";
import { createLocalAdapter, storageWorks } from "../storage/local.ts";
import { createSeenStore } from "../storage/seen.ts";
import { createHttpAdapter } from "../storage/http.ts";
import { loadShotBlob } from "../storage/shots.ts";
import { badgeFor, writeCounts } from "../storage/counts.ts";
import { storageKey, param, ARTIFACT, GLOBALS, ID_PREFIX, PRODUCT, TERM_ITEM } from "@snagset/types/names";
import { AdapterError, threadFromRequest } from "../storage/types.ts";
import { format } from "../strings/runtime.ts";
import { newThreadId, newCommentId } from "../storage/ids.ts";
import type { ComposerHandle, ComposerProps } from "../panels/composer.tsx";
import type { DockHandle, DockProps } from "../panels/dock.tsx";
import type {
  CreateThreadRequest,
  ThreadScope,
  Reviewer,
  Snag,
  Status,
  StorageAdapter,
} from "../storage/types.ts";

/**
 * RESIDENCY: the redaction module lives IN this chunk
 * the stub's Tier A/B breadcrumbs hand their unredacted early[] to mount(),
 * so redaction-at-handoff happens here. This re-export is what forces it
 * resident and makes it part of the runtime's public surface.
 *
 * The capture chunk bundles its own COPY from the same source file, and that
 * is a decision, not an accident: chunks are SELF-CONTAINED. An earlier
 * design had chunks importing shared modules from each other by canonical
 * `?cv` URL — real cross-chunk ESM — and it died of a real disease, measured
 * three ways: a rejected import poisons its canonical URL in the module map,
 * so no retry scheme can heal a baked specifier; probing with fetch-first
 * doubled the critical-path round trips and failed the Fast-3G perf gate; and
 * probing with modulepreload misread Chromium's load-shedding of preloads as
 * unreachability, failing the Retry tests under load 12 times out of 12.
 * Duplicated bytes in LAZY chunks cost the activation envelope nothing —
 * which is the entire budget argument — and one SOURCE file means no fork:
 * the residency test pins both halves.
 */
export { isSensitiveValue, redactText, redactUrl } from "../redact/predicates.ts";

export interface MountContext {
  assetBase: string;
  config: Record<string, string | undefined>;
  /**
   * The raw `#snag_k`, in memory only. Deliberately NOT a member of
   * `config`: that map is strings from attributes and the URL, is logged in
   * places, and a credential in it would be a credential in all of them.
   */
  reviewToken?: string | undefined;
  /**
   * The stub's event bus. Optional, because the runtime is a mountable
   * module in its own right — the E2E harness and the unit tests mount it with no
   * stub above them, and an event bus is not a precondition for a widget.
   */
  emit?: (type: string, payload?: unknown) => void;
  /**
   * The Tier A/B backlog the stub accumulated before activation.
   * Type-only import — erased at build, so the artefacts stay self-contained
   * Absent when breadcrumbs are configured off, or when the runtime is
   * mounted without a stub above it.
   */
  early?: import("../loader/crumbs-early.ts").EarlyCrumbs;
}

export type OpenResult =
  | { ok: true; anchorState: import("../anchor/types.ts").AnchorState }
  | { ok: false; reason: "not-found" | "wrong-page"; url?: string; route?: string };

export interface RuntimeMount {
  readonly root: ShadowRoot;
  readonly assetBase: string;
  /** The snags on this route, re-anchored against the live DOM. */
  snags(): Snag[];
  /** Create a snag at a picked element. Persists, re-anchors and re-renders.
   *
   *  `context` is optional on this public entry point ONLY: a host calling
   *  `add()` directly has no T0 to speak of, so one is taken now. The internal
   *  pin flow always passes the snapshot it took at the click. */
  add(
    el: Element,
    point: { x: number; y: number },
    body?: string,
    context?: CaptureContext,
  ): Promise<Snag>;
  /** Re-resolve every anchor and repaint. Called on load, and after DOM changes. */
  refresh(): Promise<Snag[]>;
  /** Path 1: the route-pattern override — always
   *  authoritative over the meta hint and the pathname, reversible to null.
   *  The safety valve means a wrong value can only fail to widen matching. */
  setRoute(pattern: string | null): void;
  /** The three states: browse | comments | add. */
  setState(state: PointerMode): void;
  getState(): PointerMode;
  /** Open the dock — at the list, or straight into one snag's thread. */
  openPanel(id?: string | null): Promise<void>;
  /** Open by `Thread.key` (SN-14) or `thr_…` id, never a
   *  bare UUID. NEVER navigates — wrong page returns the URL and the host
   *  decides; an orphan still opens, `{ok:true, anchorState:'orphaned'}`. */
  open(idOrKey: string): Promise<OpenResult>;
  closePanel(): void;
  hitTest(x: number, y: number): Element[];
  destroy(): void;
}

// No name until somebody gives one. "You" was rendered to everyone who read
// the round afterwards, which is wrong the moment it is not you reading it.
const GUEST: Reviewer = { id: "rev_local", name: format("author.unknown"), kind: "guest" };

/**
 * This chunk's own version, for the `?cv=`.
 *
 * Declared here rather than imported from the stub: the two are separate
 * artefacts by construction, and the runtime must be able to state its own
 * version without reaching across that boundary. The R7 is precisely the
 * case where they DISAGREE.
 */
const VERSION = "0.0.0";

/**
 * Who is writing. The composer asks once and stores the answer; a reply made
 * later must be attributed to the same person without asking again. A guest
 * identity means "same browser", which is all v0 can honestly claim.
 */
/**
 * Who a comment is attributed to.
 *
 * The stored identity is `{name, email?}` and was a bare name string
 * before it; both are accepted, because the only copies that exist are on the
 * machines of people mid-round. `kind` stays `guest` whatever the email says —
 * the design is explicit that a self-declared address "is never treated as proof
 * of who someone is", and promoting on it would be exactly that.
 */
function reviewer(name?: string, email?: string): Reviewer {
  if (name) return { ...GUEST, name, ...(email ? { email } : {}) };
  try {
    const raw = localStorage.getItem(storageKey.identity);
    // `{name, email?}`, a bare name before it. The FALLBACK takes only
    // the name: it exists for a host calling `add()` with no author, and the
    // address is a courtesy the composer always supplies when a person writes.
    // Parsing one here to reach a field this path cannot use would be bytes in
    // the eager chunk for a case that does not arise.
    if (raw) return { ...GUEST, name: raw[0] === "{" ? (JSON.parse(raw).name ?? GUEST.name) : raw };
  } catch {
    /* storage disabled or malformed — fall through to the anonymous guest */
  }
  return GUEST;
}

/** `SN-14` — permanent, human-facing, and what a permalink and an export carry. */
function nextKey(snags: Snag[]): string {
  const max = snags.reduce((m, s) => {
    const n = Number(s.key.split("-")[1] ?? 0);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `SN-${max + 1}`;
}

/** Route identity for v0: pathname only. Query and hash are page state, not identity. */
/**
 * The route, with token-shaped segments removed.
 *
 * ONE function for both jobs — the key `paint()` filters on and the value
 * `add()` persists — because a stored route and a live route that disagree
 * means a pin that never appears on its own page.
 */
/**
 * The live route override — path 1, set through the public
 * `setRoute` and reversible to null. Module state is correct HERE and only
 * here: this is the runtime chunk's own copy of the ladder, and the capture
 * chunk receives the value by injection (PageRefOptions) because its bundled
 * copy of these sources cannot see this variable.
 */
let routeOverride: string | null = null;
const routeOf = (doc: Document): string => routeWithHint(doc, routeOverride);

export function mount(_root: ShadowRoot | undefined, ctx?: MountContext): RuntimeMount {
  const root = createHost();
  const doc = root.ownerDocument ?? document;
  const win = doc.defaultView ?? window;
  const uid = ctx?.config?.site ?? "local";
  // Every event this runtime raises goes through here. The `?? noop` is what
  // lets the emit sites below stay unguarded one-liners rather than each
  // carrying its own `if (ctx?.emit)`.
  const emit = ctx?.emit ?? ((): void => {});
  const assetBase = ctx?.assetBase ?? "./";
  const env = ctx?.config?.env ?? "default";

  // Tokens FIRST, before any component installs a sheet: insertion order is
  // cascade order, and everything below reads `--snag-*`. Then the theme, which
  // reflects onto our own host and nothing else.
  adopt(root, "tokens", TOKENS_CSS);
  const releaseTheme = applyTheme(root.host as HTMLElement, themePref(ctx?.config?.theme));

  /** The blob port fills in the moment the capture chunk lands. */
  const blobPort: { put?: unknown; del?: unknown } = {};
  /**
   * Which adapter — the seam, and the one decision that turns a local
   * notebook into a shared review.
   *
   * `data-snag-host` present ⇒ HTTP. Not `data-snag-storage="http"`: the host
   * is the thing that has to be there for a server to exist at all, so
   * requiring both would make "I set the host and nothing was shared" a
   * supported configuration. `data-snag-storage="local"` is the explicit
   * override, for a host that wants the widget on a page whose server it does
   * not want written to.
   *
   * The local adapter stays the DEFAULT and the fallback: no host, no network,
   * no account — the whole first-run promise, unchanged.
   */
  const apiHost = ctx?.config?.storage === "local" ? undefined : ctx?.config?.host;
  const storage: StorageAdapter =
    apiHost && uid !== "local"
      ? createHttpAdapter(apiHost, uid, ctx?.config?.env, {
          reviewToken: ctx?.reviewToken,
          // F-19 on revoke, F-18b at the 12-hour cap. Different
          // events, different sentences.
          onSessionEnded: (reason) => {
            notice.show(reason === "revoked" ? "error.linkrevoked" : "error.sessionended");
          },
          // And take it back when a new session lands. A notice that cannot be
          // retracted is a notice that eventually lies.
          onSessionStarted: () => notice.hide(),
        })
      : createLocalAdapter(uid, env, {
          put: (id, rec) => (blobPort.put as (i: string, r: unknown) => Promise<void>)(id, rec),
          del: (id) => (blobPort.del as (i: string) => Promise<void>)(id),
        });
  // Read/unread, client-local by decision (the note) and so
  // beside the adapter rather than behind it — there is no route for this and
  // no adapter method, on purpose. Same key as the threads it describes.
  const seen = createSeenStore(uid, env);
  // Advertised, never assumed: the UI renders from capabilities, so a
  // deployment without attachments hides the control rather than failing a call.
  // The config's round history is kept for the dock's selector; when it
  // lands after the dock is already open, one update repaints the header.
  let roundInfo: import("../storage/types.ts").RoundInfo[] | null = null;
  // Retried, not abandoned: a config that failed once (a blip, a cold
  // serverless start) used to leave the widget without its round switcher,
  // write mode and screenshot switch until the page was reloaded.
  const loadConfig = (tries: number): ReturnType<typeof storage.init> =>
    storage.init({ uid, env }).catch((e: unknown) =>
      tries >= 3 ? Promise.reject(e) : new Promise((r) => setTimeout(r, 1500 * (tries + 1))).then(() => loadConfig(tries + 1)),
    );
  void loadConfig(0).then((cfg) => {
    roundInfo = cfg.rounds ?? null;
    dock?.update(dockProps());

    /**
     * Layer 3 /: this page's address is not on the site's
     * allow-list, so nothing written here could be saved.
     *
     * Said ONLY because somebody deliberately turned the widget on. If the
     * runtime is here at all, an explicit trigger brought it — `mode="on"`, a
     * review link, a permalink, `init()`, or a returning holder — because
     * the automatic path never activates without `writeMode: "open"` AND
     * `writable !== false`, and a stranger origin fails the second test in the
     * stub. So the mirrored-copy case cannot reach this line, and the
     * developer who forgot to allow-list their staging domain gets the
     * sentence instead of a toolbar that silently refuses everything.
     *
     * `=== false` and not falsy: a server from before sends no field at
     * all, and "no opinion" must not read as "refused".
     */
    if (cfg.writable === false && cfg.reason === "origin_not_allowed") {
      // No action: there is nothing the reviewer can do about it. The fix is
      // in the dashboard, and it belongs to whoever installed the tag.
      notice.show("error.origin", undefined, { origin: location.origin });
    }
  }).catch(() => {});
  let all: Snag[] = []; // every route
  let visible: Snag[] = []; // this route only

  /**
   * Can anything we write actually be read back? (F-01)
   *
   * Probed ONCE, at mount, because the answer is a property of the browser and
   * not of any one write. Everything downstream — the banner, the absent count
   * pill — hangs off this single fact.
   */
  const persists = storageWorks();

  /**
   * A pin is a button: clicking it opens its thread in the dock. That round
   * trip — see a mark, read what was said about it — is the product.
   *
   * In `add` this is, and the order of the checks is the whole point.
   * Reading beats composing, so a pin click leaves `add` and opens the thread —
   * UNLESS the composer is holding typed words, in which case nothing happens
   * except one pulse. Losing a half-written comment to a mis-aimed click is the
   * dead end the design study found in its own winning design.
   */
  /**
   * The v0.1 cascade extension: `snag.anchor-ext.js` is
   * fetched ON FALL-THROUGH, once — the first record the resident steps
   * (testid, domid, css) cannot place, whose facets one of the extended steps
   * could actually use. A happy-path session never fetches it (P8's
   * spirit at v0.1), a session with one orphan pays one fetch, and when the
   * chunk cannot arrive the honest orphan already on screen simply stands —
   * the loader's typed `unavailable` needs no notice here because nothing was
   * promised.
   */
  let extResolver: import("../anchor/resolve.ts").ExtendedResolver | null = null;
  let extMod: typeof import("../anchor/ext.ts") | null = null;
  let extRequested = false;
  let extFailed = false;
  let fuzzyFailed = false;
  let fuzzyEngine: import("../anchor/fuzzy.ts").FuzzyEngine | null = null;
  let fuzzyRequested = false;
  // The FUZZY rung: fetched on the first still-orphaned pin whose
  // record carries a searchable quote; the engine owns the budgets and
  // the guards, and every settle triggers one repaint. When the chunk
  // cannot arrive, the honest orphan stands — the resident-core rule.
  // (Narrative ABOVE the literal: esbuild ships comments that lead an
  // object-literal property, and verify-dist counts the bytes.)
  const extHook = {
    get: () => extResolver,
    unavailable: () => extFailed || fuzzyFailed,
    newPass: () => extMod?.createPassCaches(),
    fuzzyHit: (id: string) => fuzzyEngine?.hit(id) ?? null,
    wantFuzzy: (id: string, rec: import("../anchor/types.ts").AnchorRecord): void => {
      if (fuzzyEngine) {
        fuzzyEngine.enqueue(id, rec, () => paint());
        return;
      }
      // The deps come from the EXT module: fuzzy is the rung BELOW the
      // extended steps, so ext is loaded by construction before this fires —
      // and its bundled scorers are lazy bytes already paid for, where a
      // runtime copy would be eager envelope.
      if (fuzzyRequested || !extMod || !rec.text?.exact || rec.text.exact.length < 8) return;
      fuzzyRequested = true;
      void loadChunk<typeof import("../anchor/fuzzy.ts")>("anchor-fuzzy", assetBase, doc).then((r) => {
        if (!r.ok || !extMod) {
          fuzzyFailed = true;
          paint();
          return;
        }
        fuzzyEngine = r.mod.createFuzzyEngine(doc, extMod.fuzzyDeps);
        void refresh(); // the orphans re-enter reanchor, which enqueues them now
      });
    },
    want: (rec: import("../anchor/types.ts").AnchorRecord): void => {
      if (extRequested) return;
      // Only facets an extended step reads justify the fetch: aria needs
      // role+name, text-exact needs the quote, path-rect needs the path.
      // domid resolves RESIDENT, so it is not a trigger.
      if (!(rec.role && rec.accessibleName) && !rec.text?.exact && !rec.path?.length) return;
      extRequested = true;
      void loadChunk<typeof import("../anchor/ext.ts")>("anchor-ext", assetBase, doc).then((r) => {
        if (!r.ok) {
          // Nothing further is coming: the retry window shortens and settles
          // carry budget-exceeded. One more paint applies that.
          extFailed = true;
          paint();
          return;
        }
        extMod = r.mod;
        extResolver = r.mod.resolveExtended;
        void refresh(); // one more pass, now with steps 4–6
      });
    },
  };

  /** The >6 case: the dock opens filtered to the cluster's members. */
  let clusterIds: string[] | null = null;

  /**
   * The round's ListFilter — owned HERE because its first
   * four fields govern the pins, and pins outlive the dock chunk. Never
   * persisted: defers persistence .6 registers a
   * key, and the design forbids inventing one.
   */
  let filter: ListFilter = defaultFilter();
  /** Do the current facets touch the PINS at all? (the split.) */
  const pinFacetsActive = (): boolean =>
    filter.statuses.length > 0 || !!filter.by || !!filter.page || filter.read !== "all";

  const pins: PinLayer = createPinLayer(
    root,
    (s) => {
      if (state === "add") {
        if (composer?.hasText()) {
          composer.pulse();
          return;
        }
        composer?.close();
        composer = null;
        setState("comments");
      }
      void openPanel(s.id);
    },
    extHook,
    (ids) => {
      clusterIds = ids;
      if (dock) dock.update(dockProps());
      else void openPanel();
    },
  );

  /**
   * Mode persists across reloads and SPA navigation, in sessionStorage under the
   * registered `snag:mode` key. A reviewer part-way through a round who follows
   * a link and lands back in `browse` has to re-enter review mode on every page
   * — the tool would feel like it keeps forgetting what they are doing.
   * sessionStorage, not local: it should not outlive the tab.
   *
   * `add` is deliberately NOT restored: resuming into a shielded page with a
   * crosshair, with no memory of asking for it, is disorienting.
   */
  const readMode = (): PointerMode => {
    try {
      const v = sessionStorage.getItem(storageKey.mode);
      return v === "comments" ? "comments" : "browse";
    } catch {
      return "browse";
    }
  };
  let state: PointerMode = readMode();

  // Declared before the toolbar: setState() closes over it, and construction
  // order should make that obviously safe rather than incidentally safe.
  let composer: ComposerHandle | null = null;
  let dock: DockHandle | null = null;
  /** The snag the dock's detail view is showing; null means the list. */
  let openId: string | null = null;
  /** Intent, tracked separately from `dock` because mounting it is async. */
  let panelWanted = false;

  /**
   * Load the Preact panels chunk on first use. A reviewer who only browses never
   * downloads a UI framework — that is the whole reason for the chunk split.
   * The URL is resolved at runtime from the asset base, exactly like the stub
   * reaches the runtime, so the boundary stays a real network boundary.
   */
  let panelsChunk: Promise<typeof import("../panels/index.ts")> | null = null;
  let panelsDead = false;
  /** The resolved module, for the paths that must stay SYNCHRONOUS — a row
   *  click cannot await a chunk it demonstrably already has. */
  let panelsMod: typeof import("../panels/index.ts") | null = null;
  let dockMod: typeof import("../dock/index.ts") | null = null;

  /** Bumped per attempt, so every import gets a URL the module map has not seen. */

  /**
   * The capture chunk — the T0 snapshot and the redaction rules.
   *
   * Lazy, and that is what keeps it out of the activation
   * envelope: the sum the design makes normative is the EAGER chunks, and a reviewer
   * who activates and only reads a round never downloads a redaction rule.
   * Preloaded on entering `add` alongside panels, so a pick never waits.
   */
  let captureChunk: Promise<typeof import("../capture/index.ts")> | null = null;
  let captureMod: typeof import("../capture/index.ts") | null = null;
  let captureDead = false;
  let captureAttempt = 0;

  /**
   * The same cache-buster the panels chunk needs, for the same reason.
   *
   * A REJECTED dynamic import is recorded in the browser's module map against
   * its URL, so re-importing the identical href replays the rejection without
   * touching the network. Capture had no counter at all: one CDN blip and the
   * chunk could never load again for the life of the page — the Retry button
   * re-imported the same URL, hit the cached rejection, and died again with no
   * request made. R5 asks for one retry after 1 s with `&r=1`, and a
   * later user-initiated Retry needs `?r=2` or it replays its own.
   */
  function loadCapture(): Promise<typeof import("../capture/index.ts") | null> {
    if (captureMod) return Promise.resolve(captureMod);
    if (captureDead) return Promise.resolve(null);
    // Transport is the loadChunk — the ?cv, the varied-URL retry and the
    // module-map-poisoning defence live there now, once, for every lazy
    // artefact. This wrapper keeps what is CAPTURE'S alone: the memo, the
    // one-capability degrade and the Retry that re-arms it.
    const base = assetBase;
    return loadChunk<typeof import("../capture/index.ts")>("capture", base, doc).then((r) => {
      if (r.ok) {
        // Wire the blob port the moment the chunk that carries it lands.
        blobPort.put = r.mod.putBlob;
        blobPort.del = r.mod.deleteBlob;
        return (captureMod = r.mod);
      }
      degradeCapture(new Error("chunk unavailable"));
      return null;
    });
  }

  /**
   * Capture is not coming — and that is ONE capability, not two.
   *
   * The design is explicit that each lazy-chunk failure "degrades exactly one
   * capability". This used to call `degrade()`, the PANELS handler, which set
   * `panelsDead` — so a capture 404 with the panel chunk sitting resolved in
   * memory killed the dock too: clicking a pin or the panel button did nothing
   * at all, no dock, no thread, not even a second notice, while the reviewer
   * read a message about the comment UI that had loaded perfectly.
   *
   * What actually goes: creating a comment, because there is no T0 snapshot and
   * no gated label without it, the add-mode chrome that ships in the
   * same chunk, and export. What stays: every pin, the toolbar, the dock, the
   * threads, replies and status changes.
   */
  function degradeCapture(err: unknown): void {
    if (captureDead) return;
    captureDead = true;
    // The shield must come DOWN: "the page is never left with a shield
    // up" — and add mode is exactly the thing that no longer works.
    if (state === "add") setState("comments");
    toolbar.setDegraded(true);
    notice.show("error.capture", {
      label: "action.retry",
      run: () => {
        captureDead = false;
        toolbar.setDegraded(false);
        void loadCapture();
      },
    });
    console.warn(`[${PRODUCT}] the capture chunk failed to load`, err);
  }

  let panelsAttempt = 0;
  function importPanels(): Promise<typeof import("../panels/index.ts")> {
    // The base is resolved against the document FIRST: `new URL(x, "/widget/")`
    // throws, because a URL base must be absolute. The `?r=N` counter is the
    // module-map defence (R5): a rejected import is replayed from
    // cache at the same href, so every retry needs a fresh URL — and the
    // counter is monotonic so a user-initiated Retry after the automatic one
    // gets ?r=2, not a replay of ?r=1's own cached rejection. Safe because
    // chunks are self-contained: nothing bakes a specifier to this URL.
    const base = new URL(assetBase, doc.location.href).href;
    const url = new URL(ARTIFACT.panels, base);
    url.searchParams.set("cv", VERSION);
    if (panelsAttempt > 0) url.searchParams.set("r", String(panelsAttempt));
    panelsAttempt++;
    return import(/* @vite-ignore */ url.href) as Promise<typeof import("../panels/index.ts")>;
  }

  /**
   * Load the panels chunk, with ONE automatic retry, and degrade rather than
   * strand (F-04).
   *
   * Every caller used to `await` a fresh unguarded import and every call site
   * discarded the promise with `void`, so a blocked chunk produced an unhandled
   * rejection and nothing else: the reviewer clicked, nothing happened, the
   * shield stayed up, and every subsequent click repeated it. Silence is the
   * one thing a failure here must not be.
   */
  async function panels(): Promise<typeof import("../panels/index.ts") | null> {
    if (panelsDead) return null;
    if (panelsChunk) return panelsChunk.catch(() => null);

    panelsChunk = importPanels().catch(async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return importPanels();
    });

    try {
      return (panelsMod = await panelsChunk);
    } catch (err) {
      panelsChunk = null;
      degrade(err);
      return null;
    }
  }

  /**
   * The comment UI is not coming. Everything the runtime chunk owns keeps
   * working — pins render and reposition, the toolbar switches states — and the
   * reviewer is told, once, what failed and what still works.
   */
  function degrade(err: unknown): void {
    panelsDead = true;
    // The shield must come DOWN.: "the page is never left with a shield
    // up" — which is what makes the last clause, that the host page's own
    // click handlers fire normally afterwards, true rather than aspirational.
    if (state === "add") setState("comments");
    toolbar.setDegraded(true);
    notice.show("error.panels", {
      label: "action.retry",
      // A user-initiated retry, on top of the one automatic attempt. It starts
      // from scratch: a fresh module URL, and the degraded flags cleared.
      run: () => {
        panelsDead = false;
        toolbar.setDegraded(false);
        void openPanel(openId);
      },
    });
    // The detail — the URL, the error — goes to the console, never into the
    // copy a reviewer reads (the global rules).
    console.warn(`[${PRODUCT}] the panels chunk failed to load`, err);
  }

  const coarse = doc.defaultView?.matchMedia?.("(pointer: coarse)").matches ?? false;
  /**
   * Add mode's chrome, built when the capture chunk arrives.
   *
   * It ships there rather than here because F-04 makes `add` unreachable
   * without the panels chunk, so a reviewer who only reads a round never needs
   * it — see capture/highlight.ts. Entering `add` already preloads capture, so
   * on any warm cache the chrome is up in the same frame as the mode; the one
   * observable difference is a cold first activation, where the shield is
   * already live and a click that lands early still opens a composer, because
   * `pick()` awaits the same chunk.
   */
  let chrome: import("../capture/highlight.ts").AddChrome | null = null;

  async function ensureChrome(): Promise<void> {
    if (chrome) return;
    const cap = await loadCapture();
    if (!cap || chrome) return;
    // The chrome carries the virtual cursor: `setActive` already fires
    // on every mode change, so the cursor needs no second handle here.
    chrome = cap.createAddChrome(root, coarse, {
      pick: (el, point) => void pick(el, point),
      announce,
    });
    // The mode may have changed while the chunk was in flight — in either
    // direction. Adopt whatever is true now rather than what was true at the
    // call, or leaving `add` before it lands leaves a hint pill on the page.
    chrome.setActive(state === "add");
  }
  /**
   * The CHROME layer — the fixed wrapper, holding toolbar,
   * sheets and notices, glued to the VISUAL viewport under pinch-zoom and
   * URL-bar collapse. Pins stay OUTSIDE in layout coordinates (the
   * split — see vv.ts's header for the deviation record). z-index sits
   * at the dock's rung: everything inside is above pins/chip/shield, and the
   * children's own z-indexes keep their relative order within.
   */
  const chromeEl = doc.createElement("div");
  chromeEl.style.cssText = `position:fixed;left:0;top:0;pointer-events:none;z-index:${LAYER.dock}`;
  root.appendChild(chromeEl);
  // Past 1.2× the toolbar collapses to a single 44 px puck.
  const unglue = glueChrome(win, chromeEl, (scale) => toolbar.setPuck(scale > 1.2));

  const notice: Notice = createNotice(root, chromeEl);
  const paused: PausedNotice = createPausedNotice(root, chromeEl);

  const pointer: PointerController = createPointerController(root, {
    onPick: (el, point) => void pick(el, point),
    onHover: (el) => (el ? chrome?.show(el) : chrome?.clear()),
    // A selection has BEGUN on the host page in `comments`. This is the
    // load trigger and nothing else — the watcher inside the chunk does its own
    // `selectionchange` listening once it exists. Firing on every selectstart
    // is fine: `ensureSelect` is idempotent and returns the cached watcher.
    // Not on a coarse pointer: there is no chip to draw there, so the
    // chunk is never fetched — which is also the one good thing about the
    // capitulation, since it is bytes a phone no longer spends.
    onSelectStart: () => {
      if (!coarse) void ensureSelect();
    },
  });

  /** A pick opens the composer. The snag is created only when it is SENT — an
   *  abandoned composer must leave no trace on the page or in storage. */
  async function pick(el: Element, point: { x: number; y: number }): Promise<void> {
    // 'S RULE, WHICH THE PIN PATH ALREADY HAD AND THIS ONE DID NOT.
    // "Losing a half-written comment to a mis-aimed click is the dead end the
    // design study found in its own winning design" — and in add mode the
    // shield routes EVERY click here, so a mis-aimed one landed on a new
    // element, closed the composer holding typed words, and opened an empty one
    // in its place. The words vanished from the screen; the draft survived in
    // storage but the replacement composer knew nothing about it, so its first
    // Cancel — one press, because an empty composer does not arm — deleted the
    // route's draft as well.
    //
    // An EMPTY composer is re-aimed freely, which is what a real mis-pick is.
    if (composer?.hasText()) {
      composer.pulse();
      return;
    }
    composer?.close();

    const [mod, cap] = await Promise.all([panels(), loadCapture()]);
    if (!mod || !cap) return; // degraded — degrade() has already dropped the shield

    /**
     * T0. The snapshot describes the page AT THE CLICK, not at Send
     *
     * Not a detail. Between pointing at something and finishing the sentence
     * about it, a reviewer can scroll, resize, rotate a phone or follow a
     * client-side route change — and a viewport recorded at Send describes a
     * page nobody was looking at, which makes "it breaks at this width"
     * unfalsifiable.
     *
     * It sits after the `await` because capture ships with the panels chunk
     * (see panels/index.ts), and that await is why `setState` PRELOADS the
     * chunk on entering `add`: by the time somebody has aimed and clicked it is
     * already resolved, so this is one microtask after the gesture rather than
     * one network round trip. The residual — a click landing before a slow
     * first load completes — is a window in which nothing has scrolled.
     *
     * Held in a local, so an abandoned composer drops it with the closure and
     * leaves no trace anywhere (plan task 40).
     */
    const context: CaptureContext = cap.captureContext({
      page: cap.derivePageRef(doc.location, pageOpts()),
      ...crumbSnapshot(),
    });
    startShot(el);

    // The text-quoting derivation, gated by isSensitiveValue and the masking
    // selectors. The runtime's own fallback names the tag and reads no text.
    const label = cap.deriveAnchorLabel(el);
    openComposerFor(mod, el, point, context, label, cap);
  }

  /**
   * The composer itself, given everything it needs — shared by the click path
   * and by F-12's restore, because a restored composer that behaves differently
   * from a fresh one is two composers.
   */
  function openComposerFor(
    mod: NonNullable<Awaited<ReturnType<typeof panels>>>,
    el: Element,
    point: { x: number; y: number },
    context: CaptureContext,
    label: string,
    capture: NonNullable<Awaited<ReturnType<typeof loadCapture>>>,
    draft?: { body: string; author: string; email?: string },
    /**
     * A PRE-BUILT record: the text path assembles its anchor from the
     * Selection before the composer exists, and the element path derives one
     * here — both persist and send exactly one record.
     */
    textAnchor?: import("../anchor/types.ts").AnchorRecord,
  ): void {
    // The pick the steppers may re-aim; the opt-in resets
    // composer — one comment's consent is not the next's.
    let target = el;
    shotWanted = false;
    const route = routeOf(doc);
    // The anchor is recorded ONCE, here, so the draft persists the same record
    // the send would have used rather than a second one derived later.
    quotaTold = false;
    const done = (): void => {
      composer = null;
      clearDraft(route);
      toolbar.setDraft(anyDraft());
      setState("comments"); // also re-shows the toolbar (the scrim rule)
    };
    const cancelled = (): void => {
      shotAbort?.abort();
      pendingShot = shotAbort = null;
      done();
    };
    // Looking at a CLOSED round, which takes no new comments. The
    // composer says where this one goes instead — the newest open round, the
    // first open one in the config's newest-first list — and the send moves
    // the view there, so the comment does not vanish from the list it was
    // posted from.
    const viewing = roundInfo?.find((r) => r.number === storage.getRound?.());
    const landing = viewing?.closed ? roundInfo!.find((r) => !r.closed) : undefined;
    const props: ComposerProps = {
      at: point,
      label,
      ...(draft
        ? {
            initialBody: draft.body,
            initialName: draft.author,
            ...(draft.email ? { initialEmail: draft.email } : {}),
          }
        : {}),
      onDraft: (text, author, email) => {
        const saved = saveDraft({
          route,
          body: text,
          author,
          ...(email ? { email } : {}),
          label,
          // The SAME record `add()` would write, selector injection included.
          // Without `describeElement` the draft carries an anchor with neither
          // a testid nor a css selector, which the v0 cascade cannot resolve —
          // so it saved perfectly and reopened against nothing. A text pick's
          // record is already built (from the Selection, which no longer
          // exists by restore time) and persists as-is.
          anchor:
            textAnchor ??
            capture.createElementAnchor(el, {
              point,
              viewportWidth: win.innerWidth,
              label,
              ...capture.describeElement(el),
            }),
          at: { x: point.x + win.scrollX, y: point.y + win.scrollY },
          savedAt: new Date().toISOString(),
        });
        toolbar.setDraft(anyDraft());
        // F-02, for the draft path. Said ONCE per composer — the hook
        // runs on every keystroke, and a notice that re-shows four hundred
        // times is a notice nobody can dismiss.
        if (!saved && !quotaTold) {
          quotaTold = true;
          outOfRoom();
        }
      },
      onSend: (text, author, email) => {
        done();
        if (landing) storage.setRound!(landing.number);
        void add(target, point, context, text, author, email, textAnchor).then(() => landing && refresh());
      },
      // ▲/▼ — the [ / ] primitive's touch face. The pick is
      // re-aimed BEFORE send, so the anchor derives from where it lands.
      onRetarget: (dir: "up" | "down") => {
        const next = dir === "up" ? capture.widen(target) : capture.narrow(target);
        if (!next) return;
        target = next;
        chrome?.show(next);
        composer?.setLabel(capture.deriveAnchorLabel(next));
      },
      // Mobile screenshots are OPT-IN per comment — off by default.
      ...(coarseUI && scConfig !== false ? { onShotOptIn: (w: boolean) => (shotWanted = w) } : {}),
      onCancel: cancelled,
      // The one-time disclosure names the categories that are ON;
      // configured truth, not chunk-arrival truth — a slow network must not
      // make the disclosure claim less than the project captures.
      crumbsOn: bcConfig !== false,
      shotsOn: scConfig !== false,
      // Which retention sentence the disclosure shows. Derived from the SAME
      // value that chose the adapter, so the notice and the destination can
      // never disagree: a local install says "stays in this browser", a
      // server-backed one names the host it sends to.
      ...(apiHost && uid !== "local" ? { serverHost: new URL(apiHost).host } : {}),
      // "Studio member? Sign in" — offered wherever the adapter can hold
      // a member's session, which is exactly the server-backed one. The popup
      // is the panels chunk's; this is only the adapter's three hooks.
      ...(apiHost && storage.adoptSession
        ? {
            studio: {
              host: apiHost,
              uid,
              env: ctx?.config?.env,
              member: storage.member!(),
              adopt: (b) => storage.adoptSession!(b),
              signOut: () => storage.signOut!(),
            },
          }
        : {}),
      // The quoted words above the textarea, so the reviewer
      // can see what the comment will hang on.
      ...(textAnchor?.text?.exact ? { quote: textAnchor.text.exact } : {}),
      ...(landing ? { roundNote: landing.name } : {}),
    };
    composer = mod.openComposer(root, props, chromeEl);
    syncToolbarHidden();
  }

  /**
   * F-12 — put the words back (v0).
   *
   * Runs on activation, after the round has been re-anchored, because the draft
   * points at an element and the DOM has to be there to point at. If the element
   * is gone the draft is NOT discarded: it stays in storage and the `✎` stays on
   * the `+` control, because a comment somebody wrote is worth more than the tidy
   * feeling of an empty key. What is dropped is the silent reopening.
   *
   * The CaptureContext is taken FRESH here rather than restored — see draft.ts.
   * The page that the old T0 described no longer exists.
   */
  async function restoreDraft(): Promise<void> {
    const route = routeOf(doc);
    const d: Draft | null = readDraft(route);
    toolbar.setDraft(anyDraft());
    if (!d || composer) return;

    const [mod, cap] = await Promise.all([panels(), loadCapture()]);
    if (!mod || !cap) return; // degraded — the notice is already up

    const res = resolveAnchor(d.anchor, doc, {
      viewportWidth: win.innerWidth,
      ...(extResolver ? { extended: extResolver } : {}),
    });
    if (!res.element) return;

    const r = res.element.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return; // hidden — nothing to open beside
    const point = { x: d.at.x - win.scrollX, y: d.at.y - win.scrollY };
    setState("add");
    openComposerFor(
      mod,
      res.element,
      point,
      cap.captureContext({ page: cap.derivePageRef(doc.location, pageOpts()), ...crumbSnapshot() }),
      d.label,
      cap,
      { body: d.body, author: d.author, ...(d.email ? { email: d.email } : {}) },
    );
  }

  /**
   * Open the dock, optionally straight into one snag's thread.
   *
   * Opening PROMOTES the state out of `browse` — a list of comments beside a
   * page showing none of them is a dead end, and the two surfaces disagreeing
   * about whether there is anything here is worse than either alone.
   */
  /**
   * The last new thread read: the "new only" view has nothing left to show,
   * so it lets go by itself and the whole list comes back (Pastel clears it
   * the same way) — rather than a "you're caught up" row over an empty list.
   */
  function settleNew(): void {
    if (filter.newOnly && !all.some((s) => isUnread(s, seen.map()))) filter = { ...filter, newOnly: false };
  }

  async function openPanel(id: string | null = null): Promise<void> {
    if (id && id !== openId) emit("thread:open", { threadId: id });
    // Level one: reading a thread clears ITS dot and decrements the
    // count, so triage carries on in place with the rest of the dots intact.
    if (id) {
      seen.mark(id);
      settleNew();
    }
    openId = id;
    panelWanted = true;
    if (state === "browse") setState("comments");
    if (dock) {
      dock.update(dockProps());
      return;
    }
    const mod = await panels();
    if (!mod) return; // degraded — the notice explains it
    /**
     * The dock is its own lazy artefact (the funded lever): 40% of
     * the panels chunk opened on demand, so it did not belong in the
     * activation envelope. The panels chunk must be live FIRST — the dock
     * imports Preact from it cross-chunk — which the await above
     * guarantees.
     */
    const dockRes = await loadChunk<typeof import("../dock/index.ts")>(
      "dock",
      assetBase,
      doc,
    );
    if (!dockRes.ok) {
      // One capability degrades: the list. Pins, composer and export live on.
      notice.show("error.panels", { label: "action.retry", run: () => void openPanel(openId) });
      return;
    }
    // The panel button may have been clicked again — or the dock closed — while
    // the chunk was in flight. Mount only if it is still wanted, or a close
    // that happened mid-fetch reopens itself a moment later.
    if (!panelWanted || dock) return;
    dockMod = dockRes.mod;
    dock = dockRes.mod.openDock(root, dockProps(), chromeEl);
    syncToolbarHidden();
  }

  function closePanel(): void {
    // Level two: closing marks EVERYTHING seen and clears the new-only
    // filter. Level one without this gives a counter that never empties; this
    // without level one blanks the list on the first thread you read.
    seen.markAll(all);
    if (filter.newOnly) filter = { ...filter, newOnly: false };
    panelWanted = false;
    dock?.close();
    dock = null;
    openId = null;
    pins.highlight(null);
    syncToolbarHidden();
    // The teardown half: the exemption dies with the detail, and
    // only a repaint makes that true on the page.
    if (pinFacetsActive()) paint();
  }

  /**
   * Open a thread — leaving this page for its own if that is where it lives.
   *
   * Records the opposite rule, and records why: draft 4 navigated on a
   * row click and the design study called it "the design's single worst
   * disorientation", because a client reading a round does not expect the page
   * to move under them. Real use of the studio side reversed it. Working a round
   * IS moving between pages, the list is now the only view of the whole round,
   * and a detail you cannot get to the page of is a dead end — which is the same
   * complaint that made the list span every page in the first place.
   *
   * Both halves .5's mechanism are kept: the handoff is written before the
   * navigation, and the row says where it goes before it is clicked.
   */
  function openThread(id: string | null): void {
    const target = id ? all.find((s) => s.id === id) : undefined;
    if (target && target.route !== routeOf(doc)) {
      // BEFORE the navigation, never after — the design is explicit, because the
      // load starts the moment the location is assigned.
      writeHandoff(win, target.id);
      win.location.assign(target.route);
      return;
    }
    // Level one — and it belongs HERE as well as in openPanel,
    // because this is the path a row click takes. Marking only in openPanel
    // meant the dot survived reading the thread, which is the one thing a dot
    // is for.
    if (id) {
      seen.mark(id);
      settleNew();
    }
    openId = id;
    pins.highlight(null);
    // The exemption follows the OPEN detail — an openId change under an
    // active pin filter must reach the page, both ways (grant and teardown).
    if (pinFacetsActive()) paint();
    else dock?.update(dockProps());
    // Scroll AFTER the repaint, so the strip is measured against the dock the
    // reviewer is about to be looking at rather than the one it replaced. Only
    // a dock row reaches here, so the chunk is loaded by construction.
    if (target) dockMod?.scrollToSnag(win, root, target);
  }

  function dockProps(): DockProps {
    return {
      // The WHOLE round, unordered. The design makes "show comments on this page
      // only" a CHECKBOX that narrows the list (v0.1), so every page is the
      // default and page scope is the exception — built the other way round, a
      // week of review across three routes was invisible from any one of them.
      // Ordering is the dock's, because it groups by page and the design requires
      // prev/next to walk exactly the order the list is showing.
      snags: all,
      route: routeOf(doc),
      openId,
      seenAt: seen.map(),
      onOpen: openThread,
      onStatus: (id, status) => void setStatus(id, status),
      onReply: (id, body, name) => void reply(id, body, name),
      onEdit: (commentId, body) => void editComment(commentId, body),
      onDeleteComment: (commentId) => void deleteComment(commentId),
      onDeleteThread: (id) => void deleteThread(id),
      ...(storage.isMine ? { isMine: (a) => storage.isMine!(a) } : {}),
      // The hooks again, for the reply box — the same three the composer
      // is handed, so "who is writing" is asked the same way in both.
      ...(apiHost && storage.adoptSession
        ? {
            studio: {
              host: apiHost,
              uid,
              env: ctx?.config?.env,
              member: storage.member!(),
              adopt: (b: import("../storage/types.ts").MemberSession) => storage.adoptSession!(b),
              signOut: () => storage.signOut!(),
            },
          }
        : {}),
      canDeleteOwnThread: storage.can ? storage.can("thread:delete:own") : true,
      // Asked per paint, so a refresh that changed a guest's set (the
      // site's setting moved) shows on the next repaint.
      canStatus: storage.can ? storage.can("thread:resolve") : true,
      canModerate: storage.canModerate?.() ?? false,
      // In the widget: everyone sees who holds a snag; a session with
      // `thread:assign` (a signed-in member, a team link) may change it.
      ...(storage.listAssignees && storage.can?.("thread:assign")
        ? { assignees: () => storage.listAssignees!(), onAssign: (id, who) => void setAssignee(id, who) }
        : {}),
      onClearAll: () => void clearAll(),
      onMarkAllRead: () => {
        seen.markAll(all);
        filter = { ...filter, newOnly: false };
        paint();
      },
      onClose: closePanel,
      // Export only where there is no server to read the comments from.
      ...(storage.kind === "local" ? { onExport: exportAs } : {}),
      onHover: (id) => pins.highlight(id),
      // T10/: one round visible at a time. The selector shows only when
      // the adapter can switch (local cannot) and there is a choice to make.
      ...(roundInfo && roundInfo.length > 1 && storage.setRound
        ? {
            rounds: roundInfo,
            activeRound:
              storage.getRound?.() ?? roundInfo.find((r) => !r.closed)?.number ?? roundInfo[0]!.number,
            onRound: (n: number) => {
              storage.setRound!(n);
              void refresh();
            },
          }
        : {}),
      // The status announcement — the dock renders the sentence (it owns
      // the surface where status changes); the runtime owns the live region.
      onAnnounce: announce,
      // The dock paints the thumbnail; the store handle is
      // ours, and only exists once the capture chunk has landed. The REF
      // decides where the bytes live (storage/shots.ts): a server-held
      // picture is fetched from the instance, a local one read from the
      // store — and the capture chunk is only loaded for the latter.
      loadShot: (att) =>
        loadShotBlob(att, async (id) => {
          const cap = await loadCapture();
          return cap ? ((await cap.getBlob(id))?.blob ?? null) : null;
        }),
      // The filter and its one mutation path. Pins repaint
      // only when the PIN-governing quartet changes — asserts that
      // typing in search leaves the pin layer byte-identical, and the
      // cheapest way to be byte-identical is to not touch it.
      filter,
      onFilter: (next: ListFilter) => {
        const pinsChanged =
          next.statuses.join() !== filter.statuses.join() ||
          next.by !== filter.by ||
          next.page !== filter.page ||
          next.read !== filter.read;
        filter = next;
        if (pinsChanged) paint();
        else dock?.update(dockProps());
      },
      // A >6 cluster opens the list filtered to itself;
      // "Show all" is the way back, and any repaint keeps the filter until
      // then — a filter that silently fell off mid-review would read as
      // comments vanishing.
      ...(clusterIds ? { clusterFilter: clusterIds } : {}),
      onClusterClear: () => {
        clusterIds = null;
        dock?.update(dockProps());
      },
      // The hidden-anchor override — scroll to the recorded
      // document coordinates, then draw the ghost there.
      onShowAnyway: (s) => {
        pins.showGhost(s);
        dockMod?.scrollToSnag(win, root, s);
      },
    };
  }

  /**
   * Editing and deleting — the `⋯` overflow, and the footer.
   *
   * The adapter has implemented `patchComment`, `deleteComment` and
   * `deleteThread` since the day it was written, with tests, and nothing ever
   * called them. So a client who typo'd could not fix it, and a studio finishing
   * round one had no way to start round two short of devtools. All four follow
   * the same shape as every other mutation here: memory and screen first, the
   * write second, through guard().
   */
  /**
   * ── OPTIMISTIC, BUT NOT CREDULOUS ──
   *
   * These three applied the change to memory, painted, and then wrote — and
   * every caller invokes them through a floating `void`, so a rejected write
   * became an unhandled promise rejection and the screen kept the change.
   *
   * Measured: a reviewer editing somebody ELSE's comment got `403 Forbidden`
   * from the server and watched their edit appear anyway. It survived until
   * the next refresh, which on a page nobody reloads is "until they close the
   * tab". Worse than the `501` this replaced, because that at least failed
   * visibly.
   *
   * So: snapshot, apply, write, and on failure put it back and SAY SO.
   * `error.sendfailed` is already written for exactly this — "that {item}
   * couldn't be sent, so it wasn't kept" — and it was reachable from nowhere.
   */
  async function optimistic(next: Snag[], write: () => Promise<unknown>): Promise<void> {
    const before = all;
    all = next;
    paint();
    try {
      await guard(write);
    } catch {
      // The rollback is the honest half. A notice beside a change that is
      // still on screen tells the reviewer their edit both failed and worked.
      // `params` is the THIRD argument: the second is an action button, and
      // putting the substitutions there renders "that {item}" verbatim.
      all = before;
      paint();
      // One word for every caller. "change" is true of an edit, a deletion, a
      // removed thread, a status and an assignee, and a literal per caller for
      // one sentence is that many literals in a chunk with a byte budget.
      notice.show("error.sendfailed", undefined, { item: "change" });
    }
  }

  async function editComment(commentId: string, body: string): Promise<void> {
    await optimistic(
      all.map((s) => ({
        ...s,
        comments: s.comments.map((c) => (c.id === commentId ? { ...c, body } : c)),
      })),
      () => storage.patchComment(commentId, body),
    );
  }

  async function deleteComment(commentId: string): Promise<void> {
    await optimistic(
      all.map((s) => ({ ...s, comments: s.comments.filter((c) => c.id !== commentId) })),
      () => storage.deleteComment(commentId),
    );
  }

  /**
   * Deleting the thread takes the PIN with it, which is why the control that
   * does it is worded as "this comment and its pin" and armed before it fires.
   */
  async function deleteThread(id: string): Promise<void> {
    const wasOpen = openId;
    // The detail showing it is gone; go back to the list rather than to a blank
    // panel rendered from an id that no longer resolves.
    if (openId === id) openId = null;
    await optimistic(all.filter((s) => s.id !== id), () => storage.deleteThread(id));
    // `optimistic` restores `all` on failure; the open panel is this
    // function's own state and has to come back with it, or a failed delete
    // leaves the reviewer looking at a list they did not ask for. Checked
    // rather than wrapped in try/finally — `optimistic` does not rethrow, so
    // the only signal is whether the thread is back.
    if (all.some((s) => s.id === id)) openId = wasOpen;
  }

  async function clearAll(): Promise<void> {
    const ids = all.map((s) => s.id);
    all = [];
    openId = null;
    paint();
    await Promise.all(ids.map((id) => guard(() => storage.deleteThread(id))));
  }

  const toolbar: Toolbar = createToolbar(root, {
    onState: (next) => setState(next),
    onPanel: () => (dock ? closePanel() : void openPanel()),
    onNav: (dir) => nav(dir),
    parent: chromeEl,
  });

  /**
   * "While either scrim is up the toolbar hides." A scrim is up
   * exactly while a sheet is open on a coarse pointer, so this is derived
   * state, not a callback — and hiding republishes `--snag-tb-h`, so the
   * sheets drop flush to the safe-area inset in the same frame (C7).
   */
  const coarseUI = win.matchMedia?.("(pointer: coarse)").matches ?? false;
  const syncToolbarHidden = (): void => {
    if (coarseUI) toolbar.setConcealed(!!composer || !!dock);
  };

  /**
   * The pin navigator — ▲▼ in the toolbar, `n`/`p` on the
   * keys, cycling the pins ON THIS PAGE in pin-number order. ADJUDICATION:
   * the plan says "pins in the round", but a cross-route step from the
   * toolbar is a page navigation — that behaviour belongs to the dock walker
   * which names the rule; a toolbar control that navigates the
   * browser on `n` would be the disorientation documents. The dock
   * walker crosses routes; this cycles what is in front of the reviewer.
   */
  let navAt: number | null = null;
  /** The pins the navigator cycles — `visible` minus the filtered-out. */
  let navCycle: Snag[] = [];

  /** `scrollend` where the engine has it; the 600 ms timeout is Safari's. */
  function afterScroll(done: () => void): void {
    let fired = false;
    const finish = (): void => {
      if (!fired) {
        fired = true;
        win.removeEventListener("scrollend", finish);
        done();
      }
    };
    win.addEventListener("scrollend", finish, { once: true });
    win.setTimeout(finish, 600);
  }

  // The polite live region: debounced ≥ 400 ms, REPLACING — a
  // reviewer holding `n` hears where they landed, not the journey.
  const live = doc.createElement("div");
  // ONE polite `role="status"` node, plus ONE assertive node
  // for errors ONLY. Two nodes rather than a flipped attribute: changing
  // `aria-live` on a live node is unreliable across screen readers, and the
  // whole point of the assertive channel is that it interrupts.
  live.setAttribute("aria-live", "polite");
  live.setAttribute("role", "status");
  const LIVE_CSS = "position:absolute;width:1px;height:1px;overflow:hidden";
  live.style.cssText = LIVE_CSS;
  const alarm = doc.createElement("div");
  alarm.setAttribute("aria-live", "assertive");
  alarm.style.cssText = LIVE_CSS;
  root.append(live, alarm);
  let liveTimer = 0;
  /** Debounced ≥400 ms, and moves REPLACE rather than queue. */
  function announce(text: string): void {
    win.clearTimeout(liveTimer);
    liveTimer = win.setTimeout(() => {
      live.textContent = text;
    }, 400);
  }
  /** Errors only — never debounced, never replaced by a polite line. */
  function alert(text: string): void {
    alarm.textContent = text;
  }

  function nav(dir: 1 | -1): void {
    const n = navCycle.length;
    if (n === 0) return;
    navAt = navAt === null ? (dir === 1 ? 0 : n - 1) : (navAt + dir + n) % n;
    const snag = navCycle[navAt]!;
    scrollToSnag(win, root, snag);
    const i = navAt + 1;
    afterScroll(() => {
      pins.pulse(snag.id);
      announce(format("nav.announce", { n: i, label: snag.anchor.label, i, total: n }));
    });
  }

  /**
   * The selection watcher follows the STATE now: armed in
   * `comments`, disarmed everywhere else. There is no sub-mode left to keep
   * three surfaces agreeing about.
   *
   * `browse` must not arm it. The design promises that state renders nothing and
   * behaves exactly as if the widget were absent, and a chip appearing on a
   * selection is the most visible way to break that promise — which is the
   * promise that makes a review link safe to send to anyone.
   */
  function armSelection(): void {
    // NOT on a coarse pointer, and this is a capitulation rather than a
    // simplification. On iOS a text selection is already owned by the OS: it
    // paints its own handles and puts the Copy / Look Up / Share callout
    // directly over the end of the range, which is exactly where the design asks
    // our chip to go. There is no API to move that callout, suppress it, or
    // learn where it landed, so the chip is either underneath it or fighting a
    // handle for the same fingertip. The maintainer, on the device: "we dont need the
    // comment highlight as its not possible."
    //
    // What a touch reviewer keeps is the `+` element pick, which is the whole
    // of the flow they had before text anchors existed. What they lose is
    // quoting a sentence. That is a real loss and it is the right side to lose
    // it on — a half-working chip under a system menu is worse than an absent
    // one, because it teaches the reviewer that the tool is broken.
    if (state !== "comments" || coarse) {
      selectWatch?.disarm();
      return;
    }
    // The re-check after the await is the cold-cache race: the reviewer may
    // have left `comments` before the chunk landed.
    void ensureSelect().then((w) => {
      if (w && state === "comments") w.arm();
    });
  }

  let selectWatch: import("../text/select.ts").SelectionWatcher | null = null;
  let textMod: typeof import("../text/index.ts") | null = null;
  async function ensureSelect(): Promise<import("../text/select.ts").SelectionWatcher | null> {
    if (selectWatch) return selectWatch;
    const r = await loadChunk<typeof import("../text/index.ts")>("text", assetBase, doc);
    if (!r.ok || selectWatch) return selectWatch;
    textMod = r.mod;
    selectWatch = r.mod.createSelectionWatcher(root, {
      onQuote: (sel, at) => void quotePicked(sel, at),
    });
    return selectWatch;
  }

  /** Chip → record → composer: assembled against a live Selection. */
  async function quotePicked(sel: Selection, at: { x: number; y: number }): Promise<void> {
    const cap = captureMod ?? (await loadCapture());
    if (!cap) return; // degraded path already noticed by loadCapture
    // onQuote only fires from the watcher, and the watcher IS this chunk —
    // so the module ref is set by construction. The capture module itself
    // satisfies CaptureDeps structurally; the injection is the whole module.
    if (!textMod) return;
    const made = textMod.createTextAnchor(sel, cap, { viewportWidth: win.innerWidth, ourRoot: root });
    if (made.kind === "refused-form-control") {
      // The edge case: the chip already reads "Can't comment on typed
      // text", so reaching here means a race — fall back to the element pick
      // path on the control, which is the specified degradation.
      void pick(made.el, at);
      return;
    }
    if (made.kind !== "text") return;
    const mod = await panels();
    if (!mod) return;
    const context = cap.captureContext({ page: cap.derivePageRef(doc.location, pageOpts()), ...crumbSnapshot() });
    // The selection has served its purpose; leaving it up under the composer
    // reads as "still picking".
    try {
      sel.removeAllRanges();
    } catch {
      /* cosmetic */
    }
    openComposerFor(mod, made.el, made.point, context, made.label, cap, undefined, made.record);
  }

  function setState(next: PointerMode, keepComposer = false): void {
    const previous = state;
    state = next;
    // On the transition out of `add`, "any open composer closes and
    // the pending selection is discarded". Leaving `add` by the TOOLBAR did
    // neither — the composer host is a separate child of the shadow root, so it
    // stayed mounted and visible while the shield came down and the pins
    // vanished: a form floating over a page that the design requires to render nothing.
    // The composer's own Cancel path already clears the draft; this is the
    // route that bypassed it.
    if (next !== "add" && composer && !keepComposer) {
      composer.close();
      composer = null;
    }
    // The composer sheet and the dock sheet are mutually exclusive
    // BY CONSTRUCTION — entering `add` closes the dock.
    if (next === "add" && dock) closePanel();
    // Entering `add` means a pick is coming, and a pick needs the panels chunk
    // for the composer AND for the T0 snapshot. Warming it here is what keeps
    // that snapshot one microtask behind the click rather than one fetch.
    if (next === "add") {
      void panels();
      void loadCapture();
    }
    try {
      sessionStorage.setItem(storageKey.mode, next === "add" ? "comments" : next);
    } catch {
      /* storage disabled — the widget still works, it just forgets */
    }
    pointer.setMode(next);
    // State changes are announced, in the toolbar's own words.
    // `toolbar.${mode}` is exhaustive by the type — browse/comments/add all
    // exist as keys, which is why the placement test allows this family.
    if (next !== previous) announce(format(`toolbar.${next}`));
    syncToolbarHidden();
    if (next === "add") void ensureChrome();
    // The selection watcher follows the state: armed in `comments`,
    // disarmed in `browse` and in `add`. It is called on EVERY transition,
    // including comments → comments, because it is idempotent and the cost of
    // missing one is a chip that never appears.
    armSelection();
    chrome?.setActive(next === "add");
    toolbar.setState(next);
    paint();
    if (next !== previous) emit("modechange", { mode: next, previous });
  }

  /** The "retried on each subsequent trigger" needs a trigger to exist: a
   *  static page with a missing element mutates nothing, so while any pin
   *  holds pending, ONE timer walks a backoff ladder until every pin settles.
   *  The navigation retry ladder, generalised to every pass. */
  let retryTimer = 0;
  let retryStep = 0;
  const RETRY_LADDER = [300, 800, 1600, 3200];
  function armRetry(): void {
    if (retryTimer || !pins.hasPending()) {
      if (!pins.hasPending()) retryStep = 0;
      return;
    }
    const delay = RETRY_LADDER[Math.min(retryStep++, RETRY_LADDER.length - 1)]!;
    retryTimer = win.setTimeout(() => {
      retryTimer = 0;
      paint();
    }, delay);
  }

  /**
   * How long after a route change a missing element is still assumed to be a
   * slow render rather than a deletion. The phase 2 lands at +600 ms and
   * makes `orphaned` reachable; this is the coverage of "genuinely slow
   * renders after it", expressed as the thing it actually is — a period during
   * which the retry COUNT must not be the bound, because a route render spends
   * it in a burst of repaints before the element exists.
   */
  const NAV_SETTLE_MS = 3000;
  let navSettleUntil = 0;

  function paint(phase?: "optimistic" | "navigating" | "authoritative"): void {
    const effective = phase ?? (Date.now() < navSettleUntil ? "navigating" : "authoritative");
    visible = pins.reanchor(all.filter(pageFilter()), effective);
    warmDock();
    armRetry();
    // Write the re-anchored rects and states back, so the next load starts from
    // the best-known position rather than the original one.
    const byId = new Map(visible.map((s) => [s.id, s]));
    all = all.map((s) => byId.get(s.id) ?? s);
    // `browse` renders NOTHING — pins are absent from the DOM, not hidden by
    // CSS. "Show me the site with nothing on it" has to mean it.
    //
    // The pin-governing facets take pins off the PAGE, with
    // one exemption — the open detail's pin stays regardless, and the
    // teardown is automatic because the set is recomputed from `openId` on
    // every paint (the trap: a teardown someone has to remember is a
    // teardown that gets missed).
    const filteredOut = pinFacetsActive()
      ? new Set(visible.filter((s) => !pinPass(s, filter, seen.map()) && s.id !== openId).map((s) => s.id))
      : undefined;
    navCycle = filteredOut ? visible.filter((s) => !filteredOut.has(s.id)) : visible;
    pins.render(state === "browse" ? [] : visible, filteredOut);

    // The pill reads what was just WRITTEN, not a parallel in-memory tally.
    // Requires the two to be equal, and the cheapest way to guarantee
    // that is to have only one of them: the cache is the source, and the next
    // page load paints its badge from the same key before the runtime exists.
    const route = routeOf(doc);
    const stored = persists ? writeCounts(doc.location.origin, all, route) : null;
    toolbar.setCount(
      stored
        ? badgeFor(stored, route)
        : persists
          ? // Storage works but the count cache specifically did not write —
            // the badge is a nicety, so fall back to the truth we already hold.
            visible.filter((s) => s.status !== "resolved").length
          : // F-01: no pill at all. Not zero — UNKNOWABLE. A number here would
            // be a promise about the next page load that we cannot keep.
            null,
    );
    // The navigator counts the same pins the page shows; a repaint that
    // changed the set drops the cursor rather than pointing at the wrong pin.
    // Nothing draws the position any more — but the cursor still has to
    // be right, because the next `n` announces from it.
    if (navAt !== null && navAt >= navCycle.length) navAt = null;
    // The dock reads from `visible`, so it repaints from the same pass that
    // repainted the pins — the list and the page cannot disagree.
    dock?.update(dockProps());
  }

  async function refresh(): Promise<Snag[]> {
    const { data } = await storage.listThreads();
    all = data;
    paint(); // re-anchors into `all` as it renders
    // and the only v0 window onto cascade quality: one event per pin
    // per REAL resolution pass — load and navigation, not every repaint.
    const settled = pins.settled();
    for (const r of settled) {
      emit("anchor:settled", {
        threadId: r.id,
        state: r.state,
        strategy: r.strategy,
        confidence: r.confidence,
      });
    }

    /**
     * The same settled pass, reported to the server.
     *
     * This is the write that `patchThread({ anchorState })` below was pretending
     * to be. Does not accept `anchor` or `anchorState` in a PATCH body and
     * never has, so against a server that call has been a **silent no-op since
     * the HTTP adapter existed** — the re-anchor result went nowhere, and
     * `anchor_events` sat empty behind three indexes. It worked against the
     * local adapter, which stores whatever it is handed, and that is exactly
     * why it went unnoticed.
     *
     * Reported rather than patched because a report is merged monotonically: a
     * phone whose cascade fails must not orphan a pin for the whole team. Every
     * settled pin is sent, not only the changed ones — "this client still
     * resolves it" is the measurement, and sending only changes would make the
     * data say pins are stable precisely when nobody is looking.
     */
    if (storage.capabilities.anchorReports && storage.reportAnchors && settled.length) {
      void guard(() =>
        storage.reportAnchors!(
          settled.map((r) => ({
            threadId: r.id,
            state: r.state,
            confidence: r.confidence,
            strategy: r.strategy,
          })),
        ),
      );
    }

    // Persist the re-anchor result ONCE per load, and only where it changed.
    // Not per paint: paint runs on every state change and a write per repaint
    // would be absurd. This is the moment that matters — an anchor that has
    // just gone orphaned should still be orphaned after the next reload, and
    // the last rect it resolved to is the fallback position its pin will use.
    //
    // ONLY where the adapter has no report endpoint — which means the local
    // one, whose store takes the state directly. Against a server this call
    // was writing nothing (see above), so leaving it in place would be one
    // wasted request per changed pin in exchange for nothing at all.
    if (!storage.capabilities.anchorReports) {
      await Promise.all(
        data.flatMap((before) => {
          const after = all.find((s) => s.id === before.id);
          if (!after || after.anchorState === before.anchorState) return [];
          return [
            guard(() =>
              storage.patchThread(after.id, { anchor: after.anchor, anchorState: after.anchorState }),
            ),
          ];
        }),
      );
    }
    return visible;
  }

  async function setStatus(id: string, status: Status): Promise<void> {
    // Named `thread:resolve` but fired for EVERY status move (the payload
    // carries the status, which would be pointless if it were only ever
    // "resolved"). A host wiring this to its issue tracker needs the in-progress
    // transitions as much as the final one.
    emit("thread:resolve", { threadId: id, status });
    // Optimistic: the panel repaints from memory immediately, and the write is
    // what may fail. A status flip that waits on storage feels broken — and
    // one that fails must come BACK, with the notice. It used to stay
    // on screen after a refusal, so guests resolved a comment, saw it
    // resolved, and found it open again on the next load.
    await optimistic(
      all.map((s) => (s.id === id ? { ...s, status } : s)),
      () => storage.patchThread(id, { status }),
    );
  }

  /** Optimistic, like the status: the name changes now, the write may fail and roll back. */
  async function setAssignee(id: string, who: import("../storage/types.ts").Reviewer | null): Promise<void> {
    await optimistic(
      all.map((s) => (s.id === id ? { ...s, assignee: who } : s)),
      () => storage.patchThread(id, { assignee: who && who.id }),
    );
  }

  async function reply(id: string, body: string, name?: string): Promise<void> {
    const comment = { id: newCommentId(), body, author: reviewer(name) };
    all = all.map((s) =>
      s.id === id
        ? { ...s, comments: [...s.comments, { ...comment, snagId: id, createdAt: new Date().toISOString() }] }
        : s,
    );
    // The "and is not your own". Marking your own writing as you make it
    // is the same rule as comparing authors in the predicate, and it also
    // covers replying on somebody else's thread — which the author comparison
    // would have called new activity from you, to you.
    seen.mark(id);
    paint();
    emit("comment:create", { threadId: id, comment });
    await guard(() => storage.createComment(id, comment));
  }

  /**
   * Run a write, and survive a full disk.
   *
   * The design makes the adapter raise `local_quota_exceeded` rather than swallow
   * it, precisely so this decision is taken here and not there. What we do NOT
   * do is drop the thing the reviewer just wrote: it stays in `all` and on the
   * page for the rest of the session, unsaved. The export-and-clear affordance
   * the design describes is still owed — until it exists, this is at least loud in
   * the console and lossless on screen.
   */
  /**
   * F-02, and the one-click the design asks for: the round leaves the browser
   * losslessly, and only then is the space it needed given back.
   *
   * Named rather than inlined because there are two ways to run out of room and
   * both must say the same thing — a refused THREAD write, and a refused DRAFT
   * write, which used to fail silently on every keystroke.
   */
  function outOfRoom(): void {
    notice.show("error.quota", {
      label: "action.exportclear",
      run: () => {
        exportAs("json");
        void clearAll();
      },
    });
    console.warn(`[${PRODUCT}] ${format("error.quota")}`);
  }

  async function guard<T>(write: () => Promise<T>): Promise<T | null> {
    try {
      return await write();
    } catch (e) {
      if (e instanceof AdapterError && e.code === "local_quota_exceeded") {
        // F-02, and it is now ON SCREEN rather than in a console the reviewer
        // will never open. "Export & clear" is the one-click the design asks
        // for: the round leaves the browser losslessly, and only then is the
        // space it needed given back.
        outOfRoom();
        return null;
      }
      throw e;
    }
  }

  /**
   * Exports EVERY page, grouped by route — not just the one on screen.
   *
   * "Export what you are looking at" was the original rule and it sounded
   * right. Then a real week of review put twenty comments across three routes,
   * and the only way to get them out was to visit each route and export it
   * separately — with no all-pages view to notice that from. v0 has no backend,
   * so this is the ONLY way a round leaves the browser; trapping it per-page
   * makes the one exit narrower than the work.
   */
  function exportAs(kind: "md" | "json"): void {
    // The serialiser ships with the CAPTURE chunk (AC G5 — an export must be
    // producible with the Preact chunk never loaded), so this awaits it rather
    // than assuming a panel is open.
    void loadCapture().then(async (cap) => {
      if (!cap) return;
      // Blob refs become data: URIs, resolved before the synchronous
      // serialiser runs. A store failure exports everything BUT the images.
      const uris = await cap.resolveAttachmentUris(all).catch(() => new Map<string, string>());
      cap.download(
        root, // our shadow root — the anchor never touches the host's DOM
        cap.buildExport(kind, all, {
          origin: doc.location.origin,
          exportedAt: new Date().toISOString(),
        }, uris),
        win,
      );
    });
  }

  async function add(
    el: Element,
    point: { x: number; y: number },
    context: CaptureContext,
    body?: string,
    author?: string,
    email?: string,
    /** A record built upstream (the text path); absent = derive here. */
    anchorOverride?: import("../anchor/types.ts").AnchorRecord,
  ): Promise<Snag> {
    const who: Reviewer = reviewer(author, email);
    // The recorder ships with the CAPTURE chunk — see its header: creation only
    // ever happens with a composer open. It is already warm here, because
    // entering `add` preloads it; this await is the failure path, not the fast
    // one.
    const cap = captureMod ?? (await loadCapture());
    if (!cap) throw new Error(`[${PRODUCT}] add() needs the capture chunk`);
    // The screenshot outcome lands AFTER the T0 snapshot, so the capture
    // object is rebuilt here through the same table. A host
    // calling add() directly has no pick moment — the attempt starts now.
    if (!pendingShot) startShot(el); // no-op when configured off
    const shot = pendingShot ? await pendingShot : null;
    pendingShot = shotAbort = null;
    cap.applyShotOutcome(context, shot, scConfig === false, coarseUI && !shotWanted);
    // Persist the blob BEFORE the record is built, so the attachment ref
    // rides the same write as the thread.
    //
    // ADAPTER-GATED, and the gate now means something on both sides: local
    // writes to the IndexedDB blob store; HTTP uploads to the API
    // when the server reports a bucket and has no `uploadAttachment`
    // at all when it does not. Either way a failed store costs the
    // attachment, never the comment (the rule).
    /**
     * The upload is STARTED here and awaited later — the pin must not wait on
     * a network round trip.
     *
     * Measured on the first server-backed dogfood, with the bucket in
     * Amsterdam and the database in Singapore: the upload took 2898 ms and the
     * thread create 2555 ms, and the reviewer watched a closed composer and no
     * pin for the whole 5.5 seconds. Before a bucket was connected there was
     * no upload and the delay did not exist, so connecting one made the
     * product feel broken.
     *
     * Kicked off now so it overlaps the anchor derivation and the paint, and
     * joined below only when the record is otherwise ready. A failure still
     * costs the picture and never the comment (the rule) — hence the catch,
     * and hence `attachments` being absent rather than the write being
     * abandoned.
     */
    const uploading: Promise<import("../storage/types.ts").Attachment | null> =
      shot?.blob && storage.uploadAttachment
        ? storage
            .uploadAttachment(shot.blob, {
              kind: "screenshot",
              ...(shot.width !== undefined ? { width: shot.width } : {}),
              ...(shot.height !== undefined ? { height: shot.height } : {}),
            })
            .catch(() => null)
        : Promise.resolve(null);
    // Ids and the timestamp are client-minted exactly as in v1, so a
    // project that later gains a backend syncs its local snags without re-keying.
    const req: CreateThreadRequest = {
      id: newThreadId(),
      key: nextKey(all),
      route: routeOf(doc),
      anchor:
        anchorOverride ??
        cap.createElementAnchor(el, {
          point,
          viewportWidth: win.innerWidth,
          // All three injected from the capture chunk, because all three are
          // creation-time judgements that share the redaction vocabulary: the
          // label reads element text, and `css`/`domid` run every candidate
          // attribute value through `isSensitiveValue`.
          label: cap.deriveAnchorLabel(el),
          ...cap.describeElement(el),
        }),
      anchorState: "anchored", // just created against this DOM, by definition
      scope: scopeOf(),
      // Snapshotted at the CLICK and carried here, never re-taken: re-taking it
      // now would describe the page as it is after the composer was filled in.
      context,
      createdBy: who,
      createdAt: new Date().toISOString(),
      // Spread rather than `: undefined` — `exactOptionalPropertyTypes` treats
      // "absent" and "present but undefined" as different things, which is the
      // distinction a PATCH body depends on.
      ...(body ? { comment: { id: newCommentId(), body, author: who } } : {}),
    };

    // MEMORY AND SCREEN FIRST, STORAGE SECOND — and the write goes through
    // guard() like every other one. This is the write that carries text the
    // reviewer has just typed and cannot retype, and it was the only unguarded
    // one: on a full disk the adapter threw, this line never ran, and the snag
    // vanished from the page as well as from storage while the composer had
    // already closed. Painting first is what makes guard()'s promise — "on
    // screen for the session, unsaved" — true rather than aspirational.
    const snag = threadFromRequest(req);
    // The blob rides the RUNTIME copy only — a Blob JSONifies to {}
    // and must never reach a storage request; the blob store persists it.
    if (shot?.blob) snag.screenshotBlob = shot.blob;
    all = [...all, snag];
    seen.mark(snag.id); // your own thread is not new activity
    announce(format("announce.created", { key: snag.key }));
    emit("thread:create", { thread: snag });
    // Creating a snag while the page shows nothing is incoherent — you have just
    // made a mark you cannot see. Promote out of `browse`, the same way opening
    // the dock does (the state table).
    if (state === "browse") setState("comments");
    else paint();

    // The optimistic pin is REVERSIBLE. Painting first is right — the design
    // wants the mark to appear under the cursor, not after a round trip — but
    // an optimistic write that cannot fail is just a lie with a delay. On a
    // refusal the pin comes back off and the reviewer is told, because the
    // alternative is walking away certain a comment exists that no server
    // ever received.
    try {
      // NOW join the upload — after the pin is on screen. If it landed, the
      // attachment id rides the same write and is bound in the create's own
      // transaction; if it did not, the comment goes without one.
      //
      // IT GOES ON BOTH COPIES. `threadFromRequest` ran above, before this
      // resolved, so the in-memory snag was built without the attachment —
      // and the in-memory snag is what the detail renders and what the export
      // serialises. Setting it only on `req` persisted a picture that nothing
      // showed until a reload, which two blobstore tests caught and no amount
      // of clicking would have: on a fast local adapter the upload resolves
      // before you can open the detail.
      const shotAtt = await uploading;
      if (shotAtt) {
        req.attachments = [shotAtt];
        // AND BY ID, INTO `all` — never onto `snag`.
        //
        // `snag` is the object handed to `all` a few lines above, but by the
        // time this resolves it is no longer IN `all`: the repaint between
        // here and there rebuilds the list out of fresh objects, so
        // `all.includes(snag)` is false and a mutation lands on a copy nothing
        // reads. That is the whole bug the two blobstore tests were reporting
        // — the picture was uploaded, stored and persisted, and the export
        // still had no attachment, because the export serialises `all`.
        //
        // The old code had no such window: attachments went into `req` BEFORE
        // `threadFromRequest`, so every later copy carried them. Painting
        // first is worth the 5.4 seconds it saves; this is its bill.
        all = all.map((s) => (s.id === snag.id ? { ...s, attachments: [shotAtt] } : s));
        paint();
      }

      await guard(() => storage.createThread(req));
    } catch (e) {
      all = all.filter((s) => s.id !== snag.id);
      paint();
      notice.show("error.sendfailed", undefined, { item: TERM_ITEM.toLowerCase() });
      console.warn(`[${PRODUCT}] ${format("error.sendfailed", { item: TERM_ITEM.toLowerCase() })}`, e);
      throw e;
    }
    return snag;
  }

  /**
   * Escape leaves add mode.
   *
   * The hint pill has said "Esc when done" since the day it was written, and
   * nothing implemented it: the only Esc handlers lived in the composer and the
   * dock, both of which are in the panels chunk. So the promise was broken on
   * every page where no panel happened to be open — and, on every
   * page where the chunk failed to load at all. Capture phase, so a host page
   * that swallows keydown cannot take the exit away.
   */
  function onKey(e: KeyboardEvent): void {
    // `n`/`p` — next/previous pin in review mode (context `active`)
    // Unmodified letters, never while typing: the same
    // editable-focus test as every host-hotkey rule here. Cancelled so a
    // host page's own single-letter hotkey does not ALSO fire (the
    // rung 2 — the rung exists to make that call).
    if ((e.key === "n" || e.key === "p") && state === "comments" && !composer) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // The ORIGINAL target, not `e.target`. Seen from the document, a key
      // typed in our own reply box comes from the shadow HOST — retargeted —
      // so the old test never saw a textarea, and every n and p in a reply
      // jumped a pin and was swallowed. composedPath()[0] is what was typed in.
      const t = (e.composedPath()[0] ?? e.target) as Element | null;
      if (
        t &&
        (t.closest?.("input,textarea,select,[contenteditable]") ||
          (t as HTMLElement).isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      nav(e.key === "n" ? 1 : -1);
      return;
    }
    if (state !== "add") return;
    // `t` toggles the picker sub-mode — unmodified, and only
    // when focus is not editable, the same test the pointer net's host-hotkey
    // rule applies. The decision removed the picker, so `t` is no longer ours in any
    // state and the rung it used to occupy is gone with it.
    if (e.key !== "Escape") return;
    if (composer) return; // the composer owns Esc while it is open
    e.stopPropagation();
    setState("comments");
  }
  doc.addEventListener("keydown", onKey, true);

  /**
   * Re-check the session when the tab comes back — L1.1b, and the answer to
   * "a revoked reviewer sees nothing until they act".
   *
   * Revocation is correct at the API within 10 s (the epoch), but an
   * IDLE page makes no calls, so the reviewer sits in front of pins that will
   * not save and hears nothing until a comment fails. Returning to the tab is
   * the one moment their attention comes back and the one moment the answer
   * matters — so it is one request then, not a poll (sweep R6 forbids resident
   * loops, and this holds no timer).
   *
   * Throttled, because flipping between two tabs is a normal thing to do and
   * each flip would otherwise be a London round trip.
   */
  let lastCheck = 0;
  const onVisible = (): void => {
    if (doc.hidden || !storage.revalidate) return;
    const now = Date.now();
    if (now - lastCheck < 30_000) return;
    lastCheck = now;
    void storage.revalidate();
  };
  doc.addEventListener("visibilitychange", onVisible);

  /**
   * Repaint on resize, reload the round on a route change.
   *
   * Both were missing and both were found by using the widget on a real app:
   * pins stayed where they were painted when the window changed width, and a
   * client-side route change left the previous page's pins on screen until a
   * hard reload — confidently placed on a page they were never about.
   */
  /**
   * Survive a host application that clears the body.
   *
   * Before this, a framework re-rendering the body took the widget with it —
   * silently. Every pin, the toolbar and the panel vanished mid-round while the
   * comments sat safely in storage, and nothing distinguished that from "this
   * page has no comments". Re-appending the SAME host keeps the shadow root, so
   * no listener, sheet or pin is rebuilt.
   */
  /**
   * The shadcn page, both halves (pin hunt item 1): our events stop at our own
   * boundary so a dismiss-on-outside layer never sees them, and our host keeps
   * itself in the accessibility tree when `hideOthers` marks the body's
   * children hidden.
   */
  const unseal = sealHostEvents(root);
  const releaseAnnounce = keepHostAnnounced(root, (n) => {
    console.warn(
      `[${PRODUCT}] the host page hid the widget from assistive technology ${n} times; leaving it alone.`,
    );
  });
  const releaseHost = keepHostMounted(root, (n) => {
    // Bounded on purpose: a page in a render loop would otherwise become a
    // fight we hold the main thread for. Said once, to the console rather than
    // to the reviewer, because there is nothing they can do about it.
    console.warn(
      `[${PRODUCT}] the host page removed the widget ${n} times; leaving it alone. ` +
        `Reload to comment again.`,
    );
  });

  /**
   * The `Thread.scope` — plan task 37's forward-compat field.
   *
   * `env` and `branch` are already resolved config and were already
   * the two things that distinguish "this bug is on staging" from "this bug is
   * live". Until now the only trace of either was the `env` segment inside a
   * storage key: invisible to an export, and gone the moment two environments
   * are read together.
   *
   * `round` is deliberately not set. Declaring it in the type and leaving it
   * absent is the whole assertion — the rounds become a field at M2 rather
   * than a migration.
   *
   * NAMED, not written inline in the request object, and that is not style: a
   * comment leading an object PROPERTY survives esbuild's minifier and ships to
   * every reviewer. verify-dist caught this one on the way in — the same trap
   * that cost 570 bytes through `onModal`.
   */
  function scopeOf(): ThreadScope {
    return {
      environment: env,
      ...(ctx?.config?.branch ? { branch: ctx.config.branch } : {}),
    };
  }

  let atRoute = { route: routeOf(doc), url: doc.location.href };
  /** Said once per composer: the draft hook fires on every keystroke. */
  let quotaTold = false;
  /** The mode to put back when the modal closes — null when we are not paused. */
  let pausedFrom: PointerMode | null = null;

  /**
   * Pause, and put it back exactly as it was.
   *
   * Restoring the PREVIOUS mode is the whole point. Dropping to `browse` and
   * leaving it there means a reviewer who dismissed a confirmation mid-round
   * finds the toolbar in a state they did not choose, with no clue that a dialog
   * did it.
   *
   * NAMED, not written inline in the options object, and that is not style: a
   * comment leading an object PROPERTY survives esbuild's minifier, and 570
   * bytes of this prose shipped to every reviewer until verify-dist said so.
   * The same explanation on a function declaration is stripped.
   */
  function onModal(open: boolean): void {
    if (open) {
      if (state === "browse") return; // nothing to pause
      pausedFrom = state;
      /**
       * `keepComposer`, and this is the clause the parameter was added for —
       * nothing had ever passed it, so the parameter existed and the behaviour
       * did not.
       *
       * The design is explicit: *"Pause review mode … **Any composer stays
       * open and its draft is safe.**"* The pause is not the reviewer leaving
       * `add`; it is the page interrupting them. A newsletter or cookie
       * `<dialog>` firing on a timer while somebody is half-way through "this
       * heading is too tight at 375" took the sentence off the screen — and
       * because the composer was gone, the ✎ and the restore path were the only
       * things standing between that and losing it.
       *
       * The composer is INERT while the host's modal is up, which is the whole
       * reason for the pause — but inert is not the same as destroyed, and it
       * comes back live the moment the dialog closes.
       */
      setState("browse", true);
      // Step 3, and it is the half that was missing. Detection, the pause and
      // the auto-resume all worked; what a reviewer met was a toolbar that
      // stopped responding with nothing said. See paused.ts for why this is a
      // dialog of our own rather than the notice we already have.
      paused.show();
      emit("paused", { reason: "modal-dialog" });
    } else if (pausedFrom) {
      const mode = pausedFrom;
      pausedFrom = null;
      paused.hide();
      setState(mode);
      emit("resumed", { mode });
    }
  }
  /**
   * The page changing shape re-anchors the round.
   *
   * `paint()` and not `refresh()`: re-anchoring against the live DOM is the
   * whole job here, and a storage read on every mutation batch would be absurd.
   * The states this updates are persisted by the next real refresh — a load or
   * a route change — which is also the only moment they need to survive.
   */
  /**
   * Both eager chunks are fetched IN PARALLEL on activation.
   *
   * The panels chunk was deferred to first need instead, which reads as a
   * saving and is not one: The envelope counts runtime AND panels as the
   * activation cost, so the bytes were always going to be paid. Deferring them
   * only moved WHEN — onto the reviewer's first click on a pin, which is the
   * moment the product is supposed to feel immediate. A reviewer opening a
   * route that already has comments and clicking one waited a network round
   * trip to read it.
   *
   * `void`, and unguarded: `panels()` owns its own retry and degrade path
   * (F-04), never rejects, and `panelsMod` is what every consumer reads. This
   * is a warm-up, so the failure story is unchanged — it just happens earlier.
   */
  void panels();

  /**
   * Warm the DOCK when the round has pins (the named mitigation for making
   * it lazy): a pin on screen means a pin-click is likely, and a pin-click
   * opens the dock. A round with nothing in it warms nothing.
   */
  function warmDock(): void {
    if (visible.length > 0) void loadChunk("dock", assetBase, doc);
  }

  /**
   * `fixed-trapped`, detected and reported.
   *
   * `createHost` already relocates to `<html>` when `<body>` is the trapped
   * ancestor, which covers the case that actually happens (an off-canvas drawer
   * built on `body { transform }`). What it cannot fix is `<html>` itself
   * carrying one — there is nowhere further out to go — and the instruction
   * for the fallback is to say so rather than pretend.
   *
   * Measured rather than inferred, exactly as the design specifies: compare a fixed
   * probe's rect against the viewport and report a disagreement over 1 px. That
   * catches trapping mechanisms this build has never heard of, which a
   * property-by-property check cannot.
   */
  {
    const probe = doc.createElement("div");
    probe.style.cssText = "position:fixed;inset:0;pointer-events:none;visibility:hidden";
    root.appendChild(probe);
    const r = probe.getBoundingClientRect();
    const off =
      Math.abs(r.left) > 1 ||
      Math.abs(r.top) > 1 ||
      Math.abs(r.width - win.innerWidth) > 1 ||
      Math.abs(r.height - win.innerHeight) > 1;
    probe.remove();
    if (off) {
      // One line, once, naming what a host can do about it. The design forbids
      // throwing into host code, and a silent drift is what this replaces.
      // Short, because it is a developer diagnostic rather than reviewer copy:
      // it names the cause, the consequence and the fix in one line. The long
      // version cost eager bytes to say the same thing at greater length.
      console.warn(
        `[${PRODUCT}] fixed-trapped: <html> has transform/filter/contain, so our ` +
          `fixed layer follows it, not the viewport. Remove it, or expect drift.`,
      );
      emit("error", { code: "fixed-trapped" });
    }
  }

  /**
   * Breadcrumbs — Tier C loads AT ACTIVATION (the table), which is what
   * mount() is. The chunk is fetched through the loader like every other
   * lazy chunk; when it cannot arrive, `capture.breadcrumbs` simply stays
   * "disabled", which is the honest default rather than a failure state.
   *
   * Config comes off the CONFIG GLOBAL (the design owns the shape; 06 registers no
   * attribute for it yet): `breadcrumbs: false` means no chunk at all — a
   * privacy-conscious operator refuses the whole category, and refusing must
   * cost zero bytes.
   */
  let crumbsHandle: import("../crumbs/index.ts").CrumbsHandle | null = null;
  const navSubs = new Set<(from: string, to: string) => void>();
  // ONE read of the config global; every policy key derives from it.
  const cfgGlobal = ((): Record<string, unknown> | undefined => {
    const g = (win as unknown as Record<string, unknown>)[GLOBALS.config];
    return g && typeof g === "object" ? (g as Record<string, unknown>) : undefined;
  })();
  const bcConfig = cfgGlobal?.breadcrumbs;
  /** The knobs, from the config global — arrays are policy, not strings,
   *  so the attribute ladder never carries them (the own rule). */
  const queryPolicy: QueryPolicy = ((): QueryPolicy => {
    const sig = cfgGlobal?.significantQueryParams;
    const ign = cfgGlobal?.ignoredQueryParams;
    const out: { significantQueryParams?: readonly string[] | "*"; ignoredQueryParams?: readonly string[] } = {};
    if (sig === "*") out.significantQueryParams = "*";
    else if (Array.isArray(sig)) out.significantQueryParams = sig.map(String);
    if (Array.isArray(ign)) out.ignoredQueryParams = ign.map(String);
    return out;
  })();
  /** One options object for every derivePageRef call — the hint and the
   *  query policy travel together, and reading it fresh keeps setRoute live. */
  const pageOpts = () => ({ routeOverride, query: queryPolicy, doc });

  /**
   * Screenshots. `screenshot: false` in the config global is the
   * privacy switch (most restrictive source wins); anything else
   * is tuning, clamped by the engine. The chunk loads on FIRST capture only
   * a pick starts the shot so it usually lands before the send, and
   * the send AWAITS it — bounded by the ladder's own 6 s worst case, with
   * the composer usable throughout.
   */
  const scConfig: false | Record<string, unknown> =
    cfgGlobal?.screenshot === false
      ? false
      : cfgGlobal?.screenshot && typeof cfgGlobal.screenshot === "object"
        ? (cfgGlobal.screenshot as Record<string, unknown>)
        : {};
  /** On coarse pointers the screenshot is opt-in per comment. */
  let shotWanted = false;
  let pendingShot: Promise<import("../screenshot/capture.ts").CaptureOutcome> | null = null;
  let shotAbort: AbortController | null = null;

  function startShot(el: Element): void {
    // Coarse pointers: The per-comment opt-in, off by default.
    if (scConfig === false || pendingShot || (coarseUI && !shotWanted)) return;
    shotAbort = new AbortController();
    const signal = shotAbort.signal;
    pendingShot = loadChunk<typeof import("../screenshot/index.ts")>("screenshot", assetBase, doc).then((r) => {
      if (!r.ok) return { situation: "engine-load-failed" as const, blindSpots: [], maskedCount: 0 };
      return r.mod.captureScreenshot({
        doc,
        target: el,
        signal,
        ...(scConfig as object),
        // The image proxy (server mode only): the CORS-refused images, fetched
        // by the server for this reviewer's session.
        ...(storage.fetchForeignImage ? { fetchForeignImage: (u: string) => storage.fetchForeignImage!(u) } : {}),
      });
    });
  }



  /**
   * Does this snag belong on the CURRENT page? Route match .3's
   * MANDATORY safety valve — pathname equality is always sufficient, so
   * detection (a hint, an override) may only ever WIDEN the match set — plus
   * the significant-query agreement.
   */
  function pageFilter(): (s: Snag) => boolean {
    // Route, pathname and significant query computed ONCE per pass, not per
    // snag — the filter runs on every paint over the whole round.
    const cur = routeOf(doc);
    const curPath = redactRoute(doc.location.pathname);
    const curQ = significantQuery(doc.location.search, queryPolicy);
    return (s) =>
      (s.route === cur || s.context?.page?.pathname === curPath) &&
      queryMatches(s.context?.page?.query, curQ, queryPolicy);
  }
  {
    const bc = bcConfig;
    if (bc !== false) {
      void loadChunk<typeof import("../crumbs/index.ts")>("crumbs", assetBase, doc).then((r) => {
        if (!r.ok) return;
        crumbsHandle = r.mod.installTierC({
          win,
          // The stub's Tier A/B backlog — seeded through redaction,
          // after which the stub's recorder sinks straight into the buffer.
          ...(ctx?.early ? { early: ctx.early } : {}),
          ...(bc && typeof bc === "object" ? { config: bc as import("../crumbs/index.ts").TierCConfig } : {}),
          subscribeNav: (fn) => {
            navSubs.add(fn);
            return () => navSubs.delete(fn);
          },
        });
      });
    }
  }
  /** The buffer at T0, shaped for `captureContext()` — {} while the chunk is absent. */
  const crumbSnapshot = (): { breadcrumbs?: { records: import("../capture/types.ts").Breadcrumb[]; status: "ok" | "truncated" } } =>
    crumbsHandle ? { breadcrumbs: { records: crumbsHandle.drain(), status: crumbsHandle.status() } } : {};

  const mutations: MutationWatch = watchMutations(doc, win, () => {
    // Nothing on screen, nothing to re-anchor. `browse` renders no pins at all,
    // and a page with no comments on it must not pay for an observer pass.
    if (state !== "browse" && visible.length > 0) paint();
  });

  const watcher: PageWatcher = watchPage(win, {
    onResize: () => paint(),
    onRoute: () => {
      // The payload is `{route, url}`, not the full PageRef. Deriving a
      // PageRef means the capture chunk, and fetching a lazy chunk on every
      // client-side navigation of every page — including the ones where nobody
      // ever comments — is precisely the cost the lazy split exists to avoid.
      // These are the two fields the runtime knows on its own, and they are the
      // two a host router integration actually reads.
      const to = { route: routeOf(doc), url: doc.location.href };
      const routeChanged = to.route !== atRoute.route;
      if (routeChanged) {
        emit("navigate", { from: atRoute, to });
        // The crumbs chunk SUBSCRIBES here — it installs no history
        // patch and holds no Navigation-API policy of its own.
        for (const fn of navSubs) fn(atRoute.url, to.url);
      }
      atRoute = to;
      if (!routeChanged) {
        void refresh();
        return;
      }
      // The two-phase pass, MANDATORY: every client router renders the new
      // route asynchronously, and a single sync at +100 ms would orphan the
      // entire page. Phase 1 (+100 ms) is optimistic — results may only
      // improve, unresolved pins hold `pending`. Phase 2 (+600 ms) is
      // authoritative — `orphaned` becomes reachable, and the retry window
      // keeps covering genuinely slow renders after it.
      navSettleUntil = Date.now() + NAV_SETTLE_MS;
      win.setTimeout(() => {
        void storage.listThreads().then(({ data }) => {
          all = data;
          paint("optimistic");
        });
      }, 100);
      win.setTimeout(() => void refresh(), 600);
    },

    onModal,
  });

  // Reflect the restored mode in the toolbar before anything paints.
  toolbar.setState(state);
  pointer.setMode(state);
  // …and arm the selection watcher if that restored mode is `comments`, which
  // it is for anyone who reloads mid-review. `state` is assigned directly from
  // sessionStorage rather than through setState (that would announce a change
  // nobody made), so this is the one path where the watcher has no setState to
  // ride in on. Without it, selecting text after a reload raised no chip until
  // the reviewer happened to toggle the mode.
  armSelection();

  /**
   * F-01, said out loud.
   *
   * Shown at mount rather than on the first failed write, because by the time a
   * write fails the reviewer has already typed something on the strength of an
   * assumption nobody corrected. The action is **Export**, which is the only
   * thing that actually saves their work in this browser — and it is offered
   * before there is anything to export, on purpose: they will remember the
   * button when there is.
   */
  if (!persists) {
    notice.show("error.nostorage", { label: "action.export", run: () => exportAs("md") });
  }

  /**
   * Re-anchor on load — this is where the cascade does its real job, and
   * everything else about anchoring is preparation for this moment — then pick
   * up whatever a cross-page jump left behind.
   *
   * Consumed AFTER the refresh, on purpose: the thread has to be re-anchored
   * against this document before there is a position to scroll to. And when it
   * is not here at all — a redirect, a stale handoff, a comment resolved away on
   * another machine — the design is explicit that the reviewer lands on the LIST and
   * never on a blank dock, so the dock still opens.
   */
  void refresh().then(async (here) => {
    const id = takeHandoff(win);
    if (!id) {
      // The ?snag_t permalink — resolved LOCALLY by Thread.key
      // zero session-exchange requests, and the URL is
      // left exactly as it arrived: — it IS the shareable
      // link, and we never call replaceState for cosmetic reasons.
      const k = new URLSearchParams(doc.location.search).get(param("t"));
      if (k) {
        let target = here.find((s) => s.key === k);
        /**
         * Not in the list? ASK THE SERVER before saying it does not exist.
         *
         * The list is round-scoped — a non-owner reader gets the latest open
         * round — so a permalink to a thread from a closed round found nothing
         * and showed F-06, while the thread was there the whole time. That is
         * most of the permalinks anyone shares, because people share the ones
         * that mattered, and those are the ones a round eventually closes over.
         *
         * `?key=` overrides the round default server-side. If it still comes
         * back empty the key genuinely is not in this project, and F-06 is
         * then the right answer rather than a guess.
         */
        if (!target && storage.getThreadByKey) {
          const fetched = await storage.getThreadByKey(k).catch(() => null);
          if (fetched) {
            // Into `all` so the pin paints and the dock can scroll to it —
            // opening a panel onto a thread the renderer has never seen would
            // show the text with no pin beside it.
            all = [...all.filter((s) => s.id !== fetched.id), fetched];
            paint();
            target = all.find((s) => s.id === fetched.id);
          }
        }
        if (target) {
          await openPanel(target.id);
          dockMod?.scrollToSnag(win, root, target);
        } else {
          // F-06, verbatim copy; the LIST opens, activation stands, and
          // nothing auth-shaped happens — never "your link expired".
          notice.show("permalink.unknown");
          await openPanel(null);
        }
        return; // a permalink is a request to read, not to resume writing
      }
      // F-12. AFTER the refresh for the same reason the handoff is: the draft
      // points at an element, and the DOM has to have been resolved against
      // before there is one to point at. Skipped entirely on a handoff, because
      // a cross-page jump is somebody asking to read a specific comment, not to
      // resume writing a different one — two composers opening at once is how
      // the second eats the first.
      await restoreDraft();
      return;
    }
    const target = here.find((s) => s.id === id);
    await openPanel(target ? id : null);
    if (target) dockMod?.scrollToSnag(win, root, target);
  });

  return {
    root,
    assetBase: ctx?.assetBase ?? "",
    snags: () => visible,
    async add(el, point, body, context) {
      // A host calling this directly has no T0 of its own, so one is taken now.
      const cap = context ? null : await loadCapture();
      const snapshot =
        context ?? (cap ? cap.captureContext({ page: cap.derivePageRef(doc.location, pageOpts()), ...crumbSnapshot() }) : undefined);
      if (!snapshot) {
        throw new Error(`[${PRODUCT}] add() needs the capture chunk, or an explicit context`);
      }
      return add(el, point, snapshot, body);
    },
    refresh,
    // Path 1 — always authoritative, reversible to null. (Comment
    // ABOVE the literal in // form: esbuild ships property-leading comments.)
    setRoute(pattern: string | null) {
      routeOverride = pattern && pattern.startsWith("/") ? pattern : null;
      void refresh();
    },
    setState,
    getState: () => state,
    openPanel,
    // Key first (the wire never carries a bare UUID); the
    // dock scroll mirrors the handoff arm.
    async open(idOrKey: string): Promise<OpenResult> {
      const target = idOrKey.startsWith(ID_PREFIX.thread)
        ? all.find((s) => s.id === idOrKey)
        : all.find((s) => s.key === idOrKey);
      if (!target) return { ok: false, reason: "not-found" };
      if (target.route !== routeOf(doc)) {
        // "We never navigate the host app on a host script's behalf" — the
        // host gets the URL and decides.
        return {
          ok: false,
          reason: "wrong-page",
          url: target.context?.url ?? target.route,
          route: target.route,
        };
      }
      await openPanel(target.id);
      dockMod?.scrollToSnag(win, root, target);
      return { ok: true, anchorState: target.anchorState };
    },
    closePanel,
    hitTest: (x, y) => pointer.hitTest(x, y),
    destroy() {
      composer?.close();
      closePanel();
      chrome?.destroy();
      notice.destroy();
      paused.destroy();
      unglue();
      releaseHost();
      releaseAnnounce();
      unseal();
      watcher.destroy();
      mutations.destroy();
      // The matrix: Tier C wrappers restore identity-based, listeners
      // die on the chunk's own AbortController, the buffer releases its strings.
      crumbsHandle?.destroy();
      crumbsHandle = null;
      navSubs.clear();
      selectWatch?.destroy();
      selectWatch = null;
      fuzzyEngine?.destroy();
      fuzzyEngine = null;
      if (retryTimer) win.clearTimeout(retryTimer);
      retryTimer = 0;
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("visibilitychange", onVisible);
      releaseTheme();
      pointer.destroy();
      pins.destroy();
      toolbar.destroy();
      root.host.remove();
    },
  };
}

export { HOST_CSS, createHost };
export type { PointerMode, Snag };
