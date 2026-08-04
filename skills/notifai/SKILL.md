---
name: notifai
description: Notify the user through NotifAI when work finishes, blocks, or needs their attention. Use for sending native notifications from agents via the notifai CLI and for configuring when/how a user wants to be notified (per project or globally).
---

# NotifAI: notify your user well

NotifAI delivers notifications from agents and local programs to the user's
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

Three implications cover most sends:

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
- **A notification that asks must be able to be answered.** If what comes
  next is a question, put the choices on that same notification with
  `--reply --reply-choice` (add `--no-block` so announcing finished work
  does not hold the turn open). A banner that asks "want me to do X?" with
  no buttons is worse than one that does not ask: it invites a reply the
  surface cannot take, so they return to the terminal anyway.

When there genuinely is more to say — the failing test output, the reasoning
behind a recommendation, the full diff summary — that is what `--detail`
is for. It takes markdown, never appears on the banner, and is rendered in
the companion app's detail view for someone who has chosen to sit down and
read. Use it instead of overstuffing a body the medium will truncate; the
title and body still have to work on their own, because most of the time
they are all anyone sees. `--detail-file` reads it from a file (or `-` for
stdin), which is what you want for a log or a diff.

The wire is more generous than the glance. The contract accepts titles up
to 512 characters and bodies up to 2048, and validation only rejects a
draft whose encoded envelope exceeds the channel's byte ceiling (4096
bytes on APNs). Those are transport limits; the attention budget binds
much earlier. The per-surface numbers below are its local expression on
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
  characters** — on project sends it becomes the bold sender line next to
  the project avatar and truncates around 23 visible characters, so the
  type signal comes first. Types are free-form but stay consistent; the
  common vocabulary is `Done`, `Failed`, `Question`, `Blocked`, `Progress`,
  `Alert`. Examples: "Done · my-app", "Question · api", "Failed · web".
  Per the medium: this line usually IS the notification, so never spend
  its characters on words the glance doesn't need.
- `--body`: the one detail they'd ask for next (counts, durations, error
  gist, branch). Keep it to **one or two short sentences (~150 characters)**
  — banners show ~2 lines, and anything past that may never be read.
  No markdown — plain text on every channel.
- `--session`: your session id — ONE stable opaque id for your current
  session/run, the same everywhere the CLI says "session". The user's device
  renders it as a small deterministic shape+color badge on the project avatar
  so they can tell concurrent agents apart. Exporting `NOTIFAI_SESSION` once
  has the same effect as passing the flag, and is the better habit: `send`
  badges with it, session-scoped config applies by it, and the hooks attribute
  their pushes to it. (`notifai ask` needs no id at all — the hooks record
  which session is working in this directory.)
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
- `--image <path|url|med_id>`: attach an image when it carries real
  information (a chart, a screenshot of the failure).

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
  stopped waiting; `--reply --no-block` sends without blocking at all.
- Both companions can answer. The one difference: on iOS a closed question's
  choices are buttons on the banner itself, and on macOS they are buttons in
  the app, with the banner offering free text. The answer reaches you the same
  way either way, so nothing about how you ask needs to change.

### Asking without blocking (preferred when hooks are installed)

If the user has run `notifai hooks install`, prefer `notifai ask` over a
blocking `--reply` send:

```bash
notifai ask "Which environment should I deploy to?" --choice "Staging,Production,Cancel"

# A label containing a comma MUST use a repeated flag — a single value splits
# on commas, so "Yes, ship it,No" silently becomes three choices.
notifai ask "Ship it?" --choice "Yes, ship it" --choice "No, hold"
```

It returns immediately and needs no session id from you — the hook records
which session is working in this directory. Ask the same question in the
conversation and end your turn as you normally would. Then:

- **User is at the keyboard** — nothing is sent. They answer in the terminal.
  Absence is the machine's own idle time exceeding `away_after_seconds`, so a
  long turn they are watching does not count, and a session spawned while they
  were already gone still escalates.
- **User is away** — the question waits in the terminal for `ask_grace_seconds`
  (default 300, counted from when you ran `ask`) and only then goes to their
  devices. If they come back mid-wait it is abandoned and nothing is sent.
  Their answer resumes your turn as if they had typed it.
- **Pushed but not answered in time** — the hook stops waiting after
  `hook_reply_timeout_seconds` (default 180), but the question stays
  answerable on their devices for up to an hour. If your next turn starts
  without an answer in it, check the hook's transcript note for the request
  id and run `notifai replies <request_id>` before re-asking — the answer
  may already be there. Never register the same question again while the
  first is still live; that is nagging, and superseding it discards the
  answer window the user may be mid-way through using.

This is strictly better than blocking: no wasted wait when they are present, no
dead session when they are not. Use the blocking `--reply` form only when hooks
are not installed, or when you need the answer mid-turn rather than at its end.

