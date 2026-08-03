"""``util/run-plugins.py`` must not spawn a bus-connected copy of a plugin
that ``InProcessHost`` already loads in-process — see
``backend/skrib/plugin_bus/inprocess_host.py`` and ``util/start-plugins``,
which guards against the identical hazard for the subprocess launcher.
Two processes writing the same plugin's SQLite file is the failure mode.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent


def _load_run_plugins_module():
    """``run-plugins.py`` has a hyphen, so it can't be imported by name."""
    path = BACKEND_DIR / "util" / "run-plugins.py"
    spec = importlib.util.spec_from_file_location("run_plugins_script", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_discover_plugins_skips_in_process_runtime(capsys):
    module = _load_run_plugins_module()

    plugins = module.discover_plugins()

    ids = sorted(name for name, _ in plugins)
    assert "four43.room-type-chat" not in ids
    assert len(ids) == 6

    out = capsys.readouterr().out
    assert "four43.room-type-chat" in out
    assert "in_process" in out
