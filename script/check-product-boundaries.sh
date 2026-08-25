#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

require_literal() {
  local file="$1"
  local literal="$2"
  if ! grep -Fq -- "$literal" "$file"; then
    echo "Product boundary check failed: '$literal' missing from $file" >&2
    exit 1
  fi
}

reject_source_pattern() {
  local pattern="$1"
  local output status
  shift
  set +e
  output="$(rg -n --glob '!**/dist/**' --glob '!**/.build/**' "$pattern" "$@" 2>&1)"
  status=$?
  set -e
  if [[ $status -eq 0 ]]; then
    printf '%s\n' "$output" >&2
    echo "Product boundary check failed: forbidden source pattern '$pattern'" >&2
    exit 1
  fi
  if [[ $status -ne 1 ]]; then
    printf '%s\n' "$output" >&2
    echo "Product boundary check failed: source search could not complete" >&2
    exit "$status"
  fi
}

# One macOS app source. Shared Swift contracts live outside apps/.
require_literal "apps/clicky/leanring-buddy.xcodeproj/project.pbxproj" 'PRODUCT_BUNDLE_IDENTIFIER = "com.yishu.yishu-buddy"'
require_literal "Package.swift" 'path: "Sources/YishuContext"'
if [[ -e "apps/macos" ]]; then
  echo "Product boundary check failed: apps/macos must not recreate a second macOS app" >&2
  exit 1
fi
reject_source_pattern 'executableTarget|com\.yishu\.yishu-lab' Package.swift apps

# The canonical Clicky source always starts Pi behind the Product Kernel.
require_literal "apps/clicky/leanring-buddy/YishuAgentRuntimeClient.swift" 'environment["YISHU_RUNTIME_MODE"] = "pi"'
require_literal "apps/clicky/leanring-buddy/YishuAgentRuntimeClient.swift" 'environment["YISHU_PRODUCT_KERNEL"] = "1"'
require_literal "apps/clicky/scripts/run-local.sh" 'rm -rf -- "$bundle_root"'
require_literal "apps/clicky/scripts/run-local.sh" 'ENABLE_DEBUG_DYLIB=NO'

# Shipping Swift must not import the laboratory executor or resurrect Kairos.
reject_source_pattern '@yishu/agent-core|AgentCoreRuntime' apps/clicky/leanring-buddy
reject_source_pattern 'KairosBridgeClient|RunProgressPresenter|forceKairosRouting' apps packages

# Pi is the only production agent loop. The AgentCore book harness remains a
# standalone laboratory and must not be linked back into the Runtime package.
reject_source_pattern '@yishu/agent-core|AgentCoreRuntime' packages/runtime/src packages/runtime/package.json

# The canonical Clicky bundle may not copy the standalone AgentCore laboratory.
reject_source_pattern '@yishu/agent-core|packages/agent-core|AgentCoreRuntime' apps/clicky/scripts/run-local.sh

echo "Product boundary check passed: Clicky body -> Product Kernel -> Yishu runtime"

# Narrow-port ratchet: history, product-memory, and context-watch progression /
# cancellation left the raw store. Count the kernel.store token (not
# storeBackend). Remaining backdoors until later PRs: PKR other domains,
# delegation.ts (2 store + YishuStorePort), suggestion-loop still holds
# YishuKernel.
#
# Caps are ceilings: counts and allowlisted files may fall to zero. Only a new
# file or a count above the ceiling fails.
count_source_matches() {
  local pattern="$1"
  shift
  local output status
  set +e
  output="$(rg -o --glob '!**/dist/**' --glob '!**/.build/**' "$pattern" "$@" 2>&1)"
  status=$?
  set -e
  if [[ $status -eq 1 ]]; then
    printf '0'
    return
  fi
  if [[ $status -ne 0 ]]; then
    printf '%s\n' "$output" >&2
    echo "Product boundary check failed: source search could not complete" >&2
    exit "$status"
  fi
  printf '%s\n' "$output" | wc -l | tr -d '[:space:]'
}

# Hits may disappear. Reject only files outside the allowlist.
assert_files_in_allowlist() {
  local pattern="$1"
  local label="$2"
  shift 2
  local files status file allowed candidate
  set +e
  files="$(rg -l --glob '!**/dist/**' --glob '!**/.build/**' "$pattern" packages/runtime/src | sort)"
  status=$?
  set -e
  if [[ $status -eq 1 ]]; then
    return
  fi
  if [[ $status -ne 0 ]]; then
    printf '%s\n' "$files" >&2
    echo "Product boundary check failed: source search could not complete" >&2
    exit "$status"
  fi
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    allowed=0
    for candidate in "$@"; do
      if [[ "$file" == "$candidate" ]]; then
        allowed=1
        break
      fi
    done
    if [[ $allowed -eq 0 ]]; then
      echo "Product boundary check failed: $label appeared in a new runtime/src file" >&2
      printf '%s\n' "$file" >&2
      exit 1
    fi
  done <<< "$files"
}

PKR_STORE_COUNT="$(count_source_matches 'kernel\.store\b' packages/runtime/src/product-kernel-runtime.ts)"
if [[ "$PKR_STORE_COUNT" -gt 37 ]]; then
  echo "Product boundary check failed: product-kernel-runtime.ts kernel.store count $PKR_STORE_COUNT exceeds 37" >&2
  exit 1
fi

RUNTIME_STORE_COUNT="$(count_source_matches 'kernel\.store\b' packages/runtime/src)"
if [[ "$RUNTIME_STORE_COUNT" -gt 39 ]]; then
  echo "Product boundary check failed: packages/runtime/src kernel.store count $RUNTIME_STORE_COUNT exceeds 39" >&2
  exit 1
fi

assert_files_in_allowlist 'kernel\.store\b' 'kernel.store' \
  packages/runtime/src/delegation.ts \
  packages/runtime/src/product-kernel-runtime.ts

RUNTIME_STORE_PORT_COUNT="$(count_source_matches 'YishuStorePort\b' packages/runtime/src)"
if [[ "$RUNTIME_STORE_PORT_COUNT" -gt 2 ]]; then
  echo "Product boundary check failed: packages/runtime/src YishuStorePort count $RUNTIME_STORE_PORT_COUNT exceeds 2" >&2
  exit 1
fi

assert_files_in_allowlist 'YishuStorePort\b' 'YishuStorePort' \
  packages/runtime/src/delegation.ts

echo "Product boundary check passed: runtime kernel.store cap PKR<=37 src<=39 files<=delegation+PKR; YishuStorePort<=2 files<=delegation"
