#!/usr/bin/env bash
# Explicit, one-time migration performed by the signed formal App itself.

set -euo pipefail

if [[ "${1:-}" != "--confirm" ]]; then
  echo "Refusing to migrate. Re-run with --confirm after reviewing the config." >&2
  exit 2
fi

APP_EXECUTABLE="/Applications/奕枢.app/Contents/MacOS/奕枢"
if [[ ! -x "$APP_EXECUTABLE" ]]; then
  echo "Formal 奕枢.app is not installed." >&2
  exit 1
fi

exec "$APP_EXECUTABLE" --migrate-model-config --confirm
