# AGENTS.md — CDT-KiCAD Generic ECAD Execution Engine

> Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
> SlncTrZ provider: `kicad`. Upstream baseline `v2.7.0`, fork `2.7.0-cdt.1`.

## Ownership

CDT-KiCAD owns generic native ECAD execution mechanics: schematic/board/
routing/library/export/DRC-ERC facts, safe mutation/recovery primitives,
capability declaration and the SlncTrZ provider shell (transport, auth,
`help` contract). It retains no discipline engineering logic.

Read `README.md`, `ATTRIBUTION.md`, `MCP_PROVIDER_STANDARD.md`,
`docs/TOOL_GUIDE.md` and `src/provider-contract.ts` before changing the
provider shell. Read the upstream tool docs before changing ECAD behavior.

## Mandatory boundaries

- Generic execution lives here (Node bridge + Python `pcbnew`/IPC backends).
- Discipline rules, standards interpretation (incl. TCVN/QCVN) and Audit
  Reports belong to CDT_Engineer Production Domains — never absorb them.
- Do not import runtime code from another provider repository
  (CDT-AutoCAD / SketchUp / Blender / SolidWorks). Depend on versioned
  CDT contracts only.
- No silent backend downgrade: IPC-only capabilities return typed
  `unsupported_capability` on SWIG, never fake success.
- No speculative shared core: `CDT-Provider-Kit` reuse needs Rule-of-Two
  evidence first.
- Upstream `LICENSE` (mixelpixx, MIT) stays verbatim; new CDT files keep the
  fork header. Never strip attribution.

## Change protocol

- `git status` before editing; keep STDIO as the default transport.
- Registry ratchet: every new `server.tool()` MUST enter
  `src/tools/registry.ts` (direct or category) and update README counts —
  `tests-ts/registry-completeness.test.ts` + `readme-counts.test.ts` enforce it.
- `help` content comes from runtime `docs/TOOL_GUIDE.md` only; never hard-code
  a duplicate guide string.
- Validate `git diff --check`; run `npm run build` + `npm run test:ts` when
  the TS layer changes and `pytest tests/ -v` when the Python bridge changes.
- Stage only task-owned changes; never commit `.env` or secrets.
- No push / no new GitHub remote / no deploy without explicit user instruction.
