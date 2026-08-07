# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's [private
vulnerability reporting](https://github.com/RafaelVidaurre/notifai/security/advisories/new)
on this repository. Do not open a public issue for a suspected
vulnerability.

Expect an acknowledgement within a few days. If you have not heard back
within a week, please open a public issue saying only that you are
waiting on a security response — with no details of the issue itself.

## Supported versions

Notifai is pre-1.0. Only the latest published version receives fixes.

## Scope

This repository is the client surface: the CLI, the wire contract, and
the agent skill. The service and companion apps live elsewhere.

A report about **this repository** is in scope if it concerns the CLI or
the protocol types — for example credential handling on disk, a hook
adapter writing somewhere it should not, or a draft that passes local
validation but should not.

A report about **the service** is still welcome here, through the same
private channel, and will be routed onward.

## Design notes that may save you a report

These are deliberate, and knowing them may tell you whether what you
found is a finding.

**The service must remain secure when everything in this repository is
fully known.** Nothing here is a shared secret, and there is no security
value in any part of this tree being unread. If you find something whose
safety depends on this code being private, that *is* a vulnerability and
we want to hear about it.

**Machine credentials are stored per-machine, not in the repository.**
On macOS they go to the Keychain; the file fallback is written `0600`. A
credential is scoped to one machine and can be revoked without affecting
others.

**A Companion Receipt proves delivery to a device, not display to a
person.** It is deliberately not evidence that anyone saw anything.

**Harness hooks run with the user's own privileges** and are installed
only by explicit action. The CLI does not install hooks without being
asked, and does not edit a repository's ignore rules or create commits.
