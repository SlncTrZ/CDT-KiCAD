# CDT-KiCAD release notes

## 0.1.1 — documentation and release maintenance

- Stable source-only release/install/rollback guide and refreshed documentation index; no new KiCad native support claims.
- Verified existing 239-tool registry identity and unchanged contract v2; upstream version preserved in attribution.

## 0.1.0 — stable CDT product numbering

- Existing KiCAD capabilities retained; package version normalized to `0.1.0`.
- Canonical tag `v.0.1.0`, distinct from upstream `v2.7.0`.
- No new native KiCAD qualification implied by metadata-only changes.

## 2.7.0-cdt.1 — historical fork baseline

CDT adapts upstream `v2.7.0` to the SlncTrZ provider contract:

- Stable `kicad` identity and read-only help/status/capability tools.
- STDIO by default; opt-in authenticated Streamable HTTP and health liveness.
- 239 registered tools; 236 searchable across 20 categories, with three
  discovery controls intentionally direct-only.
- Backend/session pinning and explicit unsupported-capability behavior.
- Bounded transport responses and uncertainty handling for ambiguous outcomes.

Source snapshots and their identities are listed in
[GitHub releases](https://github.com/SlncTrZ/CDT-KiCAD/releases).
A source release is not a new native acceptance certificate.

Upstream release history is maintained in the
[upstream changelog](https://github.com/mixelpixx/KiCAD-MCP-Server/blob/main/CHANGELOG.md).
See [ATTRIBUTION](ATTRIBUTION.md) and [LICENSE](LICENSE) for origin and licensing.
