"""Compatibility import for the plugin's sidebar adapter."""
import importlib.util
from pathlib import Path
import sys

_source = Path(__file__).parent / "plugins/agent-monitor/backend/sidebar_state.py"
_spec = importlib.util.spec_from_file_location(__name__, _source)
_module = importlib.util.module_from_spec(_spec)
sys.modules[__name__] = _module
_spec.loader.exec_module(_module)
