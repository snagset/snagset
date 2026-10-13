// ─────────────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: packages/types/registry.json
// Regenerate:      pnpm gen:names      (CI runs `pnpm gen:names:check`)
//
// The Name Registry made executable. Every token
// below is DERIVED from registry.json's `brand` block — the product name lives
// in exactly one place. test/rename.test.ts proves it: flip the brand, and no
// token of the old one survives. SCHEMA_VERSION is the one deliberate literal.
// ─────────────────────────────────────────────────────────────────────────────

/** The one place the product name exists. Everything else derives from this. */
export const BRAND = {
  $comment: "The ONLY place the product name appears. `long` = display/global name. `short` = the terse prefix that goes on attributes, classes, params, storage keys and artefact filenames (a client's DOM should not carry a long word). `pkg` = the npm/lowercase form used for env vars, headers, metrics, DOM events and symbols.",
  long: "Snagset",
  short: "snag",
  pkg: "snagset",
} as const;

export const PRODUCT = "Snagset" as const;
export const NPM_PACKAGE = "snagset" as const;
export const NPM_SCOPE = "@snagset" as const;
/** Frozen once v1 stores real data — stamped into exports, issue bodies and the MCP contract, so it must survive a rename (registry.frozen). */
export const SCHEMA_VERSION = "snagset.v1" as const;
export const CSS_VAR_PREFIX = "--snag-" as const;
export const HTTP_HEADER_PREFIX = "x-snagset-" as const;
export const ENV_PREFIX = "SNAGSET_" as const;
export const PG_TYPE_PREFIX = "snag_" as const;
export const METRIC_PREFIX = "snagset_" as const;
export const DOM_EVENT_PREFIX = "snagset:" as const;
export const SYMBOL_PREFIX = "snagset." as const;
export const MENTION_SCHEME = "snag:user/" as const;
export const SKIP_HEADER = "x-snagset-skip" as const;
export const THREAD_REF_PREFIX = "SN-" as const;
export const TERM_SET = "Snagset" as const;
export const TERM_SET_PLURAL = "Snagsets" as const;
export const TERM_ITEM = "Snag" as const;
export const TERM_ITEM_PLURAL = "Snags" as const;
export const RESERVED_CUSTOM_PREFIX = "cr." as const;

/** @returns e.g. `x-snagset-idempotency-key` */
export const header = (name: string): string => HTTP_HEADER_PREFIX + name;
/** @returns e.g. `SNAGSET_SESSION_TTL_S` */
export const env = (name: string): string => ENV_PREFIX + name;
/** @returns e.g. `snag_attachment_kind` */
export const pgType = (name: string): string => PG_TYPE_PREFIX + name;
/** @returns e.g. `snagset_http_requests_total` */
export const metric = (name: string): string => METRIC_PREFIX + name;

/** window.* names. Dunders are internal/test affordances, not public API. */
export const GLOBALS = {
  api: "Snagset",
  config: "SnagsetConfig",
  disabled: "__SNAGSET_DISABLED__",
  assetBase: "__SNAGSET_ASSET_BASE__",
  collisionFallback: "__snagset__",
} as const;

/** data-*-attributes on the host <script> tag. */
export type ScriptAttr = "site" | "host" | "disabled" | "env" | "mode" | "badge" | "lang" | "theme" | "position" | "offset" | "assetBase" | "branch" | "build" | "storage" | "hotkey" | "allowAutomation" | "screenshots" | "maskSelectors" | "nonce" | "autoMount";
const scriptAttrToken: Record<ScriptAttr, string> = {
  site: "data-snag-site",
  host: "data-snag-host",
  disabled: "data-snag-disabled",
  env: "data-snag-env",
  mode: "data-snag-mode",
  badge: "data-snag-badge",
  lang: "data-snag-lang",
  theme: "data-snag-theme",
  position: "data-snag-position",
  offset: "data-snag-offset",
  assetBase: "data-snag-asset-base",
  branch: "data-snag-branch",
  build: "data-snag-build",
  storage: "data-snag-storage",
  hotkey: "data-snag-hotkey",
  allowAutomation: "data-snag-allow-automation",
  screenshots: "data-snag-screenshots",
  maskSelectors: "data-snag-mask-selectors",
  nonce: "data-snag-nonce",
  autoMount: "data-snag-auto-mount",
};
export const scriptAttr = (name: ScriptAttr): string => scriptAttrToken[name];

