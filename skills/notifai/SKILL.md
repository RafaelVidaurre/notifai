---
name: notifai
description: Notify the user through Notifai when work finishes, blocks, or needs their attention. Use for sending native notifications from agents via the notifai CLI and for configuring when/how a user wants to be notified (per project or globally).
---

# Notifai: notify your user well

Notifai delivers notifications from agents and local programs to the user's
devices (and, in the future, other channels such as chat bots). You interact
with it through the `notifai` CLI. This skill covers two jobs:

1. Deciding **when** to notify — respecting the user's configured criteria.
2. Composing notifications that are **useful at a glance**.

## Writing for the medium

A notification lands as a banner on a lock screen or the corner of a
desktop: one or two lines of text, a couple of seconds of attention, often
while the user is doing something else. That is the medium you are writing
for — a glance, not a read. Every length budget in this skill is a
consequence of that, not a formatting rule. If a future channel gives the
user more room, its budget grows with the attention it gets; if it gives
less, write shorter. Derive the length from the glance, not from a
memorised number.

Four implications cover most sends:

- **The title is the whole message for most notifications.** The user
  often sees only the title; the body is frequently never read. The title
  must be actionable on its own, and the body must add to it — never hold
  information the notification only makes sense with.
- **A question must be answerable without opening anything.** If answering
  requires reading the transcript or checking a diff, the question is in
  the wrong medium — put what they need to decide in the notification
  itself.
- **A completion notice must name what comes next** concretely enough to
  approve from a phone. "Done." sends them back to the terminal to find
  out what to do next, which is the thing the notification was meant to
  save them.
- **A notification that asks must be able to be answered.** A banner that
  asks "want me to do X?" with no buttons is worse than one that does not
  ask: it invites a reply the surface cannot take, so they return to the
  terminal anyway.

  So do not bolt a question onto a completion notice. Announce the finished
  work with `send`, and ask with `notifai ask --choice` — it puts the same
  buttons on the banner *and* the turn-end hook returns the answer to you.
  `send --reply` is for when you are waiting right now; it blocks. There is
  no third mode where you ask and nobody listens, and the CLI rejects the
  attempt rather than letting the user tap a button that does nothing.

When there genuinely is more to say — the failing test output, the reasoning
behind a recommendation, the full diff summary — that is what `--detail`
is for. It accepts markdown source, never appears on the banner, and is shown
in the companion app's detail view for someone who has chosen to sit down and
read; rendering fidelity depends on the companion surface. Use it instead of
overstuffing a body the medium will truncate. The title and body still have to
work on their own, because most of the time they are all anyone sees.
`--detail-file` reads it from a file (or `-` for stdin), which is what you want
for a log or a diff.

The wire is more generous than the glance. The schema accepts titles up to
512 characters and bodies up to 2048, while APNs also imposes a 4096-byte
encoded-envelope ceiling. Schema and platform-capability checks can reject a
draft for other reasons too. Those are transport limits; the attention budget
binds much earlier. The per-surface numbers below are its local expression on
the current companion apps.

## When to notify

Check the user's criteria first:

```bash
notifai config show --json
```

The `notify_criteria` value is free-text guidance written by the user (project
config wins over machine-global). Follow it literally. If it is null, apply
these defaults:

- Notify when a long-running task (> a few minutes) finishes, succeeds or fails.
- Notify when you are blocked on input only the user can provide.
- Notify on errors or findings that need attention soon, not eventually.
- Do NOT notify for routine progress, intermediate steps, or things the user
  will see anyway in the next few seconds.

To capture or change the user's preference (ask them, then persist it):

```bash
# Per project (wins; commit .notifai/config.toml if the team shares it)
notifai config set notify_criteria "Only when blocked or when CI-length tasks finish" --project --yes

# Machine-global fallback
notifai config set notify_criteria "Anything that needs me within the hour" --yes
```

## Sending

