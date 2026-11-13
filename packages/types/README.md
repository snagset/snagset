# @snagset/types

Shared types and **the executable Name Registry** — the first thing in the build, because everything else compiles against it.

## The Name Registry

`registry.json` is the single source of truth for every externally visible name in Snagset (the executable mirror). Nothing in the codebase hardcodes these strings; everything imports builders from here:

```ts
import { scriptAttr, param, storageKey, SCHEMA_VERSION } from "@snagset/types/names";

scriptAttr("site")          // "data-snag-site"
param("k")                  // "snag_k"   (fragment secret)
storageKey.threads(uid, env) // "snag:threads:<uid>:<env>"
SCHEMA_VERSION              // "snagset.v1"  — the one permanent token
```

`src/names.ts` is **generated** from `registry.json` and committed. Change a name in one place:

```bash
pnpm gen:names        # rewrite src/names.ts
pnpm gen:names:check  # CI gate: exits 1 if names.ts drifts from registry.json
```

Renaming the product is one edit to `registry.json` + a regenerate — which is exactly how `Cedilla`/`cd` became `Snagset`/`snag`. The generator is plain JS on purpose: the gate every package depends on must not depend on the TS toolchain it bootstraps.

## Why builders, not constants

`scriptAttr("mask")` instead of a bare `"data-snag-mask"` string keeps the prefix in one place — a prefix change is a one-line edit to the registry, not a find-and-replace through every call site. The pre-Snagset history is the argument: naming drift across specs is what the registry exists to prevent, and a lint that greps for stray `cd`/`cedilla` tokens is only enforceable when there is exactly one place the real tokens live.
