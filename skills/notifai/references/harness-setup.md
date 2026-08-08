# Harness setup and recovery

This reference contains per-harness mechanics for `notifai ask`. Read it only
when installing hooks, diagnosing activation, or recovering question routing.

## Install deliberately

Suggest hooks once; do not install them without being asked.

```bash
notifai hooks install
notifai doctor
```

A machine-global Notifai skill is guidance, not routing evidence. The active
harness needs its own installed hook and a current session pointer.

Before the first `notifai ask` in a new harness session, `doctor` must name the
active harness under **Question routing** and report under **hooks (fired)**
that a session in this directory ran the hooks. The check is fail-closed against
the exact active session identity where the harness exports one. Do not invent
`--session` to bypass it.

## Activation by harness

- **Claude Code:** project hook files reload without a restart. Send one new
  prompt so the hook publishes the session pointer, then run `notifai doctor`.
- **Codex:** run `notifai hooks install --harness codex`, send one new prompt,
  then run `notifai doctor`. Codex resolves project hooks from the main
  repository. In a linked worktree, the installer writes the shared file to
  the main checkout and creates the project-layer `.codex` directory in the
  current worktree; run it once in each new worktree.
- **Cursor:** send one prompt and run `notifai doctor`. If no hook has fired,
  start a new session and check again. A companion answer becomes one bounded
  native follow-up message.
- **OpenCode:** restart after installation because plugins load at startup.
  Notifai owns its generated plugin file and will not overwrite a foreign one.
  The idle event can push a question but cannot resume the idle turn; the next
  user prompt collects the answer. Use blocking `send --reply` when the answer
  must return before another prompt.

Do not claim support for a harness that is absent from
`notifai hooks install --help`.

## Presence and continuation

With `require_idle = true` (default), local keyboard or mouse activity keeps a
question in the terminal. Once the user is away, the terminal-first grace
window runs before any device push. If the OS idle signal is unavailable,
prompt silence is the conservative fallback.

`require_idle = false` deliberately permits a push while the user is working;
set it only on the user's request. A remote answer proves reachability, not
that the user returned to the terminal.

The important timing settings are separate:

- `away_after_seconds`: how much local silence counts as absence.
- `ask_grace_seconds`: how long the question remains terminal-first.
- `hook_reply_timeout_seconds`: how long a pushed hook waits for the answer.

The pushed question can remain answerable after the hook stops waiting. Recover
with `notifai replies --pending`; do not re-register it as a nag. Retire an
obsolete question with `notifai close <request_id>`.

## Bounded recovery

Follow the exact `notifai doctor` diagnostic. Common recovery is one install or
restart, one new prompt, and one new doctor check. Stop if the current pointer
belongs to another active session or if the hook still has not fired; ask the
user or coordinator instead of retrying indefinitely.

If credentials are missing, the user must run `notifai login`; it opens a
browser approval. If a companion device is missing, the user must open a
supported companion build, sign in, and grant notification permission. An
agent must not emulate either action or treat Provider Acceptance as Companion
Receipt proof.
