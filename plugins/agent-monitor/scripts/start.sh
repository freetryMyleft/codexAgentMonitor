#!/bin/bash
set -euo pipefail
plugin_dir="$(cd "$(dirname "$0")/.." && pwd)"
if command -v node >/dev/null 2>&1; then
  exec node "$plugin_dir/server.mjs"
fi
for node_binary in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$node_binary" ]; then exec "$node_binary" "$plugin_dir/server.mjs"; fi
done
printf 'Agent Monitor requires Node.js 20+.\n' >&2
exit 1
