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
- `common.transaction.*`, `common.undo`, `common.redo` — UNSUPPORTED as
  native atomic/undo operations. Recovery is explicit: create `snapshot_project`,
  then use `restore_checkpoint`; this does not turn ordinary mutations into a
  globally atomic transaction.
- `common.import_asset` / `common.export_asset` — supported (import_*/export_*).
- `common.validate.*` / `common.inspect` / `common.measure` — supported
  (`validate_*`, `run_drc`, `run_erc`, extents/clearance queries).
- `kicad.schematic.*`, `kicad.board.*`, `kicad.routing.*`, `kicad.library.*`,
  `kicad.export.*`, `kicad.drc.*`, `kicad.parts.*` — provider extensions,
  permanently KiCAD-specific (never promoted to common unilaterally).
- `kicad.recovery.checkpoint` — supported in snapshot mode. A restore may report
  `checkpointed_atomic=true` only after manifest/hash validation, file restore,
  board reopen, and semantic read-back all succeed.

Backend context: `swig` (file-based pcbnew) or `ipc` (live KiCAD UI sync,
experimental). The provider never silently downgrades: a capability requiring
the live backend returns typed `unsupported_capability` when only file mode
is active. See `get_backend_state`.

## Safety rules every client must respect

1. Validate inputs before side effects; unknown fields are rejected.
2. Writes document persistence: `save_*` overwrites files; `delete_*` /
   `clear_board_outline` are destructive and separated from ordinary edits.
3. A timeout is NOT proof of cancellation/failure. For representative
   timeout-recoverable mutations (`move_component`, `set_board_size`,
   `save_project`, `export_pdf`), provide a stable `operationId`; receipts
   expose canonical `operation_id` with `committed | failed | uncertain`.
   Timeout marks the operation `uncertain` with backend owner
   `degraded_uncertain`; a same-ID retry is not executed again, and dependent
   mutations are blocked until reconciliation resolves the receipt.
4. Reconciliation is operation-specific, not global idempotency. Component
   position/layer/rotation, board extents, persisted save identity/hash, and
   exported PDF artifact identity/hash are read back. Other timed-out mutations
   remain `uncertain`; do not mint a new operation ID and blindly retry them.
5. Recovery checkpoints contain `checkpoint_id`, scope, source identity/revision
   where available, and SHA-256/size for every included resource. Prompt/session
   logs and nested snapshots are excluded by default.
6. `restore_checkpoint` validates the checkpoint before mutation, restores only
   the source-bound project, reopens the board, then compares deterministic
   semantic state. Only that verified path may return `checkpointed_atomic=true`.
7. Keep file operations inside the opened project directory.
8. Engineering interpretation (standards compliance, TCVN/QCVN, Audit Reports)
   belongs to CDT_Engineer Production Domains — this provider reports ECAD
   facts (geometry, nets, violations, measurements) only.

## Error vocabulary

`authentication_error | authorization_error | validation_error | not_found |
conflict | rate_limited | timeout | provider_unavailable | internal_error |
unsupported_capability`. Errors never include credentials, tokens, or stack
traces. Each error states whether retry is reasonable.

## Versioning

- `provider_version` — this software build (semver + `-cdt.N` fork suffix).
- `contract_version` — this help/tool contract (`cdt-kicad-contract-v2`).
- `common_contract_version` — applied CDT common semantics (`cdt-common-v1`).
- `protocol_version` — MCP protocol / SDK compatibility declaration.
- `contract_hash` — SHA-256 over this guide's canonical content; clients and
  the gateway use it to detect contract drift.
