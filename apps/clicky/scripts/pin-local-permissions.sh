#!/usr/bin/env bash
# Pin Clicky (奕枢) local permissions so rebuilds do not re-open System Settings.
#
# What this does (local machine only):
#   1) Ensure app is signed with stable "Shangqiuko Local Code Signing"
#   2) Install / refresh /Applications/奕枢.app (fixed path)
#   3) Write app UserDefaults so in-app permission gates stay open
#   4) Ensure user-level TCC mic row matches current csreq
#   5) Only with --system-tcc, request admin access to refresh system TCC
#      Accessibility / ScreenCapture / ListenEvent rows.
#
# Cannot invent first-time consent on a locked-down Mac without admin.
# After one successful pin, same cert + bundle id keeps grants across rebuilds.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
YISHU_REPO_ROOT_DEFAULT="$(cd "$ROOT/../.." && pwd)"
YISHU_CLICKY_DERIVED_DATA="${YISHU_CLICKY_DERIVED_DATA:-$YISHU_REPO_ROOT_DEFAULT/.build/clicky-derived-data}"
IDENTITY="Shangqiuko Local Code Signing"
BUNDLE_ID="com.yishu.yishu-buddy"
APP_PRODUCT_NAME="奕枢"
INSTALL_APP="/Applications/${APP_PRODUCT_NAME}.app"
LEGACY_INSTALL_APP="/Applications/Clicky.app"
CERT_HASH="9F34695EB8AD35A6B2CC1FEDCA08D559AECC8C11"
REQ="identifier \"${BUNDLE_ID}\" and certificate leaf = H\"${CERT_HASH}\""
USER_TCC="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
SYS_TCC="/Library/Application Support/com.apple.TCC/TCC.db"
CSREQ_BIN="$(mktemp -t clicky-csreq)"
trap 'rm -f "$CSREQ_BIN"' EXIT

need_identity() {
  if ! security find-identity -v -p codesigning 2>/dev/null | grep -Fq "$IDENTITY"; then
    echo "Missing signing identity: $IDENTITY" >&2
    exit 1
  fi
}

resolve_built_app() {
  local candidate="$YISHU_CLICKY_DERIVED_DATA/Build/Products/Debug/${APP_PRODUCT_NAME}.app"
  if [[ ! -x "$candidate/Contents/MacOS/${APP_PRODUCT_NAME}" ]]; then
    echo "No Debug ${APP_PRODUCT_NAME}.app in $YISHU_CLICKY_DERIVED_DATA. Run: $ROOT/scripts/run-local.sh build" >&2
    exit 1
  fi
  echo "$candidate"
}

install_fixed_path() {
  local src="$1"
  local src_abs dest_abs
  echo "Installing fixed path: $src → $INSTALL_APP (in-place overlay; will not delete the app first)"
  # Remove xattrs that break codesign on copy
  xattr -cr "$src" 2>/dev/null || true
  src_abs="$(cd "$src" && pwd)"
  dest_abs="$(cd "$INSTALL_APP" 2>/dev/null && pwd || true)"
  if [[ -n "$dest_abs" && "$src_abs" == "$dest_abs" ]]; then
    echo "Source is already $INSTALL_APP; signing in place"
  else
    # Overlay copy. Never `rm -rf` the destination first — a failed or
    # incomplete replace must not leave them without /Applications/奕枢.app.
    mkdir -p "$INSTALL_APP"
    ditto "$src" "$INSTALL_APP"
  fi
  xattr -cr "$INSTALL_APP" 2>/dev/null || true
  if [[ -d "$LEGACY_INSTALL_APP" ]]; then
    echo "Removing leftover $LEGACY_INSTALL_APP"
    rm -rf "$LEGACY_INSTALL_APP"
  fi
  local nested_code
  for nested_code in \
    "$INSTALL_APP/Contents/MacOS/${APP_PRODUCT_NAME}.debug.dylib" \
    "$INSTALL_APP/Contents/MacOS/__preview.dylib"; do
    if [[ -f "$nested_code" ]]; then
      codesign --force --sign "$IDENTITY" --timestamp=none \
        --options runtime "$nested_code"
    fi
  done
  codesign --force --sign "$IDENTITY" --timestamp=none \
    --options runtime \
    --entitlements "$ROOT/leanring-buddy/leanring-buddy.entitlements" \
    "$INSTALL_APP"
  codesign --verify --deep --strict "$INSTALL_APP"
  codesign -dv "$INSTALL_APP" 2>&1 | grep -E 'Authority=|Identifier=|TeamIdentifier=' || true
  codesign -d -r- "$INSTALL_APP" 2>&1 | head -3 || true
}

seed_user_defaults() {
  # In-app gates (not macOS TCC). Same bundle id → survives rebuilds once set.
  defaults write "$BUNDLE_ID" hasScreenContentPermission -bool true
  # Intro only. Do not fake first-success activation.
  defaults write "$BUNDLE_ID" hasSeenIntro -bool true
  defaults write "$BUNDLE_ID" hasSubmittedEmail -bool true
  defaults write "$BUNDLE_ID" com.learningbuddy.hasPreviouslyConfirmedScreenRecordingPermission -bool true
  echo "UserDefaults seeded for $BUNDLE_ID"
}

