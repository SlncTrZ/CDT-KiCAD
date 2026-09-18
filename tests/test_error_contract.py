"""Contract tests for canonical provider failures."""

from error_contract import normalize_failure_response


def test_validation_failure_gets_typed_non_retryable_contract():
    result = normalize_failure_response(
        {"success": False, "message": "boardPath is required"},
        command="open_board",
    )

    assert result["kind"] == "validation_error"
    assert result["retryable"] is False


def test_missing_file_is_not_found():
    result = normalize_failure_response(
        {"success": False, "message": "Board file not found: missing.kicad_pcb"},
        command="open_board",
    )

    assert result["kind"] == "not_found"
    assert result["retryable"] is False


def test_timeout_is_retryable():
    result = normalize_failure_response(
        {"success": False, "message": "kicad-cli timed out after 60 seconds"},
        command="export_gerbers",
    )

    assert result["kind"] == "timeout"
    assert result["retryable"] is True


def test_explicit_kind_wins_over_legacy_classifier():
    result = normalize_failure_response(
        {
            "success": False,
            "kind": "conflict",
            "retryable": False,
            "message": "state changed",
        },
        command="save_board",
    )

    assert result["kind"] == "conflict"
    assert result["retryable"] is False


def test_traceback_is_removed_from_outward_error_details():
    result = normalize_failure_response(
        {
            "success": False,
            "message": "Failed to update board origin",
            "errorDetails": (
                "boom\nTraceback (most recent call last):\n"
                '  File "C:/secret/project/python/kicad_interface.py", line 42, in handler\n'
                "    explode()\n"
                "RuntimeError: boom"
            ),
        },
        command="set_board_origin",
    )

    assert "Traceback" not in result["errorDetails"]
    assert 'File "' not in result["errorDetails"]
    assert "C:/secret/project" not in result["errorDetails"]
    assert result["errorDetails"] == "boom"


def test_python_sys_path_is_removed_from_outward_details():
    result = normalize_failure_response(
        {
            "success": False,
            "message": "Failed to initialize KiCad backend",
            "errorDetails": (
                "Import failed\n\n"
                "Python sys.path:\n"
                "/mnt/pc-dev/CDT-KiCAD/python\n"
                "/usr/lib/python3.12"
            ),
        },
        command="get_backend_state",
    )

    assert result["errorDetails"] == "Import failed"
    assert "sys.path" not in result["errorDetails"]
    assert "/mnt/pc-dev" not in result["errorDetails"]


def test_nested_diagnostic_details_are_sanitized_recursively():
    result = normalize_failure_response(
        {
            "success": False,
            "kind": "internal_error",
            "message": "backend failed",
            "details": {
                "diagnostic": (
                    "Traceback (most recent call last):\n"
                    '  File "/mnt/pc-dev/CDT-KiCAD/python/kicad_interface.py", line 42\n'
                    "RuntimeError: boom"
                )
            },
        },
        command="mystery",
    )

    assert result["details"]["diagnostic"] == "RuntimeError: boom"
    assert "/mnt/pc-dev" not in result["details"]["diagnostic"]


def test_legacy_failure_gets_message_and_canonical_details():
    result = normalize_failure_response(
        {
            "success": False,
            "error": "schematic_load_failed",
            "errorDetails": "Sheet is structurally invalid",
        },
        command="load_schematic",
    )

    assert result["kind"] == "validation_error"
    assert result["message"] == "Sheet is structurally invalid"
    assert result["details"] == "Sheet is structurally invalid"


def test_unknown_failure_fails_closed_as_internal_error():
    result = normalize_failure_response(
        {"success": False, "message": "Something unexpected happened"},
        command="mystery",
    )

    assert result["kind"] == "internal_error"
    assert result["retryable"] is False
