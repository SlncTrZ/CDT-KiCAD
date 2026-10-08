# Contributing

CDT-KiCAD is an MIT fork of KiCAD-MCP-Server.
Preserve [upstream attribution](ATTRIBUTION.md) and [LICENSE](LICENSE).

## Validate

Use Node.js 20. From the repository root:

```bash
npm ci
npm run build
npm run lint:ts
npm run test:ts
npm run docs:tools:check
npm run test:queue-load
```

Python bridge behavior is validated on its supported Windows environment using
`python scripts/run-python-behavioral.py` after installing
`requirements-dev.txt`. Linux compilation is a syntax check, not native PASS.
See [Windows acceptance](docs/WINDOWS_NATIVE_ACCEPTANCE.md) for native validation.

## Change a tool

- Read [architecture](docs/ARCHITECTURE.md) and the [runtime guide](docs/TOOL_GUIDE.md).
- Register each new tool in `src/tools/registry.ts`, update discovery metadata
  and regenerate `docs/TOOL_INVENTORY.md` with `npm run docs:tools`.
- Keep README counts consistent; existing tests enforce registered/indexed counts.
- Tools are directly callable. Search/browse discovery does not hide schemas or
  route execution through an indirect `execute_tool`.
- Preserve backend/session pinning, path policy, bounded dispatch and explicit
  uncertainty/refusal behavior. Missing IPC capabilities must not fake SWIG success.
- Keep public guides independent of private fixtures and machine evidence.

## Review

Add behavioral regression coverage for runtime changes. Record exact native
source/application identities for capability promotions. A passing unit suite
does not prove native compatibility or a new backend.

Submit a focused change with the problem, resulting behavior and validation.
Keep secrets, customer files, local logs and private development material out of Git.
