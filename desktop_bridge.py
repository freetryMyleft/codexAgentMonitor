#!/usr/bin/env python3
"""Compatibility entrypoint for the plugin's persistent reader."""
import importlib.util
from pathlib import Path
import sys

_source = Path(__file__).parent / "plugins/agent-monitor/backend/desktop_bridge.py"
if "--catalog" in sys.argv:
    # The compatibility entrypoint also serves the sibling catalog module.
    sys.path.insert(0, str(_source.parent))
_spec = importlib.util.spec_from_file_location(__name__, _source)
_module = importlib.util.module_from_spec(_spec)
sys.modules[__name__] = _module
_spec.loader.exec_module(_module)
