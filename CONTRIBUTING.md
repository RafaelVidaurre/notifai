# Contributing

Contributions are welcome. There is no CLA and no DCO — open a pull
request and that is the whole process. By contributing you agree your
work is licensed under Apache-2.0, the same as the rest of the
repository.

## What lives here

This repository is the **client surface** of Notifai: the `notifai` CLI,
the wire contract it speaks, and the agent skill. The service and the
companion apps are developed separately and are not part of this tree.

That split is a security posture, not an accident, so it is the one
thing a pull request cannot negotiate. The service must stay secure when
everything here is fully known. Read [`docs/BOUNDARY.md`](docs/BOUNDARY.md)
before adding anything — it is enforced by a gate, and the gate is not
advisory.

## Getting set up

```sh
pnpm install
pnpm -r build      # protocol first; the CLI resolves its built exports
```

## Before you open a pull request

```sh
pnpm check:boundary:self-test
pnpm check:boundary   # structural allowlist + forbidden-content scan
pnpm -r build
pnpm -r test          # no Docker, no network
pnpm lint && pnpm -r typecheck
pnpm check:release    # package allowlist, metadata, docs, and licenses
```

All gates must pass. The test suite needs neither a network nor a container
runtime, so a failure is a real failure. CI additionally runs a pinned gitleaks
binary across the working tree and full history; its job first proves both
scanner paths against ephemeral canaries.

## What makes a change easy to accept

**Say why, not what.** The diff already shows what changed. Comments and
commit messages that explain the reasoning — especially the option you
rejected and why — are what survive being read in a year.

**Cover the failure, not the feature.** A test that demonstrates the bug
before the fix is worth more than three that exercise the happy path.

**A flag combination that parses but does nothing is a bug.** If an
option can be passed in a way that silently has no effect, make it a
usage error instead. Two of those have shipped here already.

**Keep the CLI silent unless it has something to say.** It runs inside
agent harnesses where every line competes with the user's actual work.

## Reporting a security issue

Do not open a public issue. See [`SECURITY.md`](SECURITY.md).
