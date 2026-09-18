# CDT-KiCAD Tool Guide (runtime contract source)

> This file is the runtime-readable operating guide for the CDT-KiCAD provider.
> The `help` tool serves this exact file content (plus version/fingerprint fields)
> so clients always read the running contract, not a stale copy.
> Fork: CDT-KiCAD adapts upstream `mixelpixx/KiCAD-MCP-Server` (MIT) to the
> SlncTrZ MCP Provider Standard. See `ATTRIBUTION.md`.

## Provider identity

- Provider ID: `kicad` (stable, lowercase ASCII).
- Gateway canonical tools: `kicad.<tool>` (e.g. `kicad.help`, `kicad.open_project`).
- Bare tool names are advertised by this provider; SlncTrZ-MCP owns namespacing.

## Transport

- Local mode (default): STDIO — `npm run build && node dist/index.js`.
- Network mode (opt-in): Streamable HTTP `POST /mcp` (MCP 2025-06-18, SDK 1.21.0).
- Health (unauthenticated, side-effect free): `GET /healthz` returns
  `{ status, provider, provider_version, contract_version }`.
- Select mode with `MCP_TRANSPORT=stdio|http|both` (default `stdio`),
  `MCP_HOST` (default `127.0.0.1`), `MCP_PORT` (default `3100`).

## Authentication (network mode)

- Primary: `Authorization: Bearer <token>`.
- Compatibility: `X-API-Key: <token>` (same single authorization layer).
- Token source: `KICAD_MCP_TOKEN` environment variable / secret manager.
  Never in URLs, tool args, logs, or Git-tracked config.
- Fail-closed: HTTP refuses to start without a token unless
  `MCP_ALLOW_UNAUTHENTICATED=1` is set explicitly for local loopback testing.
  That test mode is enforced as loopback-only (`localhost`, `127.0.0.0/8`,
  or `::1`); wildcard/LAN binds fail startup.
- Failures: `401` missing/invalid identity, `403` valid identity but denied.
- Vendor keys (`JLCPCB_*`, `DIGIKEY_*`) stay server-side env vars and are
  never accepted as tool arguments.

## Discovery tools (call by bare name locally)

- `help` — read-only operating contract (this guide + versions + fingerprint).
- `system_status` — liveness, backend, dependency reachability (no side effects).
- `system_capabilities` — machine-readable capability map (see below).
- `list_tool_categories` — browse the 16 indexed ECAD categories.
- `get_category_tools` — tools inside one category.
- `search_tools` — keyword search across indexed tools.

Every ECAD tool is registered directly and callable by name; discovery is a
catalogue, never a gate. Do not invent tool names — search first.

## Capability map (honest subset)

`system_capabilities` reports this shape; unsupported means a typed refusal,
never fake success:

- `common.document.{new,open,info,save,save_as,close}` — supported (project tools).
- `common.object.{list,get,count}` — supported (board/component/schematic queries).
- `common.organization.list` — supported (layers, net classes).
- `common.transform.{move,rotate}` — supported for board components (native).
- `common.transaction.*`, `common.undo`, `common.redo` — UNSUPPORTED
  (`reason: file_write_no_atomic_transaction`; use `snapshot_project` checkpoints).
- `common.import_asset` / `common.export_asset` — supported (import*\*/export*\*).
- `common.validate.*` / `common.inspect` / `common.measure` — supported
  (`validate_*`, `run_drc`, `run_erc`, extents/clearance queries).
- `kicad.schematic.*`, `kicad.board.*`, `kicad.routing.*`, `kicad.library.*`,
  `kicad.export.*`, `kicad.drc.*`, `kicad.parts.*` — provider extensions,
  permanently KiCAD-specific (never promoted to common unilaterally).

Runtime capability entries distinguish static implementation from current
availability: `implemented` says the provider has the operation;
`available_now` is computed from the current backend/session context and is
accompanied by `backend`, `reason`, and `context` fields.

Backend/session state is one of `none | swig | ipc | degraded_uncertain`.
An IPC-owned session that loses IPC stays IPC-owned and becomes
`degraded_uncertain`; it never silently reloads the saved board and continues
mutating through SWIG. The live board identity is also re-checked while an
IPC-owned session is active, so switching the KiCad GUI to another board makes
the session degraded before any mutation is routed. Mutations then fail closed
with typed `provider_unavailable`. Only explicitly classified saved-file reads
may use a SWIG/disk fallback, and their response labels the
source/backend/reason. Closing a degraded session with `save=false` is an
explicit discard and warns that unsaved GUI state may have been lost.

Use `reconnect_backend` to restore an IPC-owned session only after the live
KiCad document identity matches the pinned board. Use
`rebind_backend_session` for an explicit ownership transfer; IPC→SWIG requires
the same board identity plus `confirmDiscardLiveState=true` because unsaved GUI
state may otherwise be lost. A SWIG-pinned session never silently upgrades to
IPC. See `get_backend_state`.

## Safety rules every client must respect

1. Validate inputs before side effects; undeclared fields are rejected at every declared object boundary by strict MCP schemas.
2. Writes document persistence: `save_*` overwrites files; `delete_*` /
   `clear_board_outline` are destructive and separated from ordinary edits.
3. Long autoroute/export jobs have bounded timeouts; a timeout is NOT proof
   of cancellation — re-query state (`is_dirty`, DRC) before retrying.
4. Caller filesystem paths are canonicalized before dispatch; `..`, absolute
   escape, symlink/junction escape, drive/case mismatch and sibling-prefix tricks
   are rejected. Project reads/writes stay under the active project root.
   Open/create and library/import/export operations may additionally use roots
   explicitly trusted by the operator via `KICAD_MCP_TRUSTED_ROOTS` (OS path-list
   separator). Temporary staging is limited to the system temp workspace.
5. Engineering interpretation (standards compliance, TCVN/QCVN, Audit Reports)
   belongs to CDT_Engineer Production Domains — this provider reports ECAD
   facts (geometry, nets, violations, measurements) only.

## Error vocabulary

Provider/backend execution failures use a JSON text payload with `success: false`,
canonical `kind`, `message`, `retryable`, and optional sanitized `details`:
`authentication_error | authorization_error | validation_error | not_found |
conflict | rate_limited | timeout | provider_unavailable | internal_error |
unsupported_capability`. These outward failures never include credentials,
tokens, Python stack traces, traceback source paths, or Python `sys.path` dumps.
MCP schema-validation failures are rejected by the SDK before handler dispatch;
they are protocol-layer validation errors and are non-retryable, rather than a
provider execution payload.

## Versioning

- `provider_version` — this software build (semver + `-cdt.N` fork suffix).
- `contract_version` — this help/tool contract (`cdt-kicad-contract-v2`).
- `common_contract_version` — applied CDT common semantics (`cdt-common-v1`).
- `protocol_version` — MCP protocol / SDK compatibility declaration.
- `contract_hash` — SHA-256 over this guide's canonical content; clients and
  the gateway use it to detect contract drift.
