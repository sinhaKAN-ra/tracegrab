# Security

This tool can **read and mutate the state of a running process** — set/inspect
variables, evaluate expressions, and stub methods. That power is deliberately
constrained. This document is the security model and the reporting process.

## Threat model

The tool runs locally, inside the developer's editor, against a debug session
the developer started. The main risks are:

1. **Secret exposure** — runtime variables may hold tokens, keys, passwords, and
   those values flow to an AI agent's context (and possibly its provider).
2. **Unintended mutation** — an agent editing a live variable or stubbing a
   method could change program behaviour in a way the human did not intend.
3. **Over-broad reads** — dumping all of scope hands an agent unrelated process
   state it never asked for.

## Controls (on by default)

### Secret redaction
Every value that reaches an agent — inspector, `get_pause_state`, `get_call_map`,
`evaluate_expression`, reports — is scanned and masked before it leaves the host:
- **By name:** `token`, `secret`, `password`, `api_key`, `authorization`,
  `cookie`, `credential`, `private_key`, `access_key`, `client_secret`, `session_id`.
- **By shape:** JWT, AWS access keys, PEM private keys, bearer tokens, GitHub
  PATs, Slack tokens, long hex/base64 blobs.
- **Never masked:** empty / null / undefined — so "my token is empty" stays debuggable.
- Redacted values are also made non-expandable so children can't leak the value.
- Off switch (self-host/trusted only): `FLOW_NO_REDACT=1`.

### Propose-then-confirm on every live mutation
`debug_set_variable`, write-form `evaluate_expression`, and boundary-mock
injection are **previewed** by default: the first call returns the current value
and a `confirmToken`; nothing changes until a second call supplies that token.
Autonomous/trusted flows may pass `confirm: true` to skip the preview.

### Least-privilege reads
`get_variable_values` requires an explicit name list (max 50, no wildcards) and
returns only those. `list_variable_names` returns names/types with no values, so
an agent can discover before it reads.

### Audit trail
Every live mutation appends to `.flow-debugger/audit.ndjson`
(`actor`, `action`, `target`, `before`, `after`, `sessionId`, timestamp). Read it
via the `get_audit_log` MCP tool. Nothing mutates without a line.

### Fail-closed mocking
With `strictMocks` on, a boundary mock that fails to inject **aborts the run**
rather than silently hitting the real database/dependency.

## What the tool does NOT do

- It does not phone home. All processing is local; the only egress is whatever
  MCP client the user connected.
- It does not persist secrets — redaction happens before values are written to
  disk (captures, reports, audit).
- It does not modify source code. Mutations are runtime-only and are reverted
  when the session ends.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Email the
maintainers (see MAINTAINING.md) with:
- a description and impact,
- steps to reproduce,
- affected version/commit.

We aim to acknowledge within 72 hours and to ship a fix or mitigation before any
public disclosure.

## Hardening checklist for contributors

Before merging any change that touches variable values, evaluation, or mocking:
- [ ] Does every new value-bearing path go through `redact.ts`?
- [ ] Does every new mutation go through propose-then-confirm + `audit()`?
- [ ] Does a new read tool take an explicit allow-list, not a dump?
- [ ] No secret is logged, echoed, or written to disk unredacted.
- [ ] `npm audit` clean (no known-vulnerable dependencies).
