"""Recovery/checkpoint contract tests for D09+D10.

Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
SlncTrZ provider adaptation test coverage.
"""

import hashlib
import json
from pathlib import Path

import pytest

from recovery import (
    capture_board_semantics,
    capture_project_checkpoint,
    reconcile_operation,
    restore_project_checkpoint,
    restore_verified_checkpoint,
    semantic_state_matches,
    validate_checkpoint,
)


class FakeInterface:
    def __init__(self, project_path=None):
        self.component = {
            "success": True,
            "component": {
                "reference": "R1",
                "position": {"x": 10.0, "y": 20.0, "unit": "mm"},
                "rotation": 90.0,
                "layer": "F.Cu",
            },
            "_backend": "ipc",
        }
        self.extents = {
            "success": True,
            "extents": {"width": 100.0, "height": 80.0, "unit": "mm"},
            "_backend": "swig",
        }
        self.dirty = {"success": True, "dirty": False, "_backend": "swig"}
        self.project_info = {
            "success": True,
            "project": {"path": str(project_path)} if project_path else {},
            "_backend": "swig",
        }

    def handle_command(self, command, params):
        if command == "get_component_properties":
            return self.component
        if command == "get_board_extents":
            return self.extents
        if command == "is_dirty":
            return self.dirty
        if command == "get_project_info":
            return self.project_info
        raise AssertionError(f"unexpected command: {command}")


def test_capture_board_semantics_uses_owner_consistent_board_info_size():
    class SemanticInterface:
        def _authoritative_board_path(self):
            return "/tmp/demo.kicad_pcb"

        def handle_command(self, command, params):
            if command == "get_board_info":
                return {
                    "success": True,
                    "boardInfo": {
                        "filename": "/tmp/demo.kicad_pcb",
                        "title": "Demo",
                        "size": {"width": 100.0, "height": 80.0, "unit": "mm"},
                    },
                    "_backend": "ipc",
                }
            if command == "get_component_list":
                return {
                    "success": True,
                    "components": [
                        {
                            "reference": "R1",
                            "value": "1k",
                            "footprint": "R_0603",
                            "position": {"x": 10, "y": 20, "unit": "mm"},
                            "rotation": 0,
                            "layer": "F.Cu",
                        }
                    ],
                    "_backend": "ipc",
                }
            raise AssertionError(f"cross-owner semantic read attempted: {command}")

    semantic = capture_board_semantics(SemanticInterface())

    assert semantic["size"] == {"width": 100.0, "height": 80.0, "unit": "mm"}
    assert semantic["board"]["title"] == "Demo"
    assert semantic["backend_owner"] == "ipc"
    assert semantic["owner_consistent"] is True
    assert semantic["semantic_valid"] is True
    assert semantic["components"][0]["reference"] == "R1"
    assert semantic["semantic_sha256"]


def test_semantic_match_allows_backend_change_but_rejects_mixed_owner_snapshot():
    facts = {
        "board_path": "/tmp/demo.kicad_pcb",
        "board": {"filename": "/tmp/demo.kicad_pcb"},
        "size": {"width": 100.0, "height": 80.0, "unit": "mm"},
        "components": [],
    }
    digest = hashlib.sha256(
        json.dumps(facts, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
            "utf-8"
        )
    ).hexdigest()

    expected = {
        **facts,
        "backend_owner": "ipc",
        "owner_consistent": True,
        "semantic_sha256": digest,
    }
    restored_via_swig = {
        **facts,
        "backend_owner": "swig",
        "owner_consistent": True,
        "semantic_sha256": digest,
    }
    mixed_owner = {
        **restored_via_swig,
        "backend_owner": "degraded_uncertain",
        "owner_consistent": False,
    }

    assert semantic_state_matches(expected, restored_via_swig) is True
    assert semantic_state_matches(expected, mixed_owner) is False


