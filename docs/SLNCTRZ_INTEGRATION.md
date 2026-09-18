# SlncTrZ-MCP Integration — CDT-KiCAD (`kicad`)

> Companion to `MCP_PROVIDER_STANDARD.md` (Draft v0.2) and the runtime
> `docs/TOOL_GUIDE.md`. The `help` tool is authoritative at runtime; this
> file is the static gateway-wiring reference.

## Endpoint & auth

| Item | Value |
| --- | --- |
| Provider ID | `kicad` |
| Network endpoint | `POST http://<host>:3100/mcp` (Streamable HTTP) |
| Health | `GET http://<host>:3100/healthz` (unauthenticated liveness) |
| Primary credential | `Authorization: Bearer <token>` |
| Compatibility credential | `X-API-Key: <token>` (same single auth layer) |
| Token source | `KICAD_MCP_TOKEN` env / secret manager, never Git |
| Failure codes | `401` missing/invalid identity · `403` denied |
| Local mode | STDIO (`node dist/index.js`), no token, process-local |

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
Re-fetch `help` when the hash changes; treat a changed hash as a new
contract version (`cdt-kicad-contract-v1` → next).

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

KiCAD (`pcbnew`, IPC UI sync) is Windows-bound, so this provider deploys as
a native Windows process — no container image is shipped. Standard §13
Docker expectations do not apply; the equivalent controls below do.

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
- Remote access: keep the provider bound to `127.0.0.1` and terminate
  TLS/exposure at the edge (reverse proxy / Cloudflare Tunnel); never bind
  `0.0.0.0` without `KICAD_MCP_TOKEN` set.
- Projects live on host paths (`KICAD_PYTHON` auto-detects the KiCAD 10
  bundled interpreter); back up project dirs like any working data.

## Standard §16 checklist status

- [x] Streamable HTTP `/mcp` (+ STDIO default) · [x] Bearer fail-closed ·
  [x] credentials externalized · [x] explicit tool schemas · [x] read-only
  `help` versioned/fingerprinted · [x] stable IDs · [x] documented errors ·
  [x] health defined · [x] bounded timeouts · [x] no credential logging ·
  [x] `<provider>.<tool>` namespace · [x] business logic stays in provider ·
  [ ] gateway-side discovery + safe-call integration test (SlncTrZ-MCP lane)
