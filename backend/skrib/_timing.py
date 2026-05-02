"""Startup timing instrumentation.

Gated on ``SKRIB_TIMING=1`` env var. Each call to ``mark()`` prints one line
with milliseconds since process start and milliseconds since the previous
mark, so you can see both absolute offsets and phase deltas.
"""
from __future__ import annotations

import os
import sys
import time

_ENABLED = bool(os.environ.get("SKRIB_TIMING"))
_START = time.monotonic()
_LAST = _START


def enabled() -> bool:
    return _ENABLED


def mark(label: str) -> None:
    """Print a timing mark if SKRIB_TIMING=1. Tag lets tests grep for lines."""
    if not _ENABLED:
        return
    global _LAST
    now = time.monotonic()
    total_ms = (now - _START) * 1000
    delta_ms = (now - _LAST) * 1000
    _LAST = now
    tag = os.environ.get("SKRIB_TIMING_TAG", "backend")
    # flush=True so the line shows up ahead of any buffered log output
    print(f"[TIMING:{tag}] +{total_ms:8.1f}ms  (Δ{delta_ms:7.1f}ms)  {label}",
          file=sys.stderr, flush=True)


# Emit a marker the moment this module loads so we can measure import cost
mark("module loaded")
