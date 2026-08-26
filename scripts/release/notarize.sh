#!/usr/bin/env bash
set -euo pipefail
PROFILE="${YISHU_NOTARY_PROFILE:-}"
APP="${1:-}"
if [[ -z "$PROFILE" || -z "$APP" ]]; then
  echo "usage: YISHU_NOTARY_PROFILE=… $0 /path/to/奕枢.app" >&2
  exit 2
fi
TMP="$(mktemp -d)"
ZIP="$TMP/yishu.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$APP"
echo "notarized $APP"