/** DOM the widget authors on itself. */
export type WidgetAttr = "root";
const widgetAttrToken: Record<WidgetAttr, string> = {
  root: "data-snag-root",
};
export const widgetAttr = (name: WidgetAttr): string => widgetAttrToken[name];

/** Attributes the host application may author. */
export type HostAttr = "anchor" | "ignore" | "mask" | "nomask" | "src" | "component";
const hostAttrToken: Record<HostAttr, string> = {
  anchor: "data-snag-anchor",
  ignore: "data-snag-ignore",
  mask: "data-snag-mask",
  nomask: "data-snag-nomask",
  src: "data-snag-src",
  component: "data-snag-component",
};
export const hostAttr = (name: HostAttr): string => hostAttrToken[name];

/** Class-form masking hooks. */
export type CssClass = "mask" | "block";
const cssClassToken: Record<CssClass, string> = {
  mask: "snag-mask",
  block: "snag-block",
};
export const cssClass = (name: CssClass): string => cssClassToken[name];

/** Custom properties (the prefix, enumerated). The design makes every one of these public SemVer surface, so they are registered rather than minted at the point of use. Values are NOT here — the registry governs names, never design. */
export const CSS_VAR = {
  font: "--snag-font",
  accent: "--snag-accent",
  onAccent: "--snag-onAccent",
  bg: "--snag-bg",
  fg: "--snag-fg",
  muted: "--snag-muted",
  border: "--snag-border",
  radius: "--snag-radius",
  shadow: "--snag-shadow",
  z: "--snag-z",
  motion: "--snag-motion",
  surface: "--snag-surface",
  sunken: "--snag-sunken",
  hover: "--snag-hover",
  focus: "--snag-focus",
  disabled: "--snag-disabled",
  statusOpen: "--snag-status-open",
  statusProgress: "--snag-status-progress",
  statusReview: "--snag-status-review",
  statusResolved: "--snag-status-resolved",
  anchorOrphan: "--snag-anchor-orphan",
  tbH: "--snag-tb-h",
  dockW: "--snag-dock-w",
  kb: "--snag-kb",
  thumbX: "--snag-thumb-x",
  thumbW: "--snag-thumb-w",
} as const;

/** Which tokens belong to which role — the dark block must override theme members only. */
export const CSS_VAR_GROUPS = {
  theme: ["font", "accent", "onAccent", "bg", "fg", "muted", "border", "radius", "shadow", "z", "motion"],
  derived: ["surface", "sunken", "hover", "focus", "disabled"],
  status: ["statusOpen", "statusProgress", "statusReview", "statusResolved"],
  anchor: ["anchorOrphan"],
  geometry: ["tbH", "dockW", "kb", "thumbX", "thumbW"],
} as const;

export type CssVar = keyof typeof CSS_VAR;
/** @returns e.g. `--snag-bg` */
export const cssVar = (name: CssVar): string => CSS_VAR[name];
/** @returns e.g. `var(--snag-bg)` — what stylesheets actually interpolate. */
export const cssRef = (name: CssVar): string => `var(${CSS_VAR[name]})`;

export type QueryParam = "t" | "off" | "debug" | "theme";
export type FragmentParam = "k";
/** @returns e.g. `snag_t`. The review-link secret is a FRAGMENT param. */
export const param = (name: QueryParam | FragmentParam): string => "snag_" + name;
export const RESERVED_URL_PARAMS = {
  query: ["snag_t", "snag_off", "snag_debug", "snag_theme"],
  fragment: ["snag_k"],
} as const;

/** Point consts for hot paths: a chunk needing ONE key imports it and
 *  drops the whole table — object properties cannot tree-shake, and the
 *  panels chunk was carrying ten keys to read two. */
export const DISCLOSURE_KEY = "snag:disclosure:v1";
export const IDENTITY_KEY = "snag:identity";
export const THEME_ATTR = "data-snag-theme";

/** Web-storage keys. Parameterised keys are functions. */
export const storageKey = {
  session: (uid: string): string => `snag:session:${uid}`,
  silent: (uid: string): string => `snag:silent:${uid}`,
  identity: IDENTITY_KEY,
  threads: (uid: string, env: string): string => `snag:threads:${uid}:${env}`,
  seen: (uid: string, env: string): string => `snag:seen:${uid}:${env}`,
  counts: (origin: string): string => `snag:counts:${origin}`,
  draft: (route: string, draftId: string): string => `snag:draft:${route}:${draftId}`,
  outbox: (uid: string): string => `snag:outbox:${uid}`,
  mode: "snag:mode",
  handoff: "snag:handoff",
  seenCoach: "snag:seen-coach",
  disclosure: DISCLOSURE_KEY,
} as const;

