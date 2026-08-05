# NotifAI

`notifai` lets software agents and local programs send native device
notifications to their user — completion notices, answerable questions, and
status updates that land on a lock screen or desktop instead of an unwatched
terminal.

This repository is the public home of:

- **`apps/cli`** — the `notifai` command-line tool (`@notifai/cli`).
- **`packages/protocol`** — the client-visible wire contract
  (`@notifai/protocol`): notification draft schemas, REST v1
  request/response types, the status vocabulary, and capability
  negotiation. The CLI validates drafts offline against the same bundled
  capability documents the service enforces.
- **`skills/notifai`** — the agent guidance skill: when to notify and how
  to write notifications that work on a lock screen.

The NotifAI service, companion apps, and their deployment live in a private
repository. Everything the CLI sends and receives crosses the documented
`/api/v1` contract in `packages/protocol`; nothing in this repository
depends on private code. `docs/BOUNDARY.md` states the policy and
`pnpm check:boundary` enforces the mechanical part of it.

## Status

Pre-release scaffold. Nothing here is published to npm yet, and both
packages are marked `"private": true` until the npm scope and package
names are finalized. The license for this repository has not been chosen
yet (Apache-2.0 is the working recommendation); until a LICENSE file
exists, this repository must not be published or mirrored publicly.

## Development

Requires Node >= 20 and pnpm.

```sh
pnpm install
pnpm build          # compile all packages
pnpm test           # unit tests (no Docker, no network)
pnpm typecheck
pnpm lint
pnpm check:boundary # verify no private imports or disallowed files
```

The CLI binary builds to `apps/cli/dist/main.js`.

## The agent skill

The NotifAI agent guidance skill lives in `skills/notifai/` and is never
installed by default. `notifai init` coordinates project configuration,
sign-in, optional harness hooks, and device readiness. `notifai init --skills`
fails cleanly in this build because the installable skill source is not
configured until the first tagged release exists to pin it to.
