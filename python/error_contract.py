"""Provider error contract — Canonical failure normalization.
Wing: code | Topic: provider_error_contract | Updated: 2026-09-18 10:25
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional

CANONICAL_ERROR_KINDS = {
    "authentication_error",
    "authorization_error",
    "validation_error",
    "not_found",
    "conflict",
    "rate_limited",
    "timeout",
    "provider_unavailable",
    "internal_error",
    "unsupported_capability",
}

_RETRYABLE_DEFAULTS = {
    "authentication_error": False,
    "authorization_error": False,
    "validation_error": False,
    "not_found": False,
    "conflict": False,
    "rate_limited": True,
    "timeout": True,
    "provider_unavailable": True,
    "internal_error": False,
    "unsupported_capability": False,
}

_LEGACY_ERROR_KIND_MAP = {
    "schematic_load_failed": "validation_error",
}

_DEPENDENCY_UNAVAILABLE_PHRASES = (
    "kicad-cli not found",
    "pcbnew not available",
    "kiCAD must be running".lower(),
    "kicad must be running",
    "ipc api enabled",
    "ipc backend is not available",
    "ipc backend unavailable",
    "not connected to kicad",
)

_CONFLICT_PHRASES = (
    "conflict",
    "already exists",
    "externally modified",
    "changed externally",
    "changed on disk",
    "overwrite=true",
    "stale",
)

_NOT_FOUND_PHRASES = (
    "not found",
    "could not find",
    "does not exist",
    "no such ",
)

_VALIDATION_PHRASES = (
    " is required",
    " are required",
    "missing required",
    "missing ",
    "must be ",
    "must provide",
    "invalid ",
    "provide ",
    "cannot be empty",
)

_UNSUPPORTED_COMMAND_PHRASES = (
    "unknown command:",
    "the specified command is not supported",
)

_TIMEOUT_PHRASES = (
    "timed out",
    "timeout",
)

_RATE_LIMIT_PHRASES = (
    "rate limit",
    "rate_limit",
    "too many requests",
    "http 429",
)


def _sanitize_diagnostic_text(value: str) -> str:
    """Remove internal Python diagnostics while preserving a safe summary."""

    sanitized = value
    sys_path_marker = "Python sys.path:"
    if sys_path_marker in sanitized:
        sanitized = sanitized.split(sys_path_marker, 1)[0].rstrip()

    traceback_marker = "Traceback (most recent call last):"
    if traceback_marker in sanitized:
        prefix, tail = sanitized.split(traceback_marker, 1)
        prefix = prefix.strip()
        if prefix:
            return prefix

        for line in reversed(tail.splitlines()):
            candidate = line.strip()
            if not candidate:
                continue
            if candidate.startswith('File "') or candidate.startswith("File '"):
                continue
            if candidate.startswith("^"):
                continue
            if candidate.startswith("~"):
                continue
            if candidate.startswith("raise "):
                continue
            return candidate
        return "Internal provider error"

    filtered_lines = [
        line
        for line in sanitized.splitlines()
        if not line.strip().startswith('File "')
        and not line.strip().startswith("File '")
    ]
    result = "\n".join(filtered_lines).strip()
    return result or "Internal provider error"


def _sanitize_value(value: Any) -> Any:
    if isinstance(value, str):
        return _sanitize_diagnostic_text(value)
    if isinstance(value, list):
        return [_sanitize_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_sanitize_value(item) for item in value)
    if isinstance(value, Mapping):
        return {key: _sanitize_value(item) for key, item in value.items()}
    return value


def _failure_text(result: Mapping[str, Any]) -> str:
    parts = []
    for key in ("message", "errorDetails", "error", "reason"):
        value = result.get(key)
        if isinstance(value, str):
            parts.append(value)
    return " ".join(parts).lower()


def _classify_legacy_failure(result: Mapping[str, Any], command: Optional[str]) -> str:
    explicit_legacy_error = result.get("error")
    if isinstance(explicit_legacy_error, str):
        mapped = _LEGACY_ERROR_KIND_MAP.get(explicit_legacy_error)
        if mapped:
            return mapped

    text = _failure_text(result)

    if any(phrase in text for phrase in _UNSUPPORTED_COMMAND_PHRASES):
        return "unsupported_capability"
    if any(phrase in text for phrase in _TIMEOUT_PHRASES):
        return "timeout"
    if any(phrase in text for phrase in _RATE_LIMIT_PHRASES):
        return "rate_limited"
    if any(phrase in text for phrase in _CONFLICT_PHRASES):
        return "conflict"
    if any(phrase in text for phrase in _DEPENDENCY_UNAVAILABLE_PHRASES):
        return "provider_unavailable"
    if any(phrase in text for phrase in _NOT_FOUND_PHRASES):
        return "not_found"
    if any(phrase in text for phrase in _VALIDATION_PHRASES):
        return "validation_error"

    if command is None:
        return "validation_error"

    return "internal_error"


def normalize_failure_response(
    result: Any,
    *,
    command: Optional[str] = None,
) -> Any:
    """Return a canonical, sanitized failure envelope.

    Successful and non-dict results pass through unchanged. Legacy failure
    payloads are classified conservatively; explicit canonical kinds always win.
    """

    if not isinstance(result, dict) or result.get("success") is not False:
        return result

    normalized: Dict[str, Any] = {
        key: _sanitize_value(value) for key, value in result.items()
    }

    explicit_kind = normalized.get("kind")
    if isinstance(explicit_kind, str) and explicit_kind in CANONICAL_ERROR_KINDS:
        kind = explicit_kind
    else:
        if isinstance(explicit_kind, str) and explicit_kind:
            normalized.setdefault("providerKind", explicit_kind)
        kind = _classify_legacy_failure(normalized, command)

    normalized["kind"] = kind

    explicit_retryable = normalized.get("retryable")
    if not isinstance(explicit_retryable, bool):
        normalized["retryable"] = _RETRYABLE_DEFAULTS[kind]

    message = normalized.get("message")
    if not isinstance(message, str) or not message.strip():
        for key in ("errorDetails", "reason", "error"):
            candidate = normalized.get(key)
            if isinstance(candidate, str) and candidate.strip():
                message = candidate
                break
        else:
            message = "KiCAD backend operation failed"
    normalized["message"] = message

    if "details" not in normalized and "errorDetails" in normalized:
        normalized["details"] = normalized["errorDetails"]

    return normalized
