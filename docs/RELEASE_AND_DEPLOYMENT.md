# CDT-KiCAD — Release and deployment

**CDT release:** `0.1.3` · tag `v.0.1.3` · contract `cdt-kicad-contract-v2`. The upstream software baseline `v2.7.0` is **not** the CDT release version.

GitHub [source releases](https://github.com/SlncTrZ/CDT-KiCAD/releases) do not imply a Windows executable or native KiCad runtime has been installed. The declared accepted target is **KiCad 10.0.6 / Windows 11**, CLI/native. Other builds/GUI IPC need their own measured acceptance.

## Install and connect

1. Check [Windows setup](../README.md) and [platform requirements](PLATFORM_GUIDE.md). Use Node 20 and KiCad's Python environment. From a trusted release checkout, run `setup-windows.ps1`, build if needed (`npm ci`, `npm run build`) and start `node dist/index.js`.
2. STDIO runs in the caller's session. For optional HTTP, provision `KICAD_MCP_TOKEN` from the secret manager and use the [SlncTrZ integration guide](SLNCTRZ_INTEGRATION.md); never store tokens in client command lines, URLs or committed files.
3. In the MCP client call `help`, `system_status`, `system_capabilities`, then verify runtime contract, backend (CLI/SWIG/IPC), native KiCad build and project path. The 239 registry tools include 236 indexed tools and three direct-only discovery controls; discovery does not authorize writes.

## Upgrade and rollback

Install or unpack into a new immutable directory; keep the previous Node bundle, requirements, native CLI path and auth binding. For split-host deployment, run `node dist/workstation-agent.js` in the logged-in KiCad Windows session with `KICAD_RUNTIME_TOKEN` and `KICAD_PYTHON` set through protected environment configuration; the agent binds only 127.0.0.1 (`KICAD_RUNTIME_PORT`, default 19816). On the Linux control host, run `node dist/index.js` as an independent systemd HTTP service with `MCP_TRANSPORT=http`, loopback `MCP_HOST`/`MCP_PORT`, `KICAD_MCP_TOKEN`, `KICAD_RUNTIME_ENDPOINT=http://127.0.0.1:<tunnel-port>` and the same `KICAD_RUNTIME_TOKEN` from mode-0600 environment files. Use an owner-managed SSH local forward from the Linux loopback port to the Windows agent loopback; never expose the agent on LAN or put tokens in command arguments. Register the provider with Gateway as authenticated Streamable HTTP `/mcp`, not stdio. The Linux host does not need native KiCad; a missing workstation is a reported dependency state, not provider startup failure. `KICAD_SKIP_PCBNEW_VALIDATION=1` is diagnostic-only, not native acceptance. Verify `npm ci`, TypeScript tests, the Windows-native target check, DRC/ERC readback and scoped project save/reopen before switching owner-managed Gateway registration. Never downgrade an unavailable IPC capability silently to SWIG. If auth/backend or project-state checks fail, restore the previous registration and runtime without deleting credentials or modifying production boards.

[Documentation index](INDEX.md) · [Tool guide](TOOL_GUIDE.md) · [Windows acceptance](WINDOWS_NATIVE_ACCEPTANCE.md) · [Troubleshooting](WINDOWS_TROUBLESHOOTING.md).
