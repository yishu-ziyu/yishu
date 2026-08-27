#!/usr/bin/env bash
set -euo pipefail
APP="${1:-}"
OUT="${2:-dist/release/Yishu.dmg}"
if [[ -z "$APP" ]]; then
  echo "usage: $0 /path/to/奕枢.app [out.dmg]" >&2
  exit 2
fi
mkdir -p "$(dirname "$OUT")"
hdiutil create -volname "奕枢" -srcfolder "$APP" -ov -format UDZO "$OUT"
echo "wrote $OUT"
