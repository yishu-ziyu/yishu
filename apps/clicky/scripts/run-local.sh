#!/usr/bin/env bash
# Build + install + run 奕枢 (Clicky fork) with stable local signing + fixed path.
#
# TCC (mic / accessibility / screen) survives rebuilds when:
#   - identity stays "Shangqiuko Local Code Signing" (never adhoc "-")
#   - bundle id stays com.yishu.yishu-buddy
#   - daily launch is /Applications/Clicky.app (not a random DerivedData path)
#
# Usage:
#   ./scripts/run-local.sh          # build + install /Applications + open
#   ./scripts/run-local.sh build    # build only
#   ./scripts/run-local.sh install  # install last Debug product, preserve TCC
#   ./scripts/run-local.sh open     # open /Applications/Clicky.app only
#   ./scripts/run-local.sh pin      # explicitly repair system TCC (may ask admin)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
YISHU_REPO_ROOT_DEFAULT="$(cd "$ROOT/../.." && pwd)"
PROJECT="$ROOT/leanring-buddy.xcodeproj"
SCHEME="leanring-buddy"
CONFIG="Debug"
IDENTITY="Shangqiuko Local Code Signing"
INSTALL_APP="/Applications/Clicky.app"
YISHU_CLICKY_DERIVED_DATA="${YISHU_CLICKY_DERIVED_DATA:-$YISHU_REPO_ROOT_DEFAULT/.build/clicky-derived-data}"
YISHU_RUNTIME_ROOT="${YISHU_RUNTIME_ROOT:-$YISHU_REPO_ROOT_DEFAULT}"
YISHU_NODE_SOURCE="${YISHU_NODE_SOURCE:-$(command -v node || true)}"

