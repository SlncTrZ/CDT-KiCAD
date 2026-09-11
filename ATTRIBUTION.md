# Attribution & Fork Notice — CDT-KiCAD

## Upstream

CDT-KiCAD is a fork of **KiCAD-MCP-Server** by **mixelpixx**
(<https://github.com/mixelpixx/KiCAD-MCP-Server>), licensed under the
**MIT License** (see `LICENSE` — copyright `Copyright (c) 2024 mixelpixx`,
preserved verbatim as required).

Upstream baseline: `v2.7.0` — STDIO Node/TypeScript + Python (`pcbnew`)
bridge, 233 registered tools / 173 indexed across 16 categories, 23 dynamic
resources, Freerouting + JLCPCB + Digi-Key integrations.

## What the fork changes (and why)

CDT-KiCAD keeps 100% of upstream ECAD execution mechanics and adapts the
**provider shell** to the SlncTrZ ecosystem:

- Stable provider ID `kicad` (`kicad.<tool>` gateway namespace).
- Opt-in Streamable HTTP `POST /mcp` + `GET /healthz` (STDIO stays default).
- Fail-closed Bearer auth (`KICAD_MCP_TOKEN`), `X-API-Key` via one auth layer.
- Read-only `help` / `system_status` / `system_capabilities` tools sourced
  from runtime `docs/TOOL_GUIDE.md` with SHA-256 `contract_hash`.
- Explicit Generic ECAD Engine boundary: native execution only — discipline
  rules, standards interpretation and Audit Reports belong to CDT_Engineer
  Production Domains.

No upstream business logic was removed; no upstream license term was altered.
All new CDT files carry this fork header. Upstream `CHANGELOG.md` history is
retained; CDT changes are recorded below and in Git history.

## License

- Upstream code: MIT (`LICENSE`, mixelpixx).
- CDT adaptation files in this repository: same MIT License, copyright
  `SlncTrZ / Truong Cong Dinh` for the adaptation layer only, upstream
  copyright preserved. Neither party's notice may be removed.