```bash
notifai send \
  --title "Done · my-app" \
  --body "All 42 tests passed in 3m 10s." \
  --event tests_passed \
  --project my-app \
  --session "$NOTIFAI_SESSION" \
  --sound done
```

- `--title`: format it **`<Type> · <project>`** and keep it **under ~22
  characters**. Treat that as a writing heuristic, not a transport limit: on a
  communication-style project surface it may become the narrow sender line next
  to the project avatar, while other surfaces retain ordinary title treatment
  and exact truncation varies by OS and device. It must stand alone everywhere.
  Put the type signal first. Types are free-form but stay consistent; the common
  vocabulary is `Done`, `Failed`, `Question`, `Blocked`, `Progress`, `Alert`.
  Examples: "Done · my-app", "Question · api", "Failed · web".
  Per the medium: this line usually IS the notification, so never spend
  its characters on words the glance doesn't need.
- `--body`: the one detail they'd ask for next (counts, durations, error
  gist, branch). Keep it to **one or two short sentences (~150 characters)**
  — banners commonly expose only a small number of lines, varying by surface,
  and anything past that may never be read.
  No markdown — current native banners treat it as plain text.
- `--session`: your session id — ONE stable opaque id for your current
  session/run, the same everywhere the CLI says "session". Surfaces that render
  project/session identity use it as a small deterministic shape+color badge on
  the project avatar so concurrent agents are distinguishable; not every native
  banner offers that presentation. Exporting `NOTIFAI_SESSION` once has the same
  effect as passing the flag, and is the better habit: `send` carries it,
  session-scoped config applies by it, and the hooks attribute their pushes to
  it. (`notifai ask` needs no id after a hook has run in this directory; the hook
  records which session is working here.)
- `--event`: stable machine-readable name (`tests_passed`, `deploy_failed`,
  `input_needed`). Free-form but be consistent within a project.
- `--project`: project identifier slug (lowercase letters, digits, `.`, `_`,
  `-`). Prefer setting it once via `notifai config set project <slug> --project`
  so every send from the repo carries it. Projects register lazily server-side;
  there is no setup step.

### Semantics that shape attention

- `--kind update|done|question`: what this notification **is**. `done` when a
  body of work finished — the app badges it, so a day's arrivals show at a
  glance which ones were accomplishments. `update` is the default and is the
  honest answer for progress, status, and anything still in flight; don't
  reach for `done` to make a message feel more important. You never pass
  `question`: `--reply` already is one, and declaring it without a reply
  window is rejected.
- `--sound done|attention|alert|default|none`: `done` for completions,
  `attention` when input is needed, `alert` for failures. `none` is silent.
- `--level passive|active|time_sensitive`: `passive` for FYI (no wake),
  `time_sensitive` only when acting late loses value.
- `--thread-id <id>`: group related notifications (e.g. one id per pipeline).
- `--collapse-key <key>`: replace an earlier notification instead of stacking
  (e.g. progressive status where only the latest matters).
- `--image <path|url|media_id>`: attach an image when it carries real
  information (a chart, a screenshot of the failure). This is capability-
  dependent: current macOS delivery omits remote images and preserves the text
  notification. Check `notifai capabilities --platform <platform>` before an
  image is essential to the message.

### Asking the user a question

When you are genuinely blocked on something only the user can decide, add
`--reply`. The notification gains an inline reply field, and the command
**blocks** until they answer:

```bash
answer=$(notifai send \
  --title "Question · api" \
  --body "Migration 0007 is destructive. Run it on prod now, or hold for the window?" \
  --project api --sound attention --reply --reply-timeout 900)
```

- Use it only for `Question` / `Blocked` notifications. Every other send stays
  a one-way notification — do not attach a reply field to work you are not
  actually waiting on.
- Ask something answerable **without opening anything, in one sentence
  typed on a phone keyboard**. Offer the two or three options in the body
  rather than asking open questions.
