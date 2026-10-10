# CDT-KiCAD

Generic ECAD execution provider for schematic, board, routing, library, export
and DRC/ERC operations. Engineering design rules and professional approval belong
to CDT_Engineer.

CDT release `0.1.1` (upstream baseline `v2.7.0`) · Provider `kicad` · Contract `cdt-kicad-contract-v2`.

239 tools registered; 236 indexed for keyword discovery and 3 discovery controls intentionally direct-only.
236 discoverable tools across 20 categories.
All tools are directly callable; discovery is a search catalogue, not an execution gate.

## Supported target

Native acceptance is scoped to KiCad 10.0.6 on Windows 11, CLI/native execution.
GUI IPC, other KiCad builds, Linux and macOS require separate acceptance.
A source update or hosted CI PASS does not certify a new native deployment.

## Install and run

Use Node.js 20 and KiCad's Python environment with `pcbnew` available.
From a Windows PowerShell session:

```powershell
git clone https://github.com/SlncTrZ/CDT-KiCAD.git
cd CDT-KiCAD
.\setup-windows.ps1
node dist/index.js
```

STDIO is the default. Configure the MCP client using the
[client guide](docs/CLIENT_CONFIGURATION.md). For manual setup and optional OS
lanes, see the [platform guide](docs/PLATFORM_GUIDE.md) and
[Windows troubleshooting](docs/WINDOWS_TROUBLESHOOTING.md).

HTTP is opt-in and requires deployment-managed `KICAD_MCP_TOKEN`.
Never put credentials in client arguments, URLs or committed configuration.

## Use safely

Call `help`, `system_status` and `system_capabilities` first. Pin the runtime
guide's `contract_hash`; verify the active backend/session and required capability.
An IPC-owned session must not silently downgrade to SWIG after connection loss.
Refuse unavailable capabilities and reconcile uncertain mutation outcomes before retrying.

- [Runtime tool contract](docs/TOOL_GUIDE.md).
- [Generated inventory](docs/TOOL_INVENTORY.md) — current tools and categories.
- [Task-oriented documentation](docs/INDEX.md).
- [Stable release, installation and rollback](docs/RELEASE_AND_DEPLOYMENT.md).
- [Known limitations](docs/KNOWN_ISSUES.md).
- [Contributor validation](CONTRIBUTING.md).

## Attribution

MIT fork of [mixelpixx/KiCAD-MCP-Server](https://github.com/mixelpixx/KiCAD-MCP-Server),
upstream baseline `v2.7.0`. See [LICENSE](LICENSE), [ATTRIBUTION](ATTRIBUTION.md)
and [fork release notes](CHANGELOG.md).