def test_move_component_reconciliation_reads_semantic_state():
    result = reconcile_operation(
        FakeInterface(),
        "move_component",
        {
            "reference": "R1",
            "position": {"x": 10, "y": 20, "unit": "mm"},
            "rotation": 90,
            "layer": "F.Cu",
        },
        {"success": True, "_backend": "ipc"},
    )

    assert result["success"] is True
    assert result["state"] == "committed"
    assert result["evidence"]["reference"] == "R1"
    assert result["backend_owner"] == "ipc"


def test_board_size_reconciliation_uses_read_after_write_extents():
    result = reconcile_operation(
        FakeInterface(),
        "set_board_size",
        {"width": 100, "height": 80, "unit": "mm"},
        {"success": True, "_backend": "swig"},
    )
    assert result["state"] == "committed"
    assert result["backend_owner"] == "swig"
    assert result["evidence"]["strategy"] == "swig_board_extents"
    assert result["evidence"]["extents_match"] is True


def test_board_size_reconciliation_reads_back_from_same_ipc_owner():
    class IPCInterface:
        def __init__(self):
            self.calls = []

        def handle_command(self, command, params):
            self.calls.append((command, params))
            if command == "get_board_info":
                return {
                    "success": True,
                    "boardInfo": {
                        "size": {"width": 100.0, "height": 80.0, "unit": "mm"}
                    },
                    "_backend": "ipc",
                }
            raise AssertionError(f"unexpected command: {command}")

    interface = IPCInterface()
    result = reconcile_operation(
        interface,
        "set_board_size",
        {"width": 100, "height": 80, "unit": "mm"},
        {"success": True, "_backend": "ipc"},
    )

    assert result["state"] == "committed"
    assert result["backend_owner"] == "ipc"
    assert result["evidence"]["strategy"] == "ipc_board_size"
    assert result["evidence"]["owner_match"] is True
    assert interface.calls == [("get_board_info", {})]


def test_board_size_reconciliation_refuses_cross_owner_false_commit():
    class DriftedInterface:
        def handle_command(self, command, params):
            assert command == "get_board_info"
            return {
                "success": True,
                "board": {
                    "size": {"width": 100.0, "height": 80.0, "unit": "mm"}
                },
                "_backend": "swig",
            }

    result = reconcile_operation(
        DriftedInterface(),
        "set_board_size",
        {"width": 100, "height": 80, "unit": "mm"},
        {"success": True, "_backend": "ipc"},
    )

    assert result["state"] == "uncertain"
    assert result["backend_owner"] == "degraded_uncertain"
    assert result["evidence"]["owner_match"] is False


def test_save_reconciliation_requires_clean_persisted_state(tmp_path):
    board = tmp_path / "demo.kicad_pcb"
    board.write_text("(kicad_pcb saved)", encoding="utf-8")
    result = reconcile_operation(
        FakeInterface(board),
        "save_project",
        {"path": str(board)},
        {
            "success": True,
            "project": {"path": str(board)},
            "_backend": "swig",
        },
    )
    assert result["state"] == "committed"
    assert result["evidence"]["dirty"] is False
    assert result["evidence"]["persisted"] is True
    assert result["evidence"]["path_match"] is True
    assert result["evidence"]["sha256"] == hashlib.sha256(board.read_bytes()).hexdigest()