/** The v0.1 IndexedDB blob store — one database, one
 *  object store, shared by screenshots, reviewer images and the v2 outbox. */
export const IDB = {
  database: "snag:blobs",
  store: "blobs",
} as const;

/** Anchored regex sources matching every registered key — the storage diff. */
export const STORAGE_KEY_PATTERNS = [
  "^snag:session:.+$",
  "^snag:silent:.+$",
  "^snag:identity$",
  "^snag:threads:.+:.+$",
  "^snag:seen:.+:.+$",
  "^snag:counts:.+$",
  "^snag:draft:.+:.+$",
  "^snag:outbox:.+$",
  "^snag:mode$",
  "^snag:handoff$",
  "^snag:seen-coach$",
  "^snag:disclosure:v1$",
] as const;

/** The WIDGET's two. Neither carries a credential, and no cookie authenticates the widget API — it runs on somebody else's origin. */
export const COOKIE = {
  off: "snag_off",
  on: "snag_on",
} as const;

/** The dashboard's session + CSRF pair — first-party, on the server's own origin, owner audience. */
export const DASHBOARD_COOKIE = {
  session: "snag_session",
  csrf: "snag_csrf",
} as const;

/** The design names these two constants directly; both spellings resolve to the same string. */
export const DASHBOARD_SESSION_COOKIE = DASHBOARD_COOKIE.session;
export const DASHBOARD_CSRF_COOKIE = DASHBOARD_COOKIE.csrf;

/** Built widget chunks. Preact lives only in `panels`. */
export const ARTIFACT = {
  stub: "snag.js",
  runtime: "snag.runtime.js",
  panels: "snag.panels.js",
  crumbs: "snag.crumbs.js",
  capture: "snag.capture.js",
  screenshot: "snag.screenshot.js",
  anchorExt: "snag.anchor-ext.js",
  anchorFuzzy: "snag.anchor-fuzzy.js",
  dock: "snag.dock.js",
  text: "snag.text.js",
} as const;

/** Wire-form entity id prefixes. Not brand-derived. */
export const ID_PREFIX = {
  project: "prj_",
  thread: "thr_",
  comment: "cmt_",
  reviewer: "rev_",
  attachment: "att_",
  link: "lnk_",
  round: "rnd_",
} as const;

/** Credential literals. Brand-DERIVED, and deliberately not the three-letter row shape: the literal is what gets registered with secret scanning, so a token pasted into a public repo is reported. */
export const CREDENTIAL_PREFIX = {
  mcp: "snagmcp_",
} as const;

/** CustomEvents dispatched on document. */
export const DOM_EVENT = {
  ready: "snagset:ready",
  activate: "snagset:activate",
  deactivate: "snagset:deactivate",
  threadCreated: "snagset:thread-created",
  threadResolved: "snagset:thread-resolved",
} as const;

/** Request/response header names inside the prefix. */
export const HTTP_HEADER = {
  client: "x-snagset-client",
  schema: "x-snagset-schema",
  idempotencyKey: "x-snagset-idempotency-key",
  identity: "x-snagset-identity",
  csrf: "x-snagset-csrf",
  attachmentKind: "x-snagset-attachment-kind",
  attachmentWidth: "x-snagset-attachment-width",
  attachmentHeight: "x-snagset-attachment-height",
  server: "x-snagset-server",
  minClient: "x-snagset-min-client",
  time: "x-snagset-time",
  configVersion: "x-snagset-config-version",
  idempotentReplay: "x-snagset-idempotent-replay",
  requestId: "x-snagset-request-id",
  mcpTransport: "x-snagset-mcp-transport",
} as const;

/** Host-authored `<meta name>` keys we READ and never mint .: `route` is the only one. */
export const META_NAME = {
  route: "snagset:route",
} as const;

/** Keys for Symbol.for() patch bookkeeping. */
export const SYMBOL_KEY = {
  original: "snagset.original",
  wrapped: "snagset.wrapped",
  instance: "snagset.instance",
} as const;

