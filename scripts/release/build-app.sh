#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VERSION="${YISHU_RELEASE_VERSION:-dev}"
OUT="${YISHU_RELEASE_DIR:-$ROOT/dist/release}"
mkdir -p "$OUT"
xcodebuild \
  -project apps/clicky/leanring-buddy.xcodeproj \
  -scheme leanring-buddy \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  CODE_SIGNING_ALLOWED="${CODE_SIGNING_ALLOWED:-NO}" \
  ENABLE_DEBUG_DYLIB=NO \
  BUILD_DIR="$OUT/build"
echo "built unsigned/release archive under $OUT for $VERSION"
