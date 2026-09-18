# Windows/KiCad Native Acceptance

This runbook is the authoritative operational acceptance lane for the CDT-KiCAD
Windows-native provider. It complements the deterministic CI lanes; Linux or
compile-only evidence must never be reported as Windows/KiCad native PASS.

## Required runner

Use an interactive Windows x64 host with:

- KiCad installed and kicad-cli.exe discoverable either on PATH or below
  C:\Program Files\KiCad\<version>\bin.
- Node.js 20 and Git available on PATH.
- The repository checked out at the exact source SHA being accepted.
- A durable provider credential. Preferred: PowerShell SecretManagement secret
  named kicad_mcp_token in a vault that the scheduled user can unlock
  non-interactively. A user/machine-scoped KICAD_MCP_TOKEN is also accepted.
  A transient CI step environment variable is not sufficient for a Task
  Scheduler restart.
- A known immutable fixture identity supplied by the operator. The lane records
  it verbatim; it does not infer engineering meaning from the fixture.

The GitHub workflow expects runner labels:

~~~text
self-hosted, Windows, X64, kicad
~~~

## What counts as PASS

Native PASS requires scripts/native-acceptance.ps1 to complete on the Windows
KiCad host and emit native-acceptance.json. The artifact records:

- exact Windows caption/version/build/architecture;
- exact kicad-cli --version output and executable path;
- exact Git source SHA;
- caller-supplied fixture identity;
- Node version;
- provider name/version;
- provider contract version/hash/protocol version;
- initial and post-restart backend state;
- lifecycle results for install/start/health/stop/restart/reconnect;
- explicit health_semantics = liveness_only_not_backend_readiness.

A GitHub-hosted Windows run without native KiCad, a Linux run, compileall, or a
mocked bridge fixture is useful evidence but is not native PASS.

## Service lifecycle

The service wrapper uses built-in Windows Task Scheduler; no NSSM or external
scheduler framework is required. The scheduled action contains only script
paths/port/host/secret-name metadata. It never places the token in task
arguments or files.

~~~powershell
# Build and register the current checkout.
.\scripts\windows-service.ps1 -Action Install

# Start and wait for GET /healthz.
.\scripts\windows-service.ps1 -Action Start

# Liveness only. This does not claim pcbnew/IPC readiness.
.\scripts\windows-service.ps1 -Action Health

# Inspect scheduled-task state + liveness.
.\scripts\windows-service.ps1 -Action Status

# Stop and require the health endpoint to go down.
.\scripts\windows-service.ps1 -Action Stop

# Stop + start + health.
.\scripts\windows-service.ps1 -Action Restart

# Establish a fresh authenticated MCP session and call the read-only
# help/system_status/get_backend_state tools.
.\scripts\windows-service.ps1 -Action Reconnect

# Cleanup.
.\scripts\windows-service.ps1 -Action Uninstall
~~~

Install runs npm ci and npm run build. Later actions use the resulting build and
do not rebuild.

## Full native acceptance

Run from the repository root:

~~~powershell
.\scripts\native-acceptance.ps1 `
  -FixtureId "fixture:<immutable-id>" `
  -OutputPath "native-acceptance.json"
~~~

The script exercises install → start → health → stop → start → restart →
reconnect, captures the MCP evidence, then stops and unregisters the temporary
acceptance task unless -KeepInstalled is supplied.

The same lane is exposed as the manual GitHub Actions workflow
.github/workflows/native-windows.yml. Its fixture_id input is mandatory and the
emitted JSON is uploaded as the acceptance artifact.

## Queue/load evidence is separate

scripts/queue-load-fixture.mjs drives the real compiled in-process serializer
against a deterministic fixed-delay fake Python boundary at concurrency
1/2/4/8/16. It reports p50/p95 total latency, p50/p95 queue wait, peak heap
delta, error rate, timeout rate, and observed queue depth.

That fixture verifies queue boundedness/instrumentation deterministically; it
does not substitute for the Windows/KiCad native lane.
