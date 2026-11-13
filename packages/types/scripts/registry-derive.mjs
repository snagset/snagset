// Pure derivation: registry.json + a brand → every externally visible token.
//
// This module is the mechanism behind the claim that renaming the
// product is "a task measured in minutes". Nothing here reads the brand from
// anywhere but the argument, so test/rename.test.ts can call derive() with a
// different brand and assert that ZERO tokens of the old one survive.
//
// Plain JS on purpose: the names gate must not depend on the TS toolchain it
// bootstraps.

/** @param {object} reg parsed registry.json @param {object} [brandOverride] */
export function derive(reg, brandOverride) {
  const brand = brandOverride ?? reg.brand;
  const { long, short, pkg } = brand;
  const UPPER = pkg.toUpperCase();

  const attrPrefix = `data-${short}-`;
  const paramPrefix = `${short}_`;
  const storagePrefix = `${short}:`;

  const attrs = (names) => Object.fromEntries(names.map((n) => [camel(n), attrPrefix + n]));

  return {
    brand,
    core: {
      PRODUCT: long,
      NPM_PACKAGE: pkg,
      NPM_SCOPE: `@${pkg}`,
      // deliberately NOT derived — see registry.frozen
      SCHEMA_VERSION: reg.frozen.schemaVersion,
      CSS_VAR_PREFIX: `--${short}-`,
      HTTP_HEADER_PREFIX: `x-${pkg}-`,
      ENV_PREFIX: `${UPPER}_`,
      PG_TYPE_PREFIX: `${short}_`,
      METRIC_PREFIX: `${pkg}_`,
      DOM_EVENT_PREFIX: `${pkg}:`,
      SYMBOL_PREFIX: `${pkg}.`,
      MENTION_SCHEME: `${short}:user/`,
      SKIP_HEADER: `x-${pkg}-skip`,
      THREAD_REF_PREFIX: reg.identifiers.threadRefPrefix,
      // Domain vocabulary. Derived, so it can never drift from the brand:
      // a "Snagset" is the product; a "Snag" is one item in it.
      TERM_SET: long,
      TERM_SET_PLURAL: `${long}s`,
      TERM_ITEM: short.charAt(0).toUpperCase() + short.slice(1),
      TERM_ITEM_PLURAL: `${short.charAt(0).toUpperCase() + short.slice(1)}s`,
      RESERVED_CUSTOM_PREFIX: reg.reservedCustom.prefix,
    },
    globals: {
      api: long,
      config: `${long}Config`,
      disabled: `__${UPPER}_DISABLED__`,
      assetBase: `__${UPPER}_ASSET_BASE__`,
      collisionFallback: `__${pkg}__`,
    },
    scriptAttr: attrs(reg.scriptAttrs.names),
    widgetAttr: attrs(reg.widgetAttrs.names),
    hostAttr: attrs(reg.hostAttrs.names),
    cssClass: Object.fromEntries(reg.cssClasses.names.map((n) => [camel(n), `${short}-${n}`])),
    // Custom properties: one flat map for lookups, plus the group membership the
    // theme block and its tests need. Both derive the prefix, so a rename moves
    // the public theming API with it instead of stranding it on the old name.
    cssVar: Object.fromEntries(
      Object.entries(reg.cssVars.groups).flatMap(([, g]) =>
        g.names.map((n) => [camel(n), `--${short}-${n}`]),
      ),
    ),
    cssVarGroups: Object.fromEntries(
      Object.entries(reg.cssVars.groups).map(([group, g]) => [group, g.names.map(camel)]),
    ),
    params: {
      prefix: paramPrefix,
      query: reg.urlParams.query.map((n) => paramPrefix + n),
      fragment: reg.urlParams.fragment.map((n) => paramPrefix + n),
      queryNames: reg.urlParams.query,
      fragmentNames: reg.urlParams.fragment,
    },
    storage: Object.fromEntries(
      Object.entries(reg.storage.keys).map(([k, suffix]) => [k, storagePrefix + suffix]),
    ),
    idb: { database: storagePrefix + reg.idb.database, store: reg.idb.store },
    cookies: Object.fromEntries(reg.cookies.names.map((n) => [camel(n), `${short}_${n}`])),
    // The pair, derived by the same rule and kept in their own map so
    // "no cookie authenticates the WIDGET API" stays checkable as a rule.
    dashboardCookies: Object.fromEntries(reg.cookies.dashboard.map((n) => [camel(n), `${short}_${n}`])),
    artifacts: Object.fromEntries(
      Object.entries(reg.artifacts.suffixes).map(([k, sfx]) => [
        k,
        sfx ? `${short}.${sfx}.js` : `${short}.js`,
      ]),
    ),
    identifiers: reg.identifiers.prefixes,
    // The credential literals, DERIVED from brand.short — unlike the
    // entity prefixes above, which are abbreviations and survive a rename.
    // The spec awards `cdmcp_`, a pre-rename spelling; deriving it is what
    // stops the next rename leaving a credential behind.
    credentials: Object.fromEntries(
      Object.entries(reg.identifiers.credentialPrefixes)
        .filter(([k]) => !k.startsWith("$"))
        .map(([k, sfx]) => [k, `${short}${sfx}`]),
    ),
    domEvents: Object.fromEntries(reg.domEvents.names.map((n) => [camel(n), `${pkg}:${n}`])),
    metaNames: Object.fromEntries(reg.metaNames.names.map((n) => [camel(n), `${pkg}:${n}`])),
    httpHeaders: Object.fromEntries(reg.httpHeaders.names.map((n) => [camel(n), `x-${pkg}-${n}`])),
    symbols: Object.fromEntries(reg.symbols.names.map((n) => [camel(n), `${pkg}.${n}`])),
    budgets: reg.budgets,
  };
}

/** kebab/snake → camel, so `asset-base` becomes the identifier `assetBase`. */
export function camel(s) {
  return s.replace(/[-_](.)/g, (_, c) => c.toUpperCase());
}

/** Every derived string, flattened — used by the rename proof. */
export function allTokens(d) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk({
    core: d.core, globals: d.globals, scriptAttr: d.scriptAttr, widgetAttr: d.widgetAttr,
    hostAttr: d.hostAttr, cssClass: d.cssClass, params: d.params, storage: d.storage,
    cookies: d.cookies, dashboardCookies: d.dashboardCookies, artifacts: d.artifacts, domEvents: d.domEvents, symbols: d.symbols,
    metaNames: d.metaNames,
    httpHeaders: d.httpHeaders,
    // cssVar, not cssVarGroups: the groups hold camelised NAME keys, not tokens.
    cssVar: d.cssVar,
  });
  return out;
}
