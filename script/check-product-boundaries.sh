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

# One shipping body and one deliberately separate development shell.
require_literal "apps/clicky/leanring-buddy.xcodeproj/project.pbxproj" 'PRODUCT_BUNDLE_IDENTIFIER = "com.yishu.yishu-buddy"'
require_literal "apps/macos/Resources/Info.plist" '<string>com.yishu.yishu-lab</string>'

# The canonical Clicky source always starts Pi behind the Product Kernel.
require_literal "apps/clicky/leanring-buddy/YishuAgentRuntimeClient.swift" 'environment["YISHU_RUNTIME_MODE"] = "pi"'
require_literal "apps/clicky/leanring-buddy/YishuAgentRuntimeClient.swift" 'environment["YISHU_PRODUCT_KERNEL"] = environment["YISHU_PRODUCT_KERNEL"] ?? "1"'

# Shipping Swift must not import the laboratory executor or resurrect Kairos.
reject_source_pattern '@yishu/agent-core|AgentCoreRuntime' apps/clicky/leanring-buddy
reject_source_pattern 'KairosBridgeClient|RunProgressPresenter|forceKairosRouting' apps packages

echo "Product boundary check passed: Clicky body -> Product Kernel -> Pi runtime"