Answering from a device does not mark the user as present — only typing in the
terminal does. That is intended: answering on a phone is evidence they are away
from the keyboard, not at it.

Do not call `notifai ask` and then keep working — register the question and
stop. A question the user cannot answer before you act on it is worse than not
asking.

### Configuring it

`notifai config show --explain` prints every value and which layer set it.
Precedence, most specific first: **flag > session > `.notifai/config.local.toml`
(gitignored) > `.notifai/config.toml` (committed) > machine-global > default**.

When the user asks for a change, write it to the right layer and never guess:

```bash
notifai config set ask_notifications false --local --yes   # this project, just them
notifai config set away_after_seconds 300 --yes            # this machine
notifai config set ask_grace_seconds 600 --yes             # wait 10min first
```

"Don't notify me so fast" means `ask_grace_seconds` (how long a question sits
in the terminal first). "Stop deciding I've left when I'm just reading" means
`away_after_seconds` (how much silence counts as absence). "Give me longer to
answer on my phone" means `hook_reply_timeout_seconds` (how long a pushed
question blocks waiting for the answer, default 180 — the question itself
stays answerable on the device long after the wait stops). They are different
dials and the user's phrasing usually names one of them.

Use `--local` rather than `--project` for anything expressing a personal
preference; `--project` is committed and shared with everyone on the repo.
Only write config when the user actually asked for a behaviour change — never
in reaction to a timeout or an unanswered question.

### Verifying delivery

`notifai send` waits briefly and prints a receipt; use `--json` for machine
parsing and `notifai status <request_id>` for the full evidence trail. Exit
code 1 means rejected everywhere — surface that instead of assuming delivery.

## Setup in a new project

`notifai init` is the one command to point the user at. It is idempotent —
observing what is already set up and acting only on the gap — so re-running it
is also how you check a setup. It covers: signing in, the project identifier,
this skill, and the harness hooks, then reports device readiness or says
"all set".

It behaves differently depending on who runs it, on purpose:

- **The user, at a terminal** — it walks them through the missing steps
  interactively (including `notifai login`, which opens a browser only they
  can approve). When setup is needed, prefer telling the user to run
  `notifai init` themselves over assembling the pieces for them.
- **You, the agent** — it never prompts and never installs anything optional
  unattended. Anything it would have asked is a flag: `--skills` installs this
  skill, `--hooks` installs the harness hooks, `--no-skills`/`--no-hooks`
  silence the hints. It prints the steps only the user can do (signing in,
  pairing a device) as exact commands — relay those instead of retrying.
  This is true of the CLI generally: interactive affordances only ever appear
  for a human at a TTY, and every operation has a non-interactive form. Do not
  deliberately seek out interactive paths; if a command seems to hang, you have
  found a bug, not a prompt worth answering (`NOTIFAI_NO_INPUT=1` force-kills
  all interactivity).

```bash
notifai init            # idempotent one-stop setup; add --skills / --hooks when unattended
notifai hooks install   # just the hooks: route away-questions to their devices
notifai doctor          # full evidence trail: credential, server, devices, hooks
```

`hooks install` wires the harness (Claude Code, Codex, or OpenCode) so a
question you registered with `notifai ask` reaches the user's phone **only**
when they have gone quiet. It changes nothing while they are at the keyboard.
Suggest it once; do not install it without being asked.

**The session that installs the hooks can never use them.** A harness reads its
hooks once, at session start, so hooks you install now stay inert for the rest of
this session however long it lasts — `notifai ask` will tell you the session is
unknown, and it is right. Say this to the user when you install: they need to
restart the harness and send one prompt. Do not retry the ask, and do not invent
a `--session` id to get past it.

On Codex, hooks must additionally be approved: Codex trusts hooks by content
hash and silently skips untrusted ones — it reports the hook event as completed
either way, so there is no runtime signal. Tell the user to start Codex once
interactively and accept the prompt.

Codex also reads project hooks from the **main repository**, not the working
directory, so in a git worktree `hooks install` writes to the main checkout and
covers every worktree of that repo. It says so when it does.

On OpenCode the adapter is a generated plugin file rather than an entry in a
settings document. NotifAI owns that whole file: install refuses to overwrite a
plugin it did not write, and uninstall removes only its own. The same restart
rule applies — OpenCode loads plugins once at start.

`notifai doctor` answers "will this actually work?" without a live test: it
reports the credential, server, devices, where hooks are installed, whether any
session has ever run them here, whether an old build left a handler behind, and
whether Codex trusts ours. Run it before concluding that notifications are
broken. If it reports a missing credential, the user must run `notifai login`
themselves (it opens a browser approval).

Keep wording channel-neutral: the same notification may surface on a phone,
a desktop, or a future chat channel — never phrase content as "tap here" or
assume a specific device.