def test_export_pdf_reconciliation_requires_artifact_identity(tmp_path):
    artifact = tmp_path / "board-review.pdf"
    artifact.write_bytes(b"%PDF-test")
    late = {
        "success": True,
        "file": {"path": str(artifact)},
        "_backend": "swig",
    }
    result = reconcile_operation(
        FakeInterface(),
        "export_pdf",
        {"outputPath": str(tmp_path / "review.pdf")},
        late,
    )
    assert result["state"] == "committed"
    assert result["evidence"]["sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest()


def test_checkpoint_manifest_hashes_resources_and_excludes_logs(tmp_path):
    project = tmp_path / "demo"
    project.mkdir()
    (project / "demo.kicad_pcb").write_text("(kicad_pcb test)", encoding="utf-8")
    (project / "demo.kicad_pro").write_text('{"board": {}}', encoding="utf-8")
    logs = project / "logs"
    logs.mkdir()
    (logs / "mcp_log.txt").write_text("session secret-ish trace", encoding="utf-8")
    (logs / "PROMPT_1.md").write_text("prompt", encoding="utf-8")

    result = capture_project_checkpoint(
        project,
        checkpoint_id="cp-001",
        scope="project",
        source_identity={"board_path": "demo.kicad_pcb"},
        source_revision={"board_revision": "rev-1"},
        semantic_state={"semantic_sha256": "semantic-1"},
    )

    manifest = json.loads(Path(result["manifest_path"]).read_text(encoding="utf-8"))
    assert manifest["checkpoint_id"] == "cp-001"
    assert manifest["scope"] == "project"
    assert manifest["source"]["identity"]["board_path"] == "demo.kicad_pcb"
    assert manifest["source"]["revision"]["board_revision"] == "rev-1"
    paths = {entry["path"] for entry in manifest["resources"]}
    assert "demo.kicad_pcb" in paths
    assert "demo.kicad_pro" in paths
    assert not any(path.startswith("logs/") for path in paths)
    assert validate_checkpoint(Path(result["checkpoint_path"]))["valid"] is True


@pytest.mark.parametrize("damage", ["missing", "corrupt", "hash"])
def test_checkpoint_validation_rejects_missing_corrupt_or_hash_mismatch(tmp_path, damage):
    project = tmp_path / "demo"
    project.mkdir()
    (project / "demo.kicad_pcb").write_text("(kicad_pcb original)", encoding="utf-8")
    result = capture_project_checkpoint(project, checkpoint_id="cp-bad")
    checkpoint = Path(result["checkpoint_path"])

    if damage == "missing":
        (checkpoint / "resources" / "demo.kicad_pcb").unlink()
    elif damage == "corrupt":
        (checkpoint / "manifest.json").write_text("{not-json", encoding="utf-8")
    else:
        (checkpoint / "resources" / "demo.kicad_pcb").write_text("tampered", encoding="utf-8")

    validation = validate_checkpoint(checkpoint)
    assert validation["valid"] is False


def test_restore_validates_then_restores_and_requires_semantic_verification(tmp_path):
    project = tmp_path / "demo"
    project.mkdir()
    board = project / "demo.kicad_pcb"
    board.write_text("(kicad_pcb checkpoint)", encoding="utf-8")
    result = capture_project_checkpoint(
        project,
        checkpoint_id="cp-restore",
        semantic_state={"semantic_sha256": "semantic-good"},
    )

    board.write_text("(kicad_pcb mutated)", encoding="utf-8")
    restored = restore_project_checkpoint(Path(result["checkpoint_path"]), project)
    assert restored["restored"] is True
    assert board.read_text(encoding="utf-8") == "(kicad_pcb checkpoint)"
    assert restored["checkpointed_atomic"] is False
    assert restored["requires_semantic_verification"] is True


def test_verified_restore_reopens_and_only_then_claims_checkpointed_atomic(tmp_path):
    project = tmp_path / "demo"
    project.mkdir()
    board = project / "demo.kicad_pcb"
    board.write_text("(kicad_pcb checkpoint)", encoding="utf-8")
    checkpoint = capture_project_checkpoint(
        project,
        checkpoint_id="cp-verified",
        source_identity={
            "project_dir": str(project.resolve()),
            "board_path": "demo.kicad_pcb",
        },
        semantic_state={"semantic_sha256": "semantic-good"},
    )
    board.write_text("(kicad_pcb mutated)", encoding="utf-8")

    reopen_calls = []

    def reopen(path):
        reopen_calls.append(path)
        return {"success": True, "boardPath": path, "_backend": "swig"}

    result = restore_verified_checkpoint(
        checkpoint["checkpoint_path"],
        project,
        reopen_board=reopen,
        read_semantics=lambda: {"semantic_sha256": "semantic-good"},
    )

    assert result["success"] is True
    assert result["restored"] is True
    assert result["semantic_verified"] is True
    assert result["checkpointed_atomic"] is True
    assert reopen_calls == [str(board.resolve())]
    assert board.read_text(encoding="utf-8") == "(kicad_pcb checkpoint)"


def test_verified_restore_rejects_wrong_source_identity_before_mutation(tmp_path):
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    source_board = source / "demo.kicad_pcb"
    source_board.write_text("(kicad_pcb checkpoint)", encoding="utf-8")
    target_board = target / "demo.kicad_pcb"
    target_board.write_text("(kicad_pcb target)", encoding="utf-8")

    checkpoint = capture_project_checkpoint(
        source,
        checkpoint_id="cp-source-bound",
        source_identity={
            "project_dir": str(source.resolve()),
            "board_path": "demo.kicad_pcb",
        },
        semantic_state={"semantic_sha256": "semantic-good"},
    )

    result = restore_verified_checkpoint(
        checkpoint["checkpoint_path"],
        target,
        reopen_board=lambda path: {"success": True, "boardPath": path},
        read_semantics=lambda: {"semantic_sha256": "semantic-good"},
    )

    assert result["success"] is False
    assert result["checkpointed_atomic"] is False
    assert "source identity" in result["message"]
    assert target_board.read_text(encoding="utf-8") == "(kicad_pcb target)"


def test_verified_restore_keeps_atomic_false_on_semantic_mismatch(tmp_path):
    project = tmp_path / "demo"
    project.mkdir()
    board = project / "demo.kicad_pcb"
    board.write_text("(kicad_pcb checkpoint)", encoding="utf-8")
    checkpoint = capture_project_checkpoint(
        project,
        checkpoint_id="cp-semantic-mismatch",
        source_identity={
            "project_dir": str(project.resolve()),
            "board_path": "demo.kicad_pcb",
        },
        semantic_state={"semantic_sha256": "semantic-good"},
    )
    board.write_text("(kicad_pcb mutated)", encoding="utf-8")

    result = restore_verified_checkpoint(
        checkpoint["checkpoint_path"],
        project,
        reopen_board=lambda path: {"success": True, "boardPath": path},
        read_semantics=lambda: {"semantic_sha256": "semantic-different"},
    )

    assert result["success"] is False
    assert result["restored"] is True
    assert result["semantic_verified"] is False
    assert result["checkpointed_atomic"] is False


def test_interface_restore_adapter_runs_verified_reopen_sequence(tmp_path, monkeypatch):
    import kicad_interface as interface_module

    project = tmp_path / "demo"
    project.mkdir()
    board = project / "demo.kicad_pcb"
    board.write_text("(kicad_pcb checkpoint)", encoding="utf-8")
    checkpoint = capture_project_checkpoint(
        project,
        checkpoint_id="cp-interface-adapter",
        source_identity={
            "project_dir": str(project.resolve()),
            "board_path": "demo.kicad_pcb",
        },
        semantic_state={"semantic_sha256": "semantic-good"},
    )
    board.write_text("(kicad_pcb mutated)", encoding="utf-8")

    iface = object.__new__(interface_module.KiCADInterface)
    iface._authoritative_board_path = lambda: str(board)
    reopen_calls = []
    iface._handle_open_board = lambda params: (
        reopen_calls.append(params["boardPath"])
        or {"success": True, "boardPath": params["boardPath"], "_backend": "swig"}
    )
    monkeypatch.setattr(
        interface_module,
        "capture_board_semantics",
        lambda _iface: {
            "semantic_sha256": "semantic-good",
            "semantic_valid": True,
            "owner_consistent": True,
        },
    )

    result = interface_module.KiCADInterface._handle_restore_checkpoint(
        iface, {"checkpointPath": checkpoint["checkpoint_path"]}
    )

    assert result["success"] is True
    assert result["checkpointed_atomic"] is True
    assert result["semantic_verified"] is True
    assert reopen_calls == [str(board.resolve())]
    assert board.read_text(encoding="utf-8") == "(kicad_pcb checkpoint)"