if [[ -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
fi

MODE="${1:-run}"

need_identity() {
  if ! security find-identity -v -p codesigning 2>/dev/null | grep -Fq "$IDENTITY"; then
    echo "Missing code-signing identity: $IDENTITY" >&2
    exit 1
  fi
}

resolve_derived_app() {
  local candidate="$YISHU_CLICKY_DERIVED_DATA/Build/Products/Debug/Clicky.app"
  if [[ ! -x "$candidate/Contents/MacOS/Clicky" ]]; then
    echo "Clicky.app not found in $YISHU_CLICKY_DERIVED_DATA. Run: $0 build" >&2
    exit 1
  fi
  echo "$candidate"
}

bundle_yishu_runtime() {
  local app runtime_deploy bundle_root entitlements node_entitlements node_source
  app="$(resolve_derived_app)"

  if [[ ! -f "$YISHU_RUNTIME_ROOT/packages/runtime/package.json" ]]; then
    echo "Yishu runtime checkout missing: $YISHU_RUNTIME_ROOT" >&2
    exit 1
  fi
  if [[ ! -x "$YISHU_NODE_SOURCE" ]]; then
    echo "Yishu Node executable missing: $YISHU_NODE_SOURCE" >&2
    exit 1
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm is required to bundle Yishu Runtime" >&2
    exit 1
  fi

  YISHU_RUNTIME_TEMP_ROOT="$(mktemp -d /tmp/yishu-runtime-bundle.XXXXXX)"
  trap 'if [[ "${YISHU_RUNTIME_TEMP_ROOT:-}" == /tmp/yishu-runtime-bundle.* && -d "${YISHU_RUNTIME_TEMP_ROOT:-}" ]]; then rm -rf -- "$YISHU_RUNTIME_TEMP_ROOT"; fi' EXIT
  runtime_deploy="$YISHU_RUNTIME_TEMP_ROOT/runtime"
  bundle_root="$app/Contents/Resources/YishuRuntime"
  entitlements="$YISHU_RUNTIME_TEMP_ROOT/Clicky.entitlements.plist"
  node_entitlements="$YISHU_RUNTIME_TEMP_ROOT/Node.entitlements.plist"
  node_source="$(realpath "$YISHU_NODE_SOURCE")"

  echo "Bundling Yishu Runtime + Pi into Clicky.app"
  (
    cd "$YISHU_RUNTIME_ROOT"
    # Build only the packages embedded in Clicky. The workspace also contains
    # unrelated packages; the root recursive build must not make this app's
    # bundle depend on them. Runtime depends on @yishu/kernel for product
    # actions / ContextTrail / SQLite store.
    pnpm --filter @yishu/agent-core build
    pnpm --filter @yishu/kernel build
    pnpm --filter @yishu/runtime build
    pnpm --filter=@yishu/runtime deploy --prod --legacy "$runtime_deploy"
  )

  # pnpm deploy adds a workspace self-link that points outside the deployed
  # package after copying. It is unnecessary at runtime and breaks codesign's
  # deep traversal, so remove only that exact generated link.
  rm -f -- "$runtime_deploy/node_modules/.pnpm/node_modules/@yishu/runtime"

  mkdir -p "$bundle_root/runtime" "$bundle_root/bin"
  ditto "$runtime_deploy" "$bundle_root/runtime"
  rm -f -- "$bundle_root/runtime/node_modules/.pnpm/node_modules/@yishu/runtime"
  ditto "$node_source" "$bundle_root/bin/node"
  chmod 755 "$bundle_root/bin/node"

  # The official Node binary is hardened with V8/JIT entitlements. Preserve
  # those entitlements when replacing its signature with the app's stable
  # local identity; stripping them makes the bundled sidecar trap at launch.
  codesign -d --entitlements "$node_entitlements" --xml "$node_source"

  # Sign executable Mach-O payloads explicitly with the same local identity.
  # Avoid `codesign --deep` for signing: it can leave the debug launcher and
  # Clicky.debug.dylib with incompatible library-validation identities.
  while IFS= read -r candidate; do
    if file -b "$candidate" | grep -q "Mach-O"; then
      if [[ "$candidate" == "$bundle_root/bin/node" ]]; then
        codesign \
          --force \
          --sign "$IDENTITY" \
          --timestamp=none \
          -o runtime \
          --entitlements "$node_entitlements" \
          --generate-entitlement-der \
          "$candidate"
      else
        codesign \
          --force \
          --sign "$IDENTITY" \
          --timestamp=none \
          -o runtime \
          --generate-entitlement-der \
          "$candidate"
      fi
    fi
  done < <(find "$bundle_root" -type f -perm -111)

  # Fail the package step immediately if Node lost the entitlements required
  # to start V8 under the hardened runtime.
  "$bundle_root/bin/node" --version >/dev/null

  # Bundle the local voice proxy (8787) source only — never .dev.vars / secrets.
  local voice_proxy_src="$ROOT/worker"
  local voice_proxy_bundle="$app/Contents/Resources/YishuVoiceProxy"
  if [[ ! -f "$voice_proxy_src/local-server.mjs" || ! -f "$voice_proxy_src/stepfun-hotwords.mjs" ]]; then
    echo "Voice proxy sources missing under $voice_proxy_src" >&2
    exit 1
  fi
  mkdir -p "$voice_proxy_bundle"
  ditto "$voice_proxy_src/local-server.mjs" "$voice_proxy_bundle/local-server.mjs"
  ditto "$voice_proxy_src/stepfun-hotwords.mjs" "$voice_proxy_bundle/stepfun-hotwords.mjs"
  rm -f -- "$voice_proxy_bundle/.dev.vars" "$voice_proxy_bundle/.env"
  echo "Bundled YishuVoiceProxy (no secrets)"

  codesign -d --entitlements "$entitlements" --xml "$app"
  codesign \
    --force \
    --sign "$IDENTITY" \
    --timestamp=none \
    -o runtime \
    --entitlements "$entitlements" \
    --generate-entitlement-der \
    "$app"
  codesign --verify --deep --strict "$app"

  rm -rf -- "$YISHU_RUNTIME_TEMP_ROOT"
  YISHU_RUNTIME_TEMP_ROOT=""
  trap - EXIT
}

build() {
  need_identity
  echo "Building $SCHEME ($CONFIG) signed as: $IDENTITY"
  xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration "$CONFIG" \
    -destination 'platform=macOS,arch=arm64' \
    -derivedDataPath "$YISHU_CLICKY_DERIVED_DATA" \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY="$IDENTITY" \
    DEVELOPMENT_TEAM= \
    OTHER_CODE_SIGN_FLAGS="--timestamp=none" \
    build
  bundle_yishu_runtime
}

# Formal install only. Dev/DerivedData Clicky must never match this path.
FORMAL_CLICKY_EXE="${INSTALL_APP}/Contents/MacOS/Clicky"

# True when process args or txt path is the formal /Applications Clicky binary.
# Never matches DerivedData / .build / other same-named binaries.
is_formal_clicky_pid() {
  local pid="$1"
  local args txt
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  args="$(ps -p "$pid" -ww -o args= 2>/dev/null || true)"
  if [[ "$args" == "$FORMAL_CLICKY_EXE" || "$args" == "$FORMAL_CLICKY_EXE "* ]]; then
    return 0
  fi
  # Fallback: binary path via lsof txt (covers short argv forms).
  txt="$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | grep -E '/Clicky\.app/Contents/MacOS/Clicky$' | head -1 || true)"
  if [[ "$txt" == "$FORMAL_CLICKY_EXE" ]]; then
    return 0
  fi
  return 1
}

# PIDs of the formal /Applications/Clicky.app only (never pgrep -x Clicky).
# Fast path: only inspect processes whose args mention Clicky.
list_formal_clicky_pids() {
  local pid args
  while IFS= read -r line; do
    # pid is first field; remainder is args (may contain spaces).
    pid="$(printf '%s\n' "$line" | awk '{print $1}')"
    args="$(printf '%s\n' "$line" | sed -E 's/^[[:space:]]*[0-9]+[[:space:]]+//')"
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if [[ "$args" == "$FORMAL_CLICKY_EXE" || "$args" == "$FORMAL_CLICKY_EXE "* ]]; then
      echo "$pid"
      continue
    fi
    # Short argv "Clicky" — resolve via txt path before accepting.
    if [[ "$args" == "Clicky" || "$args" == "Clicky "* ]]; then
      if is_formal_clicky_pid "$pid"; then
        echo "$pid"
      fi
    fi
  done < <(ps -ax -o pid= -o args= 2>/dev/null | grep -F 'Clicky' || true)
}

# True (exit 0) only when a confirmed Yishu voice-proxy PID is a *true orphan*:
# PPID=1 (reparented to launchd) or recorded parent process is gone.
# Active shell-started workers and live Clicky/dev parents are preserved.
# PPID unreadable → NOT orphan (fail closed).
yishu_voice_proxy_is_true_orphan() {
  local pid="$1"
  local ppid
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  if ! kill -0 "$pid" 2>/dev/null; then
    # Process already gone — treat as cleanable no-op for callers.
    return 0
  fi
  ppid="$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -z "$ppid" ]]; then
    # PPID unreadable while process lives → unknown, refuse reclaim.
    return 1
  fi
  if [[ "$ppid" == "1" ]]; then
    return 0
  fi
  # parentPID 0 or non-numeric is unknown — fail closed.
  if ! [[ "$ppid" =~ ^[0-9]+$ ]] || [[ "$ppid" -le 0 ]]; then
    return 1
  fi
  if kill -0 "$ppid" 2>/dev/null; then
    return 1
  fi
  return 0
}

# Terminate only true-orphan 奕枢 voice-proxy listeners (8787).
# Never kill: foreign Node, live shell workers, or proxies with a live parent.
# Path alone is never enough to kill (Codex rework: PPID/parent liveness required).
reclaim_yishu_voice_proxy_orphans() {
  local pid cmd ppid seen
  seen="|"
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    case "$seen" in
      *"|$pid|"*) continue ;;
    esac
    seen="${seen}${pid}|"
    cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)
    [[ -n "$cmd" ]] || continue
    # Only Yishu voice proxy entry markers.
    if [[ "$cmd" != *YishuVoiceProxy/local-server.mjs* && "$cmd" != *apps/clicky/worker/local-server.mjs* ]]; then
      continue
    fi
    ppid="$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d '[:space:]' || true)"
    if ! yishu_voice_proxy_is_true_orphan "$pid"; then
      echo "Preserving live-parent VoiceProxy pid=$pid ppid=${ppid:-?} (not orphan)"
      continue
    fi
    echo "Reclaiming orphan VoiceProxy pid=$pid ppid=${ppid:-?} (parent gone or launchd)"
    kill "$pid" 2>/dev/null || true
    sleep 0.2
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  done < <(
    {
      lsof -nP -iTCP:8787 -sTCP:LISTEN -t 2>/dev/null || true
      pgrep -f 'YishuVoiceProxy/local-server\.mjs|apps/clicky/worker/local-server\.mjs' 2>/dev/null || true
    } | sort -u
  )
}

