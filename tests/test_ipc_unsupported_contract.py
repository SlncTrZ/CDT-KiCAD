"""IPC-only calls must refuse explicitly on the SWIG execution lane."""
import pytest
from error_contract import normalize_failure_response
from kicad_interface import KiCADInterface

@pytest.mark.parametrize("command", [
    "ipc_add_track", "ipc_add_via", "ipc_add_text", "ipc_list_components",
    "ipc_get_tracks", "ipc_get_vias", "ipc_save_board",
])
def test_ipc_only_handler_refuses_swig_without_effect(command):
    iface = KiCADInterface.__new__(KiCADInterface)
    iface.use_ipc = False
    iface.ipc_board_api = None
    result = normalize_failure_response(
        getattr(iface, "_handle_" + command)({}), command=command
    )
    assert result["success"] is False
    assert result["kind"] == "unsupported_capability"
    assert result["retryable"] is False
