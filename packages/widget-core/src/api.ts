/**
 * THE PUBLIC API SURFACE — the closed contract, as types.
 *
 * Its own module because the design puts these inside SemVer alongside the
 * `data-snag-*` attributes, the CSS custom properties and the emitted file
 * names: *"the public API surface of @snagset/widget is: the window.Snagset
 * methods, the data-snag-* attribute set, the SnagsetConfig/SnagsetApi
 * TypeScript types …"*. A contract spread across an implementation file is a
 * contract that changes by accident, and until this file existed nothing
 * type-checked the shape at all — the E2E suite declared it nineteen times, by
 * hand, differently each time.
 *
 * Nothing here emits a byte: types only, erased at build.
 */
import type { Config } from "./loader/policy.ts";
import type { RuntimeMount } from "./runtime/index.ts";

export type { Config as SnagsetConfig };

export type Mode = "browse" | "comments" | "add";

/**
 * What the STUB uses of the mounted runtime — a named subset of `RuntimeMount`.
 *
 * Kept separate from the full handle so the stub's own code depends on five
 * methods rather than on twelve. `activate()` still RESOLVES with the whole
 * thing, because that is what the harness and the E2E suite drive the widget
 * through, and typing it as less than it is only moves the cast somewhere else.
 */
export interface Runtime {
  setState(mode: Mode): void;
  getState(): Mode;
  refresh(): Promise<unknown>;
  closePanel(): void;
  destroy(): void;
}

export interface RuntimeModule {
  mount(
    root: ShadowRoot | undefined,
    ctx: { assetBase: string; config: Config; emit: Emit },
  ): RuntimeMount;
}

/**
 * The states. `dormant` is the one that pays for this whole file:
 * installed, listening for its chord, and having touched nothing.
 *
 * The spec's `WidgetState` has seven members; `booting`, `redeeming` and
 * `degraded` are the three that only exist once there is a server to boot
 * against, redeem a token with, or be withdrawn by. None of them is reachable
 * on the local adapter, and a state you cannot enter is a lie in a type.
 */
export type Phase = "dormant" | "active" | "inert" | "destroyed";

export type Emit = (type: string, payload?: unknown) => void;
export type Listener = (payload: unknown) => void;

/**
 * The public JS API, v0 members only.
 *
 * Everything tagged v1 there — `mount`, `identify`,
 * `refreshIdentity`, the three metadata methods, `getThreads`, `refresh` — is
 * absent rather than stubbed. A method that exists and does nothing is worse
 * than one that does not exist: `typeof api.identify === "function"` is how a
 * host feature-detects, and a no-op passes that test and then silently drops
 * the reviewer's name. `open()` arrived with v0.1.
 */
export type OpenResult =
  | { ok: true; anchorState: string }
  | { ok: false; reason: "inert" | "not-found" | "wrong-page"; url?: string; route?: string };

export interface SnagsetApi {
  readonly version: string;
  readonly config: Config;
  readonly assetBase: string;
  readonly state: Phase;
  /** "'browse' unless state === 'active'". */
  readonly pointerMode: Mode;
  activated: boolean;
  /** Merge config. Safe before mount, safe to repeat. NEVER rejects. */
  init(config?: Config): Promise<SnagsetApi>;
  /**
   * Lazily fetch and mount the runtime. Idempotent; concurrent calls share one
   * fetch.
   *
   * Types this `Promise<void>`. It resolves with the mount instead
   * a superset, and the handle the playground harness and the E2E suite drive
   * the widget through. Documented here rather than left to a cast at every
   * call site, which is what the tests were doing.
   */
  activate(opts?: { mode?: Mode }): Promise<RuntimeMount | null>;
  /** active → dormant. Closes the UI and the pins; keeps the chunks in memory. */
  deactivate(): void;
  /** Full teardown. Idempotent. Never throws. */
  destroy(): void;
  /** Switch pointer mode, activating first if dormant. */
  setMode(mode: Mode): void;
  /**
   * The route-pattern override (path 1) — promoted .1's v1
   * list at, because the spec tags the override path v0.1 and the plan
   * schedules it there; the framework wrappers that would CALL it stay v1.x.
   * Safe before activation: the value is stashed and applied at mount.
   */
  setRoute(pattern: string | null): void;
  /**
   * (v0.1): open a thread by `Thread.key` (`SN-14`) or `thr_…` id.
   * Dormant activates first; inert resolves `{ok:false, reason:'inert'}`.
   * NEVER navigates — a wrong-page result carries the URL and the host
   * decides (the inbox's user-gesture navigation is the other row).
   */
  open(idOrKey: string): Promise<OpenResult>;
  /** One re-measure, re-anchor and reposition pass, for layout no observer sees. */
  resync(): void;
  /** Close any open panel without changing mode. */
  close(): void;
  on(type: string, fn: Listener): () => void;
  off(type: string, fn: Listener): void;
}

