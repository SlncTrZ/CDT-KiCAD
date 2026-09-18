"""Recovery primitives — operation reconciliation and verified project checkpoints.

Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
CDT-KiCAD generic ECAD execution only; no discipline engineering judgment.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional


_CHECKPOINT_SCHEMA_VERSION = 1
_EXCLUDED_TOP_LEVEL = {"snapshots", "logs", ".git", "node_modules", "__pycache__"}
_CHECKPOINT_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _to_mm(value: float, unit: str) -> float:
    if unit == "inch":
        return float(value) * 25.4
    if unit == "mil":
        return float(value) * 0.0254
    return float(value)


def _close(a: Any, b: Any, tolerance: float = 1e-6) -> bool:
    try:
        return math.isclose(float(a), float(b), rel_tol=0.0, abs_tol=tolerance)
    except (TypeError, ValueError):
        return False


def _backend_owner(*results: Any) -> Optional[str]:
    for result in results:
        if not isinstance(result, dict):
            continue
        owner = result.get("backend_owner") or result.get("_backend") or result.get("backend")
        if isinstance(owner, str):
            return owner
    return None


def reconcile_operation(
    interface: Any,
    command: str,
    params: Dict[str, Any],
    late_result: Dict[str, Any],
) -> Dict[str, Any]:
    """Read native/file state after a timed-out mutation and classify only known operations."""

    owner = _backend_owner(late_result)

    if not isinstance(late_result, dict) or late_result.get("success") is False:
        return {
            "success": True,
            "state": "failed",
            "backend_owner": owner,
            "evidence": {"late_result_success": False},
        }

    if command == "move_component":
        reference = params.get("reference")
        expected_pos = params.get("position") or {}
        if not reference or not isinstance(expected_pos, dict):
            return {"success": True, "state": "uncertain", "backend_owner": owner}

        readback = interface.handle_command(
            "get_component_properties", {"reference": reference}
        )
        owner = _backend_owner(readback, late_result)
        component = readback.get("component", {}) if isinstance(readback, dict) else {}
        actual_pos = component.get("position", {}) if isinstance(component, dict) else {}
        expected_unit = str(expected_pos.get("unit", "mm"))
        actual_unit = str(actual_pos.get("unit", "mm"))
        position_match = (
            bool(readback.get("success"))
            and _close(
                _to_mm(expected_pos.get("x", 0), expected_unit),
                _to_mm(actual_pos.get("x", 0), actual_unit),
            )
            and _close(
                _to_mm(expected_pos.get("y", 0), expected_unit),
                _to_mm(actual_pos.get("y", 0), actual_unit),
            )
        )
        rotation_match = True
        if params.get("rotation") is not None:
            rotation_match = _close(
                float(params["rotation"]) % 360.0,
                float(component.get("rotation", -1000000)) % 360.0,
                tolerance=1e-4,
            )
        layer_match = True
        if params.get("layer") is not None:
            layer_match = component.get("layer") == params.get("layer")

        committed = position_match and rotation_match and layer_match
        return {
            "success": True,
            "state": "committed" if committed else "uncertain",
            "backend_owner": owner,
            "evidence": {
                "reference": reference,
                "position_match": position_match,
                "rotation_match": rotation_match,
                "layer_match": layer_match,
            },
        }

    if command == "set_board_size":
        late_owner = _backend_owner(late_result)
        if late_owner == "ipc":
            # Reconcile a live IPC mutation against the same live owner. Falling
            # through to the SWIG/file model here can falsely commit stale state.
            readback = interface.handle_command("get_board_info", {})
            readback_owner = _backend_owner(readback)
            board_info = (
                readback.get("boardInfo", {}) if isinstance(readback, dict) else {}
            )
            extents = board_info.get("size", {}) if isinstance(board_info, dict) else {}
            owner_match = readback_owner == "ipc"
            strategy = "ipc_board_size"
        else:
            readback = interface.handle_command(
                "get_board_extents", {"unit": params.get("unit", "mm")}
            )
            readback_owner = _backend_owner(readback)
            extents = readback.get("extents", {}) if isinstance(readback, dict) else {}
            owner_match = late_owner is None or readback_owner == late_owner
            strategy = "swig_board_extents"

        owner = readback_owner or late_owner
        expected_unit = str(params.get("unit", "mm"))
        actual_unit = str(extents.get("unit", expected_unit))
        extents_match = (
            bool(readback.get("success"))
            and owner_match
            and _close(
                _to_mm(extents.get("width", 0), actual_unit),
                _to_mm(params.get("width", 0), expected_unit),
            )
            and _close(
                _to_mm(extents.get("height", 0), actual_unit),
                _to_mm(params.get("height", 0), expected_unit),
            )
        )
        return {
            "success": True,
            "state": "committed" if extents_match else "uncertain",
            "backend_owner": owner if owner_match else "degraded_uncertain",
            "evidence": {
                "strategy": strategy,
                "owner_match": owner_match,
                "extents_match": extents_match,
                "width": extents.get("width"),
                "height": extents.get("height"),
                "unit": extents.get("unit"),
            },
        }

    if command == "save_project":
        dirty_state = interface.handle_command("is_dirty", {})
        project_info = interface.handle_command("get_project_info", {})
        owner = _backend_owner(dirty_state, project_info, late_result)
        dirty = dirty_state.get("dirty") if isinstance(dirty_state, dict) else None
        disk_changed = (
            dirty_state.get("diskChangedExternally")
            if isinstance(dirty_state, dict)
            else None
        )

        requested_path = params.get("path") or params.get("filename")
        reported_path = None
        if isinstance(project_info, dict):
            project = project_info.get("project")
            if isinstance(project, dict):
                reported_path = project.get("path")
        if not reported_path and isinstance(late_result, dict):
            project = late_result.get("project")
            if isinstance(project, dict):
                reported_path = project.get("path")

        persisted_path = requested_path or reported_path
        persisted_file = (
            Path(str(persisted_path)).expanduser().resolve()
            if persisted_path
            else None
        )
        path_match = True
        if requested_path and reported_path:
            path_match = (
                Path(str(requested_path)).expanduser().resolve()
                == Path(str(reported_path)).expanduser().resolve()
            )
        persisted = bool(persisted_file and persisted_file.is_file())
        sha256 = _sha256_file(persisted_file) if persisted and persisted_file else None

        committed = (
            bool(dirty_state.get("success"))
            and bool(project_info.get("success"))
            and dirty is False
            and not disk_changed
            and path_match
            and persisted
        )
        return {
            "success": True,
            "state": "committed" if committed else "uncertain",
            "backend_owner": owner,
            "evidence": {
                "dirty": dirty,
                "diskChangedExternally": disk_changed,
                "persisted_path": str(persisted_file) if persisted_file else None,
                "persisted": persisted,
                "path_match": path_match,
                "sha256": sha256,
            },
        }

    if command == "export_pdf":
        file_info = late_result.get("file") if isinstance(late_result, dict) else None
        artifact_path = file_info.get("path") if isinstance(file_info, dict) else None
        artifact = Path(str(artifact_path)).expanduser() if artifact_path else None
        if artifact and artifact.is_file():
            return {
                "success": True,
                "state": "committed",
                "backend_owner": owner,
                "evidence": {
                    "artifact_path": str(artifact.resolve()),
                    "sha256": _sha256_file(artifact),
                    "size": artifact.stat().st_size,
                },
            }
        return {
            "success": True,
            "state": "uncertain",
            "backend_owner": owner,
            "evidence": {"artifact_path": artifact_path, "exists": False},
        }

    return {
        "success": True,
        "state": "uncertain",
        "backend_owner": owner,
        "evidence": {
            "reason": "operation_specific_reconciliation_not_supported",
            "command": command,
        },
    }


def _iter_project_files(project_dir: Path) -> Iterable[Path]:
    for path in project_dir.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(project_dir)
        if relative.parts and relative.parts[0] in _EXCLUDED_TOP_LEVEL:
            continue
        yield path


def _safe_checkpoint_id(checkpoint_id: Optional[str]) -> str:
    candidate = checkpoint_id or f"cp-{uuid.uuid4()}"
    if not _CHECKPOINT_ID_RE.fullmatch(candidate):
        raise ValueError(
            "checkpoint_id must be 1-128 characters of A-Z, a-z, 0-9, '.', '_' or '-'"
        )
    return candidate


def capture_project_checkpoint(
    project_dir: Path | str,
    *,
    checkpoint_id: Optional[str] = None,
    scope: str = "project",
    source_identity: Optional[Dict[str, Any]] = None,
    source_revision: Optional[Dict[str, Any]] = None,
    semantic_state: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Create a content-hashed recovery checkpoint without prompt/session logs."""

    project = Path(project_dir).expanduser().resolve()
    if not project.is_dir():
        raise ValueError(f"Project directory not found: {project}")

    checkpoint_id = _safe_checkpoint_id(checkpoint_id)
    checkpoint = project / "snapshots" / checkpoint_id
    if checkpoint.exists():
        raise FileExistsError(f"Checkpoint already exists: {checkpoint}")

    resources_dir = checkpoint / "resources"
    resources_dir.mkdir(parents=True)

    resources = []
    for source in sorted(_iter_project_files(project), key=lambda item: item.as_posix()):
        relative = source.relative_to(project)
        destination = resources_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        resources.append(
            {
                "path": relative.as_posix(),
                "sha256": _sha256_file(destination),
                "size": destination.stat().st_size,
            }
        )

    manifest = {
        "schema_version": _CHECKPOINT_SCHEMA_VERSION,
        "checkpoint_id": checkpoint_id,
        "scope": scope,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "identity": source_identity or {"project_dir": str(project)},
            "revision": source_revision or {},
        },
        "semantic_state": semantic_state or {},
        "resources": resources,
    }
    manifest_path = checkpoint / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    return {
        "checkpoint_id": checkpoint_id,
        "checkpoint_path": str(checkpoint),
        "manifest_path": str(manifest_path),
        "resource_count": len(resources),
    }


