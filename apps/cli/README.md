# notifai

Send native phone notifications from agents and local programs.

An agent working while you are away has no way to reach you, so it either
guesses or sits blocked in a terminal nobody is watching. `notifai` gives
it a way to tell you something finished, and a way to ask you a question
and get your answer back — as a banner on your phone, with buttons.

```sh
npm install -g @raidiant/notifai
notifai init
```

`init` walks the setup one step at a time and tells you the single next
thing to do. Run it again after each step; it works out what remains.

When `--skills` is selected at a human terminal, `init` runs the native
`npx skills` flow so that flow can ask whether the skill belongs to the
project or the machine. An unattended caller must select one explicitly:
`notifai init --skills --skills-scope project` or
`notifai init --skills --skills-scope global`.

## Telling you something happened

```sh
notifai send --title "Deploy finished" --body "staging, 2m14s" --kind done
```

Write for a lock screen. The title gets a couple of seconds of attention
and usually has to carry the whole message; assume the body may never be
read. Long-form content belongs in `--detail`, which never appears on the
banner and is shown in the companion app for when you sit down.

## Asking you a question

```sh
notifai ask "Deploy the migration to production?" --choice "Yes,No"
```

The agent registers the question, ends its turn, and your answer comes
back on its next turn. On iPhone the choices are buttons on the banner
itself.

By default a question stays in your terminal while you are actually at
the keyboard, and only reaches your devices once you have stepped away —
a push you are sitting in front of is just noise. `require_idle = false`
turns that off if you would rather always be notified.

For a harness that cannot resume an idle agent turn, `notifai send
--reply` blocks and waits for the answer instead.

## Agent harnesses

```sh
notifai hooks install
```

Wires question routing into Claude Code, Codex, Cursor or OpenCode. This
is what lets an agent's question reach your phone without the agent
having to cooperate — no question detection, no state in a context window
that compaction will eat.

## Checking it works

```sh
notifai doctor
```

Reports every part of the setup and names where to start if something is
wrong. Any `FAIL` line makes the command exit nonzero; informational `--` lines
do not. `--json` emits the same result with an explicit `exit_code`.

## Reference

`notifai <command> --help` is the exhaustive and current flag surface.
Everything useful is possible non-interactively, so an agent never
reaches a prompt and hangs.

Source, issues and the security policy:
<https://github.com/Raidiant-io/notifai>

Apache-2.0.