- State the default in the body when there is one ("holding unless you say
  otherwise") so silence is still informative.
- `--reply-timeout <seconds>` (default 900) bounds the wait. **Exit code 3
  means "no reply yet", not failure** — the reply window stays open. Handle it
  by continuing with the default you stated, and say plainly which assumption
  you took. Do not re-notify to nag.
- `notifai replies <request_id>` retrieves an answer that arrived after you
  stopped waiting. Reaching for it means holding a request id across turns,
  so prefer `notifai ask`, which hands the answer back without one.
- Both companions can answer. The one difference: on iOS a closed question's
  choices are buttons on the banner itself, and on macOS they are buttons in
  the app, with the banner offering free text. The answer reaches you the same
  way either way, so nothing about how you ask needs to change.

### Asking without blocking (on continuation-capable harnesses)

If the user has run `notifai hooks install`, passed the active-harness preflight
below, and the harness can continue from a device answer, prefer `notifai ask`
over a blocking `--reply` send.

Before the first `ask` in a new project or harness session, run `notifai
doctor`. The **Question routing** line must name the harness you are actually
running in, and **hooks (fired)** must say a session in this directory ran
them. An installed skill or hooks for a different harness do not satisfy that
preflight. If doctor names a missing active-harness installation, an unfired
hook, or a pointer owned by another session, follow its exact bounded recovery
and do not register the question yet. In Codex this check is fail-closed against
`CODEX_THREAD_ID`, so a stale Claude Code or previous-Codex pointer cannot
silently receive the question.

```bash
notifai ask "Which environment should I deploy to?" --choice "Staging,Production,Cancel"

# A label containing a comma MUST use a repeated flag — a single value splits
# on commas, so "Yes, ship it,No" silently becomes three choices.
notifai ask "Ship it?" --choice "Yes, ship it" --choice "No, hold"
```

It returns immediately. After the prompt hook has run in this directory it
needs no session id from you, because that hook records the current session.
Ask the same question in the conversation and end your turn as you normally
would. Then:

- **User is at the keyboard** — with the default `require_idle = true`, nothing
  is sent and they answer in the terminal. Presence comes from keyboard/mouse
  idle time, not whether the thread is visible: merely reading without input
  past `away_after_seconds` does count as away. Set `require_idle = false` only
  when the user explicitly wants questions pushed while they are working. On an
  OS where that idle signal is unavailable, prompt silence is the conservative
  fallback; after it decides the user is away, the hook skips the blocking grace
  because it cannot observe them returning during that wait.
- **User is away** — the question waits in the terminal for `ask_grace_seconds`
  (default 300, counted from when you ran `ask`) and only then goes to their
  devices. If they come back mid-wait it is abandoned and nothing is sent.
  On Claude Code, Codex, and Cursor, their answer resumes your turn as if they
  had typed it. The OpenCode adapter routes `session.idle` into the same question
  hook, but OpenCode exposes no reliable way for that event to re-enter an idle
  agent loop with the answer; use the blocking `--reply` form there when the
  answer must reach the agent.
- **Pushed but not answered in time** — the hook stops waiting after
  `hook_reply_timeout_seconds` (default 180), but the question stays
  answerable on their devices for up to an hour. On Claude Code, Codex, and
  Cursor, if your next turn starts without an answer in it, check the hook's
  transcript note for the request id and run `notifai replies <request_id>`
  before re-asking — the answer may already be there. Never register the same
  question again while the first is still live; that is nagging, and
  superseding it discards the answer window the user may be mid-way through
  using.

On harnesses with answer continuation this avoids a wasted wait when the user is
present and a dead session when they are not. Use the blocking `--reply` form
when hooks are not installed, on OpenCode, or when you need the answer mid-turn
rather than at its end.

Answering from a companion device does not mark the user as present — only local
keyboard or mouse activity does. A remote answer is evidence of reachability,
not evidence that the user returned to the terminal.

Do not call `notifai ask` and then keep working — register the question and
stop. A question the user cannot answer before you act on it is worse than not
asking.

### Configuring it

`notifai config show --explain` prints every value and which layer set it.
Precedence, most specific first: **flag > session > `.notifai/config.local.toml`
(personal; keep it gitignored) > `.notifai/config.toml` (shared; commit it when
that is the team's intent) > machine-global > default**. The CLI writes the
selected file but does not change ignore rules or create a commit.

When the user asks for a change, write it to the right layer and never guess:

```bash
notifai config set ask_notifications false --local --yes   # this project, just them
notifai config set away_after_seconds 300 --yes            # this machine
notifai config set ask_grace_seconds 240 --yes             # wait 4min first
```

"Don't notify me so fast" means `ask_grace_seconds` (how long a question sits
in the terminal first). "Stop deciding I've left when I'm just reading" means
`away_after_seconds` (how much silence counts as absence). "Give me longer to
answer on my phone" means `hook_reply_timeout_seconds` (how long a pushed
question blocks waiting for the answer, default 180 — the question itself
stays answerable on the device long after the wait stops). They are different
dials and the user's phrasing usually names one of them.

The effective grace window yields to the reply wait so the whole Stop hook
stays inside its 480-second budget. With the default 180-second reply wait, a
configured grace above 300 seconds still runs for at most 300 seconds.

Use `--local` rather than `--project` for anything expressing a personal
preference, and ensure `.notifai/config.local.toml` is ignored. `--project`
writes the file intended for committed, shared configuration; the CLI does not
commit it. Only write config when the user actually asked for a behaviour
change — never in reaction to a timeout or an unanswered question.

### Verifying delivery

`notifai send` waits briefly and prints a receipt; use `--json` for machine
parsing and `notifai status <request_id>` for the full evidence trail. A receipt
whose `overall` value is `provider_rejected_all` makes `send` exit 1. Other
pre-receipt failures can also be nonzero, so branch on the structured result or
the diagnostic rather than treating every exit 1 as the same failure.

The send receipt reports queue/provider progress only. In `status`, Provider
Acceptance and `companion_receipt` are separate fields: `observed` means a
Companion App process or extension reported the Delivery, while `unknown`
means no Companion Receipt has been observed. Unknown is not a timeout or a
failure, no matter how many seconds have elapsed; Companion Receipts are
best-effort and can arrive minutes later. Never infer display or human attention
from either Provider Acceptance or a Companion Receipt.

## Setup in a new project

`notifai init` is the setup coordinator to point the user at. It is idempotent
for the setup it can perform, so re-running it is also a useful check. It covers
sign-in, the project identifier, optional harness hooks, device readiness, and
one real verification notification. Setup becomes ready only after the CLI
observes that notification's Companion Receipt; Provider Acceptance alone is
not enough. The request id is saved in machine-local state, so a partial run
rechecks the same notification instead of sending another one.
`--skills` installs this skill from the immutable public `v0.1.8` tag. The
source uses the skills installer's ref syntax
`RafaelVidaurre/notifai#v0.1.8`; `owner/repo@name` means a skill selector, not
a Git ref. In an interactive init, the native `npx skills` UI owns the
project-local versus machine-global choice, placement, links, provenance, and
updates; `notifai` waits for it and then resumes the remaining setup.

It behaves differently depending on who runs it, on purpose:

- **The user, at a terminal** — it walks them through the missing steps
  interactively (including `notifai login`, which opens a browser only they
  can approve). When setup is needed, prefer telling the user to run
  `notifai init` themselves over assembling the pieces for them.
- **You, the agent** — it never prompts and never installs anything optional
  unattended without an explicit choice. `--hooks` installs the harness hooks
  and `--no-hooks` silences that hint. `--no-skills` silences the skill hint;
  `--skills` requires `--skills-scope project` or `--skills-scope global`, then
  delegates the non-interactive install/update to native `npx skills`. It never
  turns a user's personal machine-global preference into a product default. It
  prints the steps only the user can do (signing in, pairing a device) as exact
  commands — relay those instead of retrying. Cancellation or an optional skill
  failure is reported, but does not stop independent remaining setup. A
  remaining blocker exits nonzero, so branch on the exit status rather than
  parsing the prose. When every prerequisite is ready, the non-interactive path
  may send the one receipt-backed setup verification; it never asks first or
  sends a second notification while that request remains recorded.
  This is true of the CLI generally: interactive affordances only ever appear
  for a human at a TTY, and every operation has a non-interactive form. Do not
  deliberately seek out interactive paths; if a command seems to hang, you have
  found a bug, not a prompt worth answering (`NOTIFAI_NO_INPUT=1` disables all
  interactivity).

```bash
notifai init            # idempotent setup coordinator and receipt-backed live proof
notifai hooks install   # just the hooks: route registered questions to their devices
notifai doctor          # readiness + saved-proof audit; never sends a probe
```

When no Device Installation exists, the current release has no supported App
Store/TestFlight URL or device-pairing endpoint for the CLI to turn into a QR
code. `init` says that explicitly instead of printing a placeholder. If the
user already has a supported companion build, interactive `init` can wait on
the real device registry while they open it, sign in, and grant permission;
unattended `init` reports that single action and exits nonzero without waiting
on a prompt.

`hooks install` wires the harness (Claude Code, Codex, Cursor, or OpenCode) so a
question you registered with `notifai ask` reaches the user's devices after the
terminal-first grace window. With the default `require_idle = true`, it only
pushes after they have gone quiet; `require_idle = false` deliberately allows
pushes while they are working. Suggest it once; do not install it without being
asked. A machine-global Notifai skill is agent guidance, not harness routing:
its presence never proves that the active harness has hooks or a current
session pointer.

Hook activation differs by harness. Claude Code reloads project hook files
without a restart; send one new prompt after installation so the hook can
publish the session pointer. For Cursor and Codex, send one prompt and check
`notifai doctor`; if `hooks (fired)` still says no hook ran, start a new
session. OpenCode loads plugins at startup and must restart first. Do not retry
the ask or invent a `--session` id just to bypass missing activation evidence.

Codex also resolves a project hooks file from the **main repository**, while it
discovers whether a project layer exists by walking up from the current
worktree. In a linked worktree, `hooks install` writes the shared file to the
main checkout and creates a `.codex` directory in the current worktree. Other
worktrees need that directory too; run the installer once from each new
worktree rather than assuming one install activates all of them.

On OpenCode the adapter is a generated plugin file rather than an entry in a
settings document. Notifai owns that whole file: install refuses to overwrite a
plugin it did not write, and uninstall removes only its own. The same restart
rule applies — OpenCode loads plugins once at start. Its current `session.idle`
event is wired to question routing but has no reliable Stop-style continuation,
so a device answer does not automatically resume the agent; use `send --reply`
for a decision that must return.

On Cursor the adapter uses the native flat hook schema. A companion-device
answer becomes one native `followup_message`, and the installed stop hook sets
`loop_limit = 1` so an answer cannot turn into repeated automatic turns. Do not
claim another harness is supported unless it appears in
`notifai hooks install --help`.

`notifai doctor` audits readiness without sending a probe: its checks cover the
credential, server, contract version, devices, saved Companion Receipt proof,
where hooks are installed,
whether a session has run them here in the last 24 hours, and whether an old
build left a stale handler behind. Network-dependent checks appear only when
their prerequisites are reachable. It can re-read evidence for the verification
request that `init` saved; it cannot create proof by itself. Run it before
concluding that notifications are broken. If it reports a missing credential,
the user must run `notifai login` themselves (it opens a browser approval).

Keep wording channel-neutral: the same notification may surface on a phone,
a desktop, or a future chat channel — never phrase content as "tap here" or
assume a specific device.
