# Telemetry & privacy

Tracegrab is a tool for *verifying* code behavior, so we hold our own data handling to
the same standard. This document is the complete, honest statement of what the
open-source Tracegrab tool does and does not collect.

## What the tool collects today

**Nothing.** The open-source extension, MCP server, and CLI do not phone home. No
usage pings, no analytics, no crash reports are sent anywhere by default.

## If in-tool telemetry is ever added

It will follow these rules, without exception:

- **Opt-in and off by default.** You will see a one-time, dismissable prompt; nothing
  is sent unless you explicitly turn it on.
- **Anonymous.** No account, no identity, no fingerprint.
- **Respects VS Code's global setting.** If `telemetry.telemetryLevel` is `off`,
  Tracegrab sends nothing regardless of its own setting.
- **Never sensitive data.** Source code, variable values, file paths, URLs, and
  anything captured from your debuggee **never leave your machine**. Captured runtime
  values are redacted before they even touch disk (`src/redact.ts`).
- **Fully documented.** Every event we would send is listed in this file before it
  ships, so you can read exactly what a ping contains.
- **A visible setting to turn it off** at any time.

## Local artifacts

Runtime output under `.flow-debugger/` (traces, mocks, generated tests, license)
stays on your machine and is git-ignored. It is never transmitted.

## Hosted / team product

The paid, hosted team product is a separate service you explicitly sign up for, with
its own privacy policy. Its analytics (seat counts, usage) exist to run the service
you purchased and are governed by that agreement — not by this open-source tool.

Questions or concerns: open an issue.