build_csreq() {
  /usr/bin/csreq -r="$REQ" -b "$CSREQ_BIN"
}

# Insert-or-refresh a row in a TCC database (hex blob).
upsert_tcc() {
  local db="$1"
  local service="$2"
  local hex
  hex="$(xxd -p -c 256 "$CSREQ_BIN" | tr -d '\n' | tr '[:lower:]' '[:upper:]')"
  # client_type 0 = bundle id
  # auth_value 2 = allowed
  # auth_reason 2 = user consent (typical)
  sqlite3 "$db" <<SQL
INSERT INTO access (
  service, client, client_type, auth_value, auth_reason, auth_version,
  csreq, indirect_object_identifier, flags, last_modified, last_reminded, boot_uuid
) VALUES (
  '$service', '$BUNDLE_ID', 0, 2, 2, 1,
  X'$hex', 'UNUSED', 0,
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  'UNUSED'
)
ON CONFLICT(service, client, client_type, indirect_object_identifier) DO UPDATE SET
  auth_value=2,
  auth_reason=2,
  auth_version=1,
  csreq=excluded.csreq,
  last_modified=CAST(strftime('%s','now') AS INTEGER);
SQL
}

pin_user_tcc() {
  build_csreq
  if [[ ! -f "$USER_TCC" ]]; then
    echo "No user TCC.db yet; skip mic pin"
    return 0
  fi
  upsert_tcc "$USER_TCC" "kTCCServiceMicrophone" || {
    echo "⚠️  user TCC mic upsert failed (schema may differ); continuing"
  }
  # Some macOS versions store screen capture in user TCC too.
  upsert_tcc "$USER_TCC" "kTCCServiceScreenCapture" 2>/dev/null || true
  echo "User TCC pinned for mic (and screen if schema allows)"
}

pin_system_tcc_with_admin() {
  build_csreq
  local hex sql_file
  hex="$(xxd -p -c 256 "$CSREQ_BIN" | tr -d '\n' | tr '[:lower:]' '[:upper:]')"
  sql_file="$(mktemp -t clicky-tcc-sql)"
  local services=(
    kTCCServiceAccessibility
    kTCCServiceScreenCapture
    kTCCServiceListenEvent
    kTCCServicePostEvent
  )
  local s
  : >"$sql_file"
  for s in "${services[@]}"; do
    cat >>"$sql_file" <<SQL
INSERT INTO access (
  service, client, client_type, auth_value, auth_reason, auth_version,
  csreq, indirect_object_identifier, flags, last_modified, last_reminded, boot_uuid
) VALUES (
  '$s', '$BUNDLE_ID', 0, 2, 2, 1,
  X'$hex', 'UNUSED', 0,
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  'UNUSED'
)
ON CONFLICT(service, client, client_type, indirect_object_identifier) DO UPDATE SET
  auth_value=2,
  auth_reason=2,
  auth_version=1,
  csreq=excluded.csreq,
  last_modified=CAST(strftime('%s','now') AS INTEGER);
SQL
  done

  if sudo -n true 2>/dev/null; then
    sudo sqlite3 "$SYS_TCC" <"$sql_file"
    rm -f "$sql_file"
    echo "System TCC pinned (sudo -n)"
    return 0
  fi

  # One admin password dialog; no Settings maze. Uses a file so hex/SQL is not escaped.
  if osascript -e "do shell script \"sqlite3 '$SYS_TCC' < '$sql_file'\" with administrator privileges"; then
    rm -f "$sql_file"
    echo "System TCC pinned (admin once)"
  else
    rm -f "$sql_file"
    echo "⚠️  System TCC pin skipped (no admin). Existing grants still checked below."
  fi
}

report_grants() {
  echo "--- TCC grants for $BUNDLE_ID ---"
  sqlite3 "$SYS_TCC" \
    "SELECT service, auth_value FROM access WHERE client='$BUNDLE_ID' ORDER BY service;" 2>/dev/null \
    || echo "(cannot read system TCC)"
  sqlite3 "$USER_TCC" \
    "SELECT service, auth_value FROM access WHERE client='$BUNDLE_ID' ORDER BY service;" 2>/dev/null \
    || true
}

main() {
  local source_mode="installed"
  local should_pin_system_tcc="0"
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      from-build)
        source_mode="from-build"
        ;;
      --system-tcc)
        should_pin_system_tcc="1"
        ;;
      *)
        echo "usage: $0 [from-build] [--system-tcc]" >&2
        exit 2
        ;;
    esac
    shift
  done

  need_identity
  local src
  if [[ -d "$INSTALL_APP" ]]; then
    src="$INSTALL_APP"
  fi
  if [[ "$source_mode" == "from-build" || ! -d "$INSTALL_APP" ]]; then
    src="$(resolve_built_app)"
  fi
  if [[ -z "${src:-}" ]]; then
    src="$(resolve_built_app)"
  fi

  install_fixed_path "$src"
  seed_user_defaults
  pin_user_tcc
  if [[ "$should_pin_system_tcc" == "1" ]]; then
    pin_system_tcc_with_admin
  else
    echo "System TCC unchanged; pass --system-tcc only when those grants need repair."
  fi
  report_grants
  echo "Done. Launch only: open -a 奕枢  (or $ROOT/scripts/run-local.sh open)"
}

main "$@"
