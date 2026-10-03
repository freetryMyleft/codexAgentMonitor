#!/bin/bash
set -euo pipefail
plugin_dir="$(cd "$(dirname "$0")/.." && pwd)"
node_binary=""
if command -v node >/dev/null 2>&1; then
  node_binary="$(command -v node)"
fi
if [ -z "$node_binary" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then node_binary="$candidate"; break; fi
  done
fi
if [ -z "$node_binary" ] || ! "$node_binary" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  printf 'Agent Monitor requires Node.js 20+. Install Node and reopen the plugin.\n' >&2
  exit 1
fi
python_binary=""
for candidate in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' >/dev/null 2>&1; then
    python_binary="$candidate"; break
  fi
done
if [ -z "$python_binary" ]; then
  printf 'Agent Monitor requires Python 3.10+. Install Python and reopen the plugin.\n' >&2
  exit 1
fi
if [ ! -f "$plugin_dir/backend/desktop_bridge.py" ]; then
  printf 'Agent Monitor package is incomplete: Python reader is missing. Reinstall the plugin.\n' >&2
  exit 1
fi
if [ ! -f "$plugin_dir/runtime.mjs" ] || [ ! -f "$plugin_dir/dist/dashboard.html" ]; then
  # Released packages already contain both files and need no npm or network.
  export PATH="$(dirname "$node_binary"):$PATH"
  if ! command -v npm >/dev/null 2>&1 || [ ! -f "$plugin_dir/scripts/build.mjs" ]; then
    printf 'Source install requires npm to build. Alternatively install the prebuilt release package.\n' >&2
    exit 1
  fi
  if ! mkdir "$plugin_dir/.startup-lock" 2>/dev/null; then
    printf 'Plugin preparation is already running (or was interrupted). Retry later; if no setup is running, remove .startup-lock in the plugin directory.\n' >&2
    exit 1
  fi
  trap 'rmdir "$plugin_dir/.startup-lock"' EXIT
  printf 'Agent Monitor: preparing first launch (npm dependencies and local build)...\n' >&2
  (cd "$plugin_dir" && npm ci --ignore-scripts --no-audit --no-fund && npm run build) >&2
  rmdir "$plugin_dir/.startup-lock"
  trap - EXIT
fi
exec "$node_binary" "$plugin_dir/runtime.mjs"
