#!/usr/bin/env python3
"""Compatibility entrypoint; the standalone plugin owns the implementation."""
import importlib.util
from pathlib import Path
import sys

_source = Path(__file__).parent / "plugins/agent-monitor/backend/agent_monitor.py"
_spec = importlib.util.spec_from_file_location(__name__, _source)
_module = importlib.util.module_from_spec(_spec)
sys.modules[__name__] = _module
_spec.loader.exec_module(_module)
