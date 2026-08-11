#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="Yishu"
BUNDLE_ID="com.yishu.yishu-lab"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_BINARY="$APP_MACOS/$APP_NAME"
INFO_PLIST="$APP_CONTENTS/Info.plist"
RUNTIME_MODE="${YISHU_RUNTIME_MODE:-${HANAKO_RUNTIME_MODE:-mock}}"
NODE_EXECUTABLE="${YISHU_NODE_EXECUTABLE:-${HANAKO_NODE_EXECUTABLE:-$(command -v node)}}"

pkill -x "$APP_NAME" >/dev/null 2>&1 || true

pnpm --dir "$ROOT_DIR" build
swift build --package-path "$ROOT_DIR" --product "$APP_NAME"
BUILD_BINARY="$(swift build --package-path "$ROOT_DIR" --show-bin-path)/$APP_NAME"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_MACOS" "$APP_RESOURCES/packages/runtime" "$APP_RESOURCES/packages/kernel" "$APP_RESOURCES/packages/agent-core"
cp "$BUILD_BINARY" "$APP_BINARY"
cp "$ROOT_DIR/apps/macos/Resources/Info.plist" "$INFO_PLIST"
cp "$ROOT_DIR/apps/macos/Resources/Yishu.png" "$APP_RESOURCES/Yishu.png"
cp -R "$ROOT_DIR/node_modules" "$APP_RESOURCES/node_modules"
# The runtime imports workspace packages (@yishu/kernel, @yishu/agent-core);
# their pnpm symlinks resolve as siblings under packages/, so ship them too.
cp -R "$ROOT_DIR/packages/runtime/dist" "$APP_RESOURCES/packages/runtime/dist"
cp -R "$ROOT_DIR/packages/runtime/node_modules" "$APP_RESOURCES/packages/runtime/node_modules"
cp "$ROOT_DIR/packages/runtime/package.json" "$APP_RESOURCES/packages/runtime/package.json"
cp -R "$ROOT_DIR/packages/kernel/dist" "$APP_RESOURCES/packages/kernel/dist"
cp -R "$ROOT_DIR/packages/kernel/node_modules" "$APP_RESOURCES/packages/kernel/node_modules"
cp "$ROOT_DIR/packages/kernel/package.json" "$APP_RESOURCES/packages/kernel/package.json"
cp -R "$ROOT_DIR/packages/agent-core/dist" "$APP_RESOURCES/packages/agent-core/dist"
cp -R "$ROOT_DIR/packages/agent-core/node_modules" "$APP_RESOURCES/packages/agent-core/node_modules"
cp "$ROOT_DIR/packages/agent-core/package.json" "$APP_RESOURCES/packages/agent-core/package.json"
chmod +x "$APP_BINARY"

/usr/libexec/PlistBuddy -c "Set :YishuRuntimeMode $RUNTIME_MODE" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Set :YishuNodeExecutable $NODE_EXECUTABLE" "$INFO_PLIST"
if [[ "${YISHU_AUTORUN_DEMO:-${HANAKO_AUTORUN_DEMO:-0}}" == "1" ]]; then
  /usr/libexec/PlistBuddy -c "Set :YishuAutorunDemo true" "$INFO_PLIST"
fi
if [[ "${YISHU_DISABLE_TTS:-${HANAKO_DISABLE_TTS:-0}}" == "1" ]]; then
  /usr/libexec/PlistBuddy -c "Set :YishuDisableTTS true" "$INFO_PLIST"
fi
if [[ "${YISHU_ENABLE_DEV_SHORTCUT:-0}" == "1" ]]; then
  /usr/libexec/PlistBuddy -c "Set :YishuGlobalShortcutEnabled true" "$INFO_PLIST"
fi

codesign --force --sign - --identifier "$BUNDLE_ID" "$APP_BUNDLE" >/dev/null

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    # Verify the development harness without exposing its flower presence or
    # menu-bar item beside the canonical Clicky product.
    YISHU_HEADLESS_VERIFY=1 "$APP_BINARY" >/dev/null 2>&1 &
    VERIFY_PID=$!
    cleanup_verify() {
      if kill -0 "$VERIFY_PID" >/dev/null 2>&1; then
        kill "$VERIFY_PID" >/dev/null 2>&1 || true
        wait "$VERIFY_PID" 2>/dev/null || true
      fi
    }
    trap cleanup_verify EXIT
    sleep 2
    kill -0 "$VERIFY_PID"
    pgrep -P "$VERIFY_PID" -x node >/dev/null
    cleanup_verify
    trap - EXIT
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
