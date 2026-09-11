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

## Docker

```bash
docker build -t cdt-kicad:2.7.0-cdt.1 .
docker run -d --name cdt-kicad -p 3100:3100 \
  -e KICAD_MCP_TOKEN="$KICAD_MCP_TOKEN" \
  -e KICAD_PYTHON=/usr/bin/python3 \
  -v kicad-projects:/work:rw \
  -v ./docs/TOOL_GUIDE.md:/app/docs/TOOL_GUIDE.md:ro \
  cdt-kicad:2.7.0-cdt.1
curl -sf http://127.0.0.1:3100/healthz
```

Full ECAD execution needs KiCAD's `pcbnew` (see `Dockerfile` note). Behind a
reverse proxy/tunnel, terminate TLS at the edge and keep the provider bound
to loopback or the container network.

## Standard §16 checklist status

- [x] Streamable HTTP `/mcp` (+ STDIO default) · [x] Bearer fail-closed ·
  [x] credentials externalized · [x] explicit tool schemas · [x] read-only
  `help` versioned/fingerprinted · [x] stable IDs · [x] documented errors ·
  [x] health defined · [x] bounded timeouts · [x] no credential logging ·
  [x] `<provider>.<tool>` namespace · [x] business logic stays in provider ·
  [ ] gateway-side discovery + safe-call integration test (SlncTrZ-MCP lane)
