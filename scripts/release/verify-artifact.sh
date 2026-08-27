#!/usr/bin/env bash
set -euo pipefail
APP="${1:-}"
if [[ -z "$APP" ]]; then
  echo "usage: $0 /path/to/奕枢.app" >&2
  exit 2
fi
test -d "$APP"
if [[ -f "$APP/Contents/Resources/.dev.vars" ]]; then
  echo "artifact contains .dev.vars" >&2
  exit 1
fi
if [[ -d "$APP/Contents/Resources/coverage" ]]; then
  echo "artifact contains coverage" >&2
  exit 1
fi
echo "artifact checks passed for $APP"
