#!/usr/bin/env bash
set -euo pipefail
IDENTITY="${YISHU_DEVELOPER_ID_IDENTITY:-}"
APP="${1:-}"
if [[ -z "$IDENTITY" || -z "$APP" ]]; then
  echo "usage: YISHU_DEVELOPER_ID_IDENTITY='Developer ID Application: …' $0 /path/to/奕枢.app" >&2
  exit 2
fi
codesign --force --options runtime --sign "$IDENTITY" --timestamp "$APP"
echo "signed $APP"
