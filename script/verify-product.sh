#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-core}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

case "$MODE" in
  core|full) ;;
  *)
    echo "usage: $0 [core|full]" >&2
    exit 2
    ;;
esac

./script/check-product-boundaries.sh
pnpm dep:check
pnpm size:check
pnpm generated:check
pnpm arch:check
node script/check-capability-tools.mjs
pnpm --filter @yishu/kernel check
pnpm --filter @yishu/runtime check
pnpm --filter yishu-proxy check
pnpm --filter yishu-proxy test
pnpm --filter @yishu/kernel test:coverage
pnpm --filter @yishu/runtime test:coverage
swift test

if [[ "$MODE" == "full" ]]; then
  xcodebuild \
    -project apps/clicky/leanring-buddy.xcodeproj \
    -scheme leanring-buddy \
    -destination 'platform=macOS' \
    CODE_SIGNING_ALLOWED=NO \
    ENABLE_HARDENED_RUNTIME=NO \
    ENABLE_DEBUG_DYLIB=NO \
    test
  ./apps/clicky/scripts/run-local.sh self-test
fi

echo "Yishu product verification passed ($MODE)"