def validate_checkpoint(checkpoint_dir: Path | str) -> Dict[str, Any]:
    """Validate manifest shape, resource containment, size and SHA-256 before restore."""

    checkpoint = Path(checkpoint_dir).expanduser().resolve()
    manifest_path = checkpoint / "manifest.json"
    if not manifest_path.is_file():
        return {"valid": False, "reason": "manifest_missing"}

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"valid": False, "reason": "manifest_corrupt", "detail": str(exc)}

    if manifest.get("schema_version") != _CHECKPOINT_SCHEMA_VERSION:
        return {"valid": False, "reason": "manifest_schema_unsupported"}
    if not isinstance(manifest.get("resources"), list):
        return {"valid": False, "reason": "manifest_resources_invalid"}

    resources_root = (checkpoint / "resources").resolve()
    for entry in manifest["resources"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            return {"valid": False, "reason": "manifest_resource_entry_invalid"}
        relative = Path(entry["path"])
        if relative.is_absolute() or ".." in relative.parts:
            return {
                "valid": False,
                "reason": "manifest_resource_path_unsafe",
                "path": entry["path"],
            }
        candidate = (resources_root / relative).resolve()
        if os.path.commonpath([str(resources_root), str(candidate)]) != str(resources_root):
            return {
                "valid": False,
                "reason": "manifest_resource_path_unsafe",
                "path": entry["path"],
            }
        if not candidate.is_file():
            return {
                "valid": False,
                "reason": "resource_missing",
                "path": entry["path"],
            }
        if candidate.stat().st_size != entry.get("size"):
            return {
                "valid": False,
                "reason": "resource_size_mismatch",
                "path": entry["path"],
            }
        actual_hash = _sha256_file(candidate)
        if actual_hash != entry.get("sha256"):
            return {
                "valid": False,
                "reason": "resource_hash_mismatch",
                "path": entry["path"],
            }

    return {"valid": True, "manifest": manifest, "checkpoint_path": str(checkpoint)}


def restore_project_checkpoint(
    checkpoint_dir: Path | str, target_project_dir: Path | str
) -> Dict[str, Any]:
    """Validate first, then restore checkpoint resources; semantic verification is separate."""

    validation = validate_checkpoint(checkpoint_dir)
    if not validation.get("valid"):
        return {
            "restored": False,
            "checkpointed_atomic": False,
            "validation": validation,
        }

    checkpoint = Path(checkpoint_dir).expanduser().resolve()
    target = Path(target_project_dir).expanduser().resolve()
    target.mkdir(parents=True, exist_ok=True)
    manifest = validation["manifest"]
    expected_paths = {entry["path"] for entry in manifest["resources"]}

    try:
        for existing in sorted(_iter_project_files(target), key=lambda item: item.as_posix()):
            relative = existing.relative_to(target).as_posix()
            if relative not in expected_paths:
                existing.unlink()

        for entry in manifest["resources"]:
            relative = Path(entry["path"])
            source = checkpoint / "resources" / relative
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            temp = destination.with_name(destination.name + ".restore-tmp")
            shutil.copy2(source, temp)
            os.replace(temp, destination)
    except Exception as exc:
        return {
            "restored": False,
            "checkpointed_atomic": False,
            "validation": validation,
            "reason": "restore_failed",
            "detail": str(exc),
        }

    return {
        "restored": True,
        "checkpointed_atomic": False,
        "requires_semantic_verification": True,
        "checkpoint_id": manifest["checkpoint_id"],
        "manifest": manifest,
    }


def _canonical_json_hash(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def capture_board_semantics(interface: Any) -> Dict[str, Any]:
    """Capture deterministic ECAD facts used to verify a restored checkpoint."""

    # Keep all semantic facts on the session-owned backend. get_board_info
    # and get_component_list are both owner-aware; get_board_extents is SWIG-only
    # and would mix stale file geometry into an IPC-owned semantic fingerprint.
    board_info = interface.handle_command("get_board_info", {})
    component_info = interface.handle_command("get_component_list", {})

    board_payload: Dict[str, Any] = {}
    if isinstance(board_info, dict):
        candidate = board_info.get("boardInfo") or board_info.get("board")
        if isinstance(candidate, dict):
            board_payload = candidate

    components = []
    if isinstance(component_info, dict):
        for item in component_info.get("components", []) or []:
            if not isinstance(item, dict):
                continue
            components.append(
                {
                    key: item.get(key)
                    for key in (
                        "reference",
                        "value",
                        "footprint",
                        "position",
                        "rotation",
                        "layer",
                    )
                }
            )
    components.sort(key=lambda item: str(item.get("reference") or ""))

    board_path = None
    getter = getattr(interface, "_authoritative_board_path", None)
    if callable(getter):
        board_path = getter()

    board_owner = _backend_owner(board_info)
    component_owner = _backend_owner(component_info)
    read_success = bool(
        isinstance(board_info, dict)
        and board_info.get("success")
        and isinstance(component_info, dict)
        and component_info.get("success")
    )
    owner_consistent = (
        board_owner is None
        or component_owner is None
        or board_owner == component_owner
    )
    semantic_valid = read_success and owner_consistent
    semantic_facts = {
        "board_path": str(Path(board_path).resolve()) if board_path else None,
        "board": {
            key: board_payload.get(key)
            for key in ("name", "title", "filename", "fileName")
            if key in board_payload
        },
        "size": board_payload.get("size"),
        "components": components,
    }
    semantic = {
        **semantic_facts,
        "backend_owner": (
            board_owner or component_owner if owner_consistent else "degraded_uncertain"
        ),
        "owner_consistent": owner_consistent,
        "semantic_valid": semantic_valid,
        # Backend ownership is verification metadata, not an ECAD semantic fact:
        # a valid restore may reopen through SWIG after an IPC checkpoint (or
        # vice versa) as long as both reads are internally owner-consistent.
        "semantic_sha256": _canonical_json_hash(semantic_facts),
    }
    return semantic


def semantic_state_matches(expected: Dict[str, Any], actual: Dict[str, Any]) -> bool:
    if expected.get("semantic_valid") is False or actual.get("semantic_valid") is False:
        return False
    if expected.get("owner_consistent") is False or actual.get("owner_consistent") is False:
        return False
    return bool(expected.get("semantic_sha256")) and (
        expected.get("semantic_sha256") == actual.get("semantic_sha256")
    )


def restore_verified_checkpoint(
    checkpoint_dir: Path | str,
    target_project_dir: Path | str,
    *,
    reopen_board: Any,
    read_semantics: Any,
) -> Dict[str, Any]:
    """Restore only the checkpoint's bound project, reopen, then verify ECAD semantics.

    reopen_board receives the resolved board path and must return a result dict.
    read_semantics returns the deterministic semantic snapshot after reopen.
    """

    validation = validate_checkpoint(checkpoint_dir)
    if not validation.get("valid"):
        return {
            "success": False,
            "message": "Checkpoint validation failed",
            "checkpointed_atomic": False,
            "validation": validation,
        }

    manifest = validation["manifest"]
    expected_semantic = manifest.get("semantic_state") or {}
    if not expected_semantic.get("semantic_sha256"):
        return {
            "success": False,
            "message": "Checkpoint lacks semantic verification state",
            "checkpointed_atomic": False,
            "validation": validation,
        }

    target = Path(target_project_dir).expanduser().resolve()
    source_identity = (manifest.get("source") or {}).get("identity") or {}
    source_project_dir = source_identity.get("project_dir")
    if source_project_dir:
        source_project = Path(str(source_project_dir)).expanduser().resolve()
        if source_project != target:
            return {
                "success": False,
                "message": "Restore target does not match checkpoint source identity",
                "sourceProjectPath": str(source_project),
                "targetProjectPath": str(target),
                "checkpointed_atomic": False,
            }

    restored = restore_project_checkpoint(checkpoint_dir, target)
    if not restored.get("restored"):
        return {
            "success": False,
            "message": "Checkpoint restore failed",
            "checkpointed_atomic": False,
            "restore": restored,
        }

    board_identity = source_identity.get("board_path")
    if not board_identity:
        board_identity = next(
            (
                entry["path"]
                for entry in manifest.get("resources", [])
                if str(entry.get("path", "")).endswith(".kicad_pcb")
            ),
            None,
        )
    if not board_identity:
        return {
            "success": False,
            "message": "Restored checkpoint has no board identity",
            "restored": True,
            "checkpointed_atomic": False,
        }

    board_candidate = Path(str(board_identity)).expanduser()
    if not board_candidate.is_absolute():
        board_candidate = target / board_candidate
    board_candidate = board_candidate.resolve()
    try:
        if os.path.commonpath([str(target), str(board_candidate)]) != str(target):
            return {
                "success": False,
                "message": "Checkpoint board identity escapes restore target",
                "restored": True,
                "checkpointed_atomic": False,
            }
    except ValueError:
        return {
            "success": False,
            "message": "Checkpoint board identity is not compatible with restore target",
            "restored": True,
            "checkpointed_atomic": False,
        }

    reopened = reopen_board(str(board_candidate))
    if not isinstance(reopened, dict) or not reopened.get("success"):
        return {
            "success": False,
            "message": "Checkpoint restored but board reopen failed",
            "restored": True,
            "reopen": reopened,
            "checkpointed_atomic": False,
        }

    actual_semantic = read_semantics()
    semantic_verified = semantic_state_matches(expected_semantic, actual_semantic)
    if not semantic_verified:
        return {
            "success": False,
            "message": "Checkpoint restored and reopened but semantic verification failed",
            "restored": True,
            "reopen": reopened,
            "semantic_verified": False,
            "expected_semantic_sha256": expected_semantic.get("semantic_sha256"),
            "actual_semantic_sha256": (
                actual_semantic.get("semantic_sha256")
                if isinstance(actual_semantic, dict)
                else None
            ),
            "checkpointed_atomic": False,
        }

    return {
        "success": True,
        "message": "Checkpoint restored, reopened, and semantically verified",
        "checkpoint_id": manifest.get("checkpoint_id"),
        "restored": True,
        "reopen": reopened,
        "semantic_verified": True,
        "semantic_sha256": actual_semantic.get("semantic_sha256"),
        "checkpointed_atomic": True,
    }
