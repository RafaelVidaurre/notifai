# NotifAI CLI

`notifai` lets software agents and local programs send native phone
notifications to their user — completion notices, questions with answer
buttons, and status updates that land on a lock screen instead of an
unwatched terminal.

This repository is the public home of:

- **`apps/cli`** — the `notifai` command-line tool (`@notifai/cli`).
- **`packages/protocol`** — the client-visible wire contract
  (`@notifai/protocol`): notification draft schemas, REST v1
  request/response types, the status vocabulary, and capability
  negotiation. The CLI validates drafts offline against the same bundled
  capability documents the service enforces.

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

The optional NotifAI agent guidance skill is not part of this repository
and is never installed by default. `notifai init` only writes project
configuration; `notifai init --skills` is an explicit opt-in and fails
cleanly in this build because no public skill source is configured yet.