# Quit only the formal /Applications/Clicky.app tree. Never pkill -x Clicky.
# Dev/DerivedData Clicky and unrelated same-named processes are preserved.
quit_running_clicky() {
  local app_pid
  local -a formal_pids=()
  local -a runtime_tree=()

  while IFS= read -r app_pid; do
    [[ "$app_pid" =~ ^[0-9]+$ ]] || continue
    formal_pids+=("$app_pid")
  done < <(list_formal_clicky_pids)

  if ((${#formal_pids[@]} == 0)); then
    echo "No formal $INSTALL_APP running (dev Clicky left untouched)."
    reclaim_yishu_voice_proxy_orphans
    return 0
  fi

  echo "Quitting formal Clicky only (path=$FORMAL_CLICKY_EXE) pids=${formal_pids[*]}..."
  while IFS= read -r app_pid; do
    [[ "$app_pid" =~ ^[0-9]+$ ]] || continue
    runtime_tree+=("$app_pid")
  done < <(collect_clicky_descendants)

  # SIGTERM formal tree only — never pgrep/pkill -x Clicky.
  if ((${#runtime_tree[@]} > 0)); then
    kill "${runtime_tree[@]}" 2>/dev/null || true
  fi
  sleep 0.5
  # Escalate only remaining formal PIDs still alive.
  for app_pid in "${formal_pids[@]}"; do
    if kill -0 "$app_pid" 2>/dev/null && is_formal_clicky_pid "$app_pid"; then
      kill -9 "$app_pid" 2>/dev/null || true
    fi
  done
  reclaim_yishu_voice_proxy_orphans
}

install_and_pin() {
  need_identity
  # Install must not leave an older formal instance as "the app".
  quit_running_clicky
  bash "$ROOT/scripts/pin-local-permissions.sh" from-build
  seed_voice_proxy_credentials
  reclaim_yishu_voice_proxy_orphans
}

seed_voice_proxy_credentials() {
  # Copy local worker secrets into Application Support when missing.
  # Never prints values. Never packages secrets into the app bundle.
  local src="$ROOT/worker/.dev.vars"
  local dest_dir="${HOME}/Library/Application Support/Yishu/Worker"
  local dest="$dest_dir/.dev.vars"
  if [[ ! -f "$src" ]]; then
    echo "Note: no $src — voice proxy will need $dest at runtime" >&2
    return 0
  fi
  mkdir -p "$dest_dir"
  if [[ ! -f "$dest" ]]; then
    cp "$src" "$dest"
    chmod 600 "$dest"
    echo "Seeded voice proxy credentials path (values not logged)"
  else
    # Keep the existing installed credentials as the source of truth.
    chmod 600 "$dest" 2>/dev/null || true
  fi
}

# Alias used by open_app: same PPID-safe policy as reclaim_yishu_voice_proxy_orphans.
reclaim_voice_proxy_orphans() {
  reclaim_yishu_voice_proxy_orphans
  sleep 0.2
}

# Collect formal /Applications/Clicky.app + its descendants only.
# Never seeds the queue with pgrep -x Clicky (would include dev builds).
collect_clicky_descendants() {
  local -a queue=()
  local -a all=()
  local pid child
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    queue+=("$pid")
  done < <(list_formal_clicky_pids)

  while ((${#queue[@]} > 0)); do
    pid="${queue[0]}"
    queue=("${queue[@]:1}")
    all+=("$pid")
    while IFS= read -r child; do
      [[ "$child" =~ ^[0-9]+$ ]] || continue
      queue+=("$child")
    done < <(pgrep -P "$pid" 2>/dev/null || true)
  done

  if ((${#all[@]} > 0)); then
    printf '%s\n' "${all[@]}"
  fi
}

# Report whether 8787 is held by a non-orphan (for install/open gating + tests).
# Prints a clear message and returns 0 when busy with a live parent; 1 when free/orphan-only.
report_8787_live_parent_busy() {
  local holder holder_args holder_ppid
  holder="$(lsof -nP -iTCP:8787 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [[ -z "$holder" ]]; then
    return 1
  fi
  holder_args="$(ps -p "${holder}" -o args= 2>/dev/null || true)"
  holder_ppid="$(ps -p "${holder}" -o ppid= 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$holder_args" != *YishuVoiceProxy/local-server.mjs* && "$holder_args" != *apps/clicky/worker/local-server.mjs* ]]; then
    echo "Port 8787 is held by a non-Yishu process (PID ${holder}). Free it manually, then re-run." >&2
    return 0
  fi
  if yishu_voice_proxy_is_true_orphan "$holder"; then
    return 1
  fi
  echo "Port 8787 is held by a live-parent Yishu voice proxy (PID ${holder}, PPID ${holder_ppid:-?}). Free it manually, then re-run." >&2
  return 0
}

open_app() {
  local app="$INSTALL_APP"
  local -a runtime_tree=()
  if [[ ! -d "$app" ]]; then
    echo "No $app — installing from last build..."
    install_and_pin
  fi
  seed_voice_proxy_credentials
  echo "Signed as:"
  codesign -dv "$app" 2>&1 | grep -E 'Authority=|Signature=|Identifier=' || true

  # Must quit the running *formal* instance before open, otherwise the old binary
  # keeps running while /Applications/Clicky.app on disk is already newer.
  # Never pkill -x Clicky — dev builds must survive.
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    runtime_tree+=("$pid")
  done < <(collect_clicky_descendants)

  if ((${#runtime_tree[@]} > 0)); then
    echo "Stopping formal Clicky tree only: ${runtime_tree[*]}"
    kill "${runtime_tree[@]}" 2>/dev/null || true
  fi
  reclaim_voice_proxy_orphans
  sleep 0.4

  # Refuse to launch while a non-orphan still owns 8787 (do not kill live parents).
  if report_8787_live_parent_busy; then
    exit 1
  fi
  # Last-chance reclaim for true orphans only, then re-check.
  reclaim_voice_proxy_orphans
  sleep 0.3
  if report_8787_live_parent_busy; then
    exit 1
  fi

  open -n "$app"
  echo "Launched: $app (must be the binary just installed at $app)"
}

# ---------------------------------------------------------------------------
# Script-level self-test (no real process kills of foreign Clicky).
# Proves path scoping, orphan gate, and 8787 busy reporting logic.
# ---------------------------------------------------------------------------
run_local_self_test() {
  local failures=0
  local tmpdir dev_stub formal_stub

  assert_true() {
    local name="$1"
    shift
    if "$@"; then
      echo "PASS: $name"
    else
      echo "FAIL: $name" >&2
      failures=$((failures + 1))
    fi
  }
  assert_false() {
    local name="$1"
    shift
    if "$@"; then
      echo "FAIL: $name (expected false)" >&2
      failures=$((failures + 1))
    else
      echo "PASS: $name"
    fi
  }

  # 1) Path filter: formal exe matches, dev path does not.
  tmpdir="$(mktemp -d /tmp/yishu-run-local-selftest.XXXXXX)"
  formal_stub="$tmpdir/formal_args.txt"
  dev_stub="$tmpdir/dev_args.txt"
  printf '%s\n' "$FORMAL_CLICKY_EXE" >"$formal_stub"
  printf '%s\n' "$YISHU_CLICKY_DERIVED_DATA/Build/Products/Debug/Clicky.app/Contents/MacOS/Clicky" >"$dev_stub"

  # Unit: string match helpers via synthetic args (is_formal_clicky_pid needs live PID;
  # test the path constants and pure orphan predicate with known-good math).
  assert_true "formal exe path is under /Applications/Clicky.app" \
    bash -c "[[ \"$FORMAL_CLICKY_EXE\" == /Applications/Clicky.app/Contents/MacOS/Clicky ]]"
  assert_false "derived-data path must not equal formal exe" \
    bash -c "[[ \"$YISHU_CLICKY_DERIVED_DATA/Build/Products/Debug/Clicky.app/Contents/MacOS/Clicky\" == \"$FORMAL_CLICKY_EXE\" ]]"

  # 2) No *executable* pgrep/pkill -x Clicky (comments and this self-test may mention the ban).
  # Only flag lines that invoke the tools, not prose in echo/assert strings.
  local hits
  hits="$(
    awk '
      /^[[:space:]]*#/ { next }
      /run_local_self_test/ { in_self=1 }
      in_self && /^}/ { in_self=0; next }
      in_self { next }
      # Match real invocations: optional sudo, then pgrep/pkill -x Clicky
      /^[[:space:]]*(sudo[[:space:]]+)?pgrep[[:space:]]+-x[[:space:]]+Clicky/ {
        print NR": "$0; found=1
      }
      /^[[:space:]]*(sudo[[:space:]]+)?pkill[[:space:]]+-x[[:space:]]+Clicky/ {
        print NR": "$0; found=1
      }
      # Also catch pipelines / if conditions that call them
      /[^[:alnum:]_]pgrep[[:space:]]+-x[[:space:]]+Clicky/ {
        if ($0 !~ /echo / && $0 !~ /#/ && $0 !~ /never/ && $0 !~ /Never/) {
          print NR": "$0; found=1
        }
      }
      /[^[:alnum:]_]pkill[[:space:]]+-x[[:space:]]+Clicky/ {
        if ($0 !~ /echo / && $0 !~ /#/ && $0 !~ /never/ && $0 !~ /Never/) {
          print NR": "$0; found=1
        }
      }
      END { exit found ? 0 : 1 }
    ' "$ROOT/scripts/run-local.sh" || true
  )"
  if [[ -n "$hits" ]]; then
    echo "FAIL: executable pgrep/pkill -x Clicky still present:" >&2
    echo "$hits" >&2
    failures=$((failures + 1))
  else
    echo "PASS: executable lines free of pgrep/pkill -x Clicky"
  fi

  # 3) Orphan predicate: our own shell is not an orphan (live parent).
  assert_false "current shell is not a true orphan" yishu_voice_proxy_is_true_orphan "$$"

  # 4) Live-parent 8787: if a live-parent proxy holds 8787, report busy and do not reclaim it.
  local holder holder_ppid holder_before
  holder="$(lsof -nP -iTCP:8787 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [[ -n "$holder" ]] && ! yishu_voice_proxy_is_true_orphan "$holder"; then
    holder_before="$holder"
    holder_ppid="$(ps -p "$holder" -o ppid= 2>/dev/null | tr -d '[:space:]' || true)"
    if report_8787_live_parent_busy 2>/tmp/yishu-8787-busy-msg.txt; then
      if grep -q 'live-parent\|non-Yishu' /tmp/yishu-8787-busy-msg.txt; then
        echo "PASS: report_8787_live_parent_busy names live parent (PID $holder_before PPID ${holder_ppid:-?})"
      else
        echo "FAIL: busy report missing live-parent wording" >&2
        cat /tmp/yishu-8787-busy-msg.txt >&2 || true
        failures=$((failures + 1))
      fi
    else
      echo "FAIL: expected 8787 live-parent busy report" >&2
      failures=$((failures + 1))
    fi
    reclaim_yishu_voice_proxy_orphans
    if kill -0 "$holder_before" 2>/dev/null; then
      echo "PASS: reclaim left live-parent VoiceProxy pid=$holder_before intact"
    else
      echo "FAIL: reclaim killed live-parent VoiceProxy pid=$holder_before" >&2
      failures=$((failures + 1))
    fi
  else
    echo "SKIP: no live-parent 8787 holder right now (busy preserve path not exercised live)"
  fi

  # 5) list_formal_clicky_pids never returns a process whose args are DerivedData.
  local bad=0
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    args="$(ps -p "$pid" -ww -o args= 2>/dev/null || true)"
    if [[ "$args" == *"/DerivedData/"* || "$args" == *"/.build/"* || "$args" == *"/clicky-derived-data/"* ]]; then
      echo "FAIL: list_formal_clicky_pids returned build product pid=$pid args=$args" >&2
      bad=1
    fi
  done < <(list_formal_clicky_pids)
  if [[ "$bad" -eq 0 ]]; then
    echo "PASS: list_formal_clicky_pids excludes DerivedData/.build"
  else
    failures=$((failures + 1))
  fi

  rm -rf -- "$tmpdir"
  if [[ "$failures" -gt 0 ]]; then
    echo "run-local self-test FAILED ($failures)" >&2
    return 1
  fi
  echo "run-local self-test PASSED"
  return 0
}

case "$MODE" in
  build)
    build
    ;;
  install)
    install_and_pin
    ;;
  pin)
    bash "$ROOT/scripts/pin-local-permissions.sh" --system-tcc
    ;;
  open)
    open_app
    ;;
  self-test)
    run_local_self_test
    ;;
  run|"")
    build
    install_and_pin
    open_app
    ;;
  *)
    echo "usage: $0 [run|build|install|pin|open|self-test]" >&2
    exit 2
    ;;
esac
