# SlncTrZ-MCP Integration — CDT-KiCAD (`kicad`)

**Stable package:** `0.1.3` / `v.0.1.3`; API contract remains `cdt-kicad-contract-v2`. See [release & deployment](RELEASE_AND_DEPLOYMENT.md) for credential-safe upgrade/rollback. A source tag does not prove a running gateway update.

> Companion to `MCP_PROVIDER_STANDARD.md` (Draft v0.2) and the runtime
> `docs/TOOL_GUIDE.md`. The `help` tool is authoritative at runtime; this
> file is the static gateway-wiring reference.

## Endpoint & auth

| Item                     | Value                                                       |
| ------------------------ | ----------------------------------------------------------- |
| Provider ID              | `kicad`                                                     |
| Network endpoint         | `POST http://<host>:3100/mcp` (Streamable HTTP)             |
| Health                   | `GET http://<host>:3100/healthz` (unauthenticated liveness) |
| Primary credential       | `Authorization: Bearer <token>`                             |
| Compatibility credential | `X-API-Key: <token>` (same single auth layer)               |
| Token source             | `KICAD_MCP_TOKEN` env / secret manager, never Git           |
| Failure codes            | `401` missing/invalid identity · `403` denied               |
| Local mode               | STDIO (`node dist/index.js`), no token, process-local       |

## Gateway catalog

Bare provider tools canonicalize to `kicad.<tool>` (idempotent when already
canonical). Minimum wiring:

```text
kicad.help
kicad.system_status
kicad.system_capabilities
kicad.open_project / kicad.create_project
kicad.save_project / kicad.close_project
kicad.run_drc / kicad.get_drc_violations / kicad.run_erc
```

Discovery at runtime: `kicad.list_tool_categories` →
`kicad.get_category_tools` / `kicad.search_tools`. Every tool is callable by
name; discovery never gates execution.

## Contract drift detection

After `help`, pin `contract_hash` (SHA-256 over `docs/TOOL_GUIDE.md`).
Re-fetch `help` when the hash changes; the current discovery/help/tool contract is
`cdt-kicad-contract-v2`. A changed hash means the served contract content
changed even when a future additive revision keeps the same major contract line.

## Refusals the gateway must expect

- `unsupported_capability` (`retryable: false`): transactions/undo and any
  IPC-only capability while the file-based SWIG backend is active.
- `timeout`: bounded autoroute/export budgets; a timeout is NOT proof of
  cancellation — the gateway should re-query state before retrying.

## Serialized bridge queue bounds

The existing Node→Python serializer remains one-at-a-time; A5 adds bounded
waiting instead of a second scheduler/broker.

- `KICAD_MCP_MAX_QUEUE_DEPTH` — maximum waiting requests (default `32`);
  overload is refused as retryable `rate_limited`.
- `KICAD_MCP_ENQUEUE_DEADLINE_MS` — maximum queue wait before dispatch
  (default `120000` ms); expiry is retryable `timeout`.
- Terminal bridge events are emitted as structured `bridge_metric` JSON with
  `queue_depth`, `queue_wait_ms`, `execution_ms`, `total_latency_ms`,
  and cumulative timeout/error/rejection counts.
- `npm run test:queue-load` is the deterministic 1/2/4/8/16 caller load
  fixture. It is serializer/load evidence, not Windows/KiCad native evidence.

## Windows-native deployment (no Docker)

The currently accepted KiCad native/GUI lane uses a Windows process — no
container image is shipped. KiCad/pcbnew itself is not inherently Windows-only;
a Linux lane requires separate acceptance. Standard §13 Docker expectations
do not apply to this native Windows deployment; equivalent controls follow.

```powershell
npm run build
$env:KICAD_MCP_TOKEN = (Get-Secret kicad_mcp_token)  # secret manager, never a file
$env:MCP_TRANSPORT = "both"; $env:MCP_PORT = "3100"
node dist/index.js
.\scripts\check-health.ps1 -Port 3100
```

- Persistence: use the built-in Task Scheduler lifecycle in
  `scripts\windows-service.ps1`; it supports install/start/health/stop/
  restart/reconnect without a third-party scheduler wrapper.
- Liveness: `GET /healthz` (or `scripts\check-health.ps1`) proves only that
  the provider process is alive; it is deliberately not backend readiness.
- Native acceptance: follow `docs/WINDOWS_NATIVE_ACCEPTANCE.md`. The native
  lane records exact Windows/KiCad/source/backend/provider-contract/fixture
  identity and must run on a real Windows + KiCad host.
- Updates without rebuild: `docs\TOOL_GUIDE.md` is read at runtime — it can
  be replaced on disk (read-only ACL recommended); `contract_hash` changes
  accordingly and clients re-fetch `help`.
- Remote access: prefer gateway-managed SSH stdio or loopback HTTP over
  verified private SSH forwarding / authenticated trusted HTTPS. Public
  edge routing is optional for external clients, not required for LAN RPC.
  Never bind `0.0.0.0` without `KICAD_MCP_TOKEN` set.
- Projects live on host paths (`KICAD_PYTHON` auto-detects the KiCAD 10
  bundled interpreter); back up project dirs like any working data.

## Standard §16 checklist status

- [x] Streamable HTTP `/mcp` (+ STDIO default) · [x] Bearer fail-closed ·
      [x] credentials externalized · [x] explicit tool schemas · [x] read-only
      `help` versioned/fingerprinted · [x] stable IDs · [x] documented errors ·
      [x] health defined · [x] bounded timeouts · [x] no credential logging ·
      [x] `<provider>.<tool>` namespace · [x] business logic stays in provider ·
      [ ] gateway-side discovery + safe-call integration test (SlncTrZ-MCP lane)

## Private gateway lifecycle integration

For a split Linux control-plane / Windows native deployment, prefer a private authenticated transport: loopback HTTP over verified SSH forwarding, or gateway-managed SSH stdio where supported. Public edge routing is not required for LAN-native RPC. Use an approved interactive task/worker for GUI-dependent contexts; a conventional Session-0 service is not equivalent. Health remains liveness only.

After native readiness and approved contract/tool-set validation, an authorized controller invokes gateway sync for the registered provider and verifies activation, then the client refreshes tools/list. Sync accepts the discovered tool set; restricted exposure requires explicit approved-set validation/acceptance. Sync does not implicitly register or enable a provider.

For stdio, preserve gateway ownership of the provider child and avoid duplicate launch during probing/activation. Stop first drains/reconciles owned work, protects dirty documents, then detaches/disables the route as authorized. Do not expect sync on a stopped provider to withdraw tools.

This is an integration target, not new lifecycle functionality shipped by this repository. See the [draft lifecycle contract](https://github.com/SlncTrZ/CDT_Engineer/blob/main/docs/EXECUTION_LIFECYCLE_CONTRACT.md), available in the sibling CDT_Engineer checkout before publication.
