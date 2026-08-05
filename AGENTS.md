# Agent Instructions

This repository is the public client surface of NotifAI: the `notifai` CLI
(`apps/cli`), the client-visible wire contract (`packages/protocol`), and the
agent guidance skill (`skills/notifai`). The service, companion apps, and
their operations live in a private repository. These instructions apply
whether you are working in a standalone clone or inside a private root that
mounts this repository as a submodule.

## The boundary is the security posture

Read `docs/BOUNDARY.md` before adding anything. The service must remain
secure when everything in this repository is fully known. Nothing
server-side, no deployment or infrastructure configuration, no signing
material, no credentials, and no private identifiers may enter this tree —
regardless of how harmless they look. Public code never imports private
packages; when a change seems to need one, the client-visible part belongs
in `packages/protocol` and the rest stays private.

Write commit messages for a public audience: no internal issue-tracker IDs,
decision-log references, or private project names.

## Gates — run before every commit

```sh
pnpm check:boundary:self-test # prove boundary canaries still fail
pnpm check:boundary   # structural allowlist + forbidden-content scan
pnpm -r build         # protocol first — the CLI resolves its built exports
pnpm -r test          # unit tests; no Docker, no network
pnpm lint && pnpm -r typecheck
pnpm check:release    # packed files, metadata, docs, licenses, CLI version
```

CI also runs `pnpm check:secrets` with its pinned gitleaks binary. That gate
scans both the working tree and full Git history, after proving both paths with
ephemeral positive controls.

If a change needs a new top-level entry, workspace package, or file kind,
extend the allowlist in `scripts/check-boundary.mjs` in the same commit and
justify it in the commit message. When in doubt, it stays private.

## Releasing is not yours to decide

This repository is published, and `@raidiant/notifai` and
`@raidiant/notifai-protocol` are on npm as of 2026-08-05. That does not
make the next release routine.

Do not run `npm publish`, do not create releases or tags, and do not push
this repository anywhere new, without the maintainer asking for it in that
instance. A version, once published, cannot be taken back.

The skill installer source (`SKILLS_SOURCE`) is pinned to the immutable public
tag `v0.1.7`. In the skills CLI grammar, `owner/repo#ref` selects a Git ref;
`owner/repo@name` selects a skill. Never point it at an unpublished, mutable,
or private location.

## npm credentials

No npm token, in any form, may ever appear in this repository: not in
`.npmrc`, not in `.env` files, not in scripts, docs, tests, or commit
messages. Agents never ask for, echo, or store a token, and never run
`npm login`, `npm adduser`, `npm token`, or credential-writing
`npm config set`. When the maintainer publishes, auth lives in their
user-level npm credential store or a run-time environment variable, and CI
uses OIDC trusted publishing or a workflow secret — never anything in-tree.

## Layout

- `apps/cli` — the `notifai` CLI: commands, harness hook adapters,
  config/credential-store handling, unit tests.
- `packages/protocol` — request/response schemas, status vocabulary,
  capability documents, offline draft validation.
- `skills/notifai` — the agent skill: when to notify, how to write for a
  lock-screen banner.
- `docs/BOUNDARY.md` — the boundary policy the gates enforce.

`CLAUDE.md` is a symlink to this file; keep them one document.
