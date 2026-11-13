# Licences

Snagset is split across two licences, and each package declares its own in its
`package.json` and `LICENSE` file.

- **AGPL-3.0-only** — `apps/server` and `apps/dashboard`. These are the
  self-hosted application. The AGPL
  keeps it open: anyone who runs a modified copy as a service must offer their
  users the source of that copy.
- **MIT** — `packages/widget-core`, `packages/widget-npm`, `packages/types`,
  `packages/mcp`, `packages/adapters`, `packages/tsconfig` and
  `packages/create-snagset`. The widget and the libraries it is built from are
  embedded in other people's websites and tools, and `npm create snagset`
  writes a starter project its user then owns, so they carry no conditions
  beyond keeping the notice.

The full text of each licence is in the `LICENSE` file of the package it covers.
