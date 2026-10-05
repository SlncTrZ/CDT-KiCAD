"""Fail-closed ceiling tests for autoroute's unbound-DoS caps.

The MCP tool schema (``src/tools/freerouting.ts``) and the Node budget
(``src/command-timeout.ts``) enforce ``timeout <= 1800`` and ``attempts <= 10``.
The worker must enforce the same ceilings: a caller reaching the Python bridge
directly (stale client, raw bridge) gets a validation error, never a longer
run. Rejection happens before the JAR-existence check, so over-ceiling asks
fail without touching disk or spawning anything — the "JAR not found" probe
below pins that ordering for in-ceiling values.
"""

import math
import sys
from typing import Any
from unittest.mock import MagicMock

import pytest

from commands.freerouting import (
    AUTOROUTE_MAX_ATTEMPTS,
    AUTOROUTE_MAX_TIMEOUT_SEC,
    FreeroutingCommands,
    _coerce_autoroute_timeout,
)

pcbnew_mock = sys.modules["pcbnew"]


@pytest.fixture
def cmds() -> Any:
    board = MagicMock()
    board.GetFileName.return_value = "/tmp/test_project/test.kicad_pcb"
    return FreeroutingCommands(board=board)


@pytest.mark.unit
class TestAutorouteTimeoutCeiling:
    @pytest.mark.parametrize(
        "raw",
        [0, -1, -0.5, 1800.5, 3600, float("inf"), float("nan"), "abc", None, True, [300]],
    )
    def test_over_ceiling_or_nonsense_is_rejected(self, cmds: Any, raw: Any) -> None:
        out = cmds.autoroute({"timeout": raw, "freeroutingJar": "/nonexistent.jar"})
        assert out["success"] is False
        assert "Invalid timeout" in out["message"]

    def test_ceiling_constants_match_schema_and_budget(self) -> None:
        assert AUTOROUTE_MAX_TIMEOUT_SEC == 1800
        assert AUTOROUTE_MAX_ATTEMPTS == 10

    @pytest.mark.parametrize("raw,expected", [(1, 1.0), (300, 300.0), (1800, 1800.0), ("60", 60.0)])
    def test_in_ceiling_values_coerce(self, raw: Any, expected: float) -> None:
        assert _coerce_autoroute_timeout(raw) == expected
        assert math.isfinite(_coerce_autoroute_timeout(raw))

    def test_ceiling_value_passes_worker_validation(self, cmds: Any) -> None:
        # 1800 must get PAST validation: the next check (JAR existence) fires.
        out = cmds.autoroute({"timeout": 1800, "freeroutingJar": "/nonexistent.jar"})
        assert out["success"] is False
        assert "JAR not found" in out["message"]


@pytest.mark.unit
class TestAutorouteAttemptsCeiling:
    @pytest.mark.parametrize("attempts", [11, 100, 10**9])
    def test_over_ceiling_is_rejected_before_jar_check(self, cmds: Any, attempts: int) -> None:
        out = cmds.autoroute({"attempts": attempts, "freeroutingJar": "/nonexistent.jar"})
        assert out["success"] is False
        assert "Invalid attempts" in out["message"]
        assert str(AUTOROUTE_MAX_ATTEMPTS) in out["errorDetails"]

    @pytest.mark.parametrize("attempts", [0, -3])
    def test_below_floor_still_rejected(self, cmds: Any, attempts: int) -> None:
        out = cmds.autoroute({"attempts": attempts, "freeroutingJar": "/nonexistent.jar"})
        assert out["success"] is False
        assert "Invalid attempts" in out["message"]

    def test_ceiling_value_passes_worker_validation(self, cmds: Any) -> None:
        # attempts=10 must get PAST validation: the next check (JAR) fires.
        out = cmds.autoroute({"attempts": 10, "freeroutingJar": "/nonexistent.jar"})
        assert out["success"] is False
        assert "JAR not found" in out["message"]
