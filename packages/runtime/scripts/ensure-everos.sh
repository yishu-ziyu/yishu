#!/usr/bin/env bash
# Install the vendored EverOS CLI into a user-level venv and init the memory root.
# Does not write API keys into everos.toml.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
VENDOR_EVEROS="${YISHU_EVEROS_SRC:-$REPO_ROOT/vendor/everos}"
VENV="${YISHU_EVEROS_VENV:-$HOME/.yishu/everos-venv}"
ROOT="${YISHU_EVEROS_ROOT:-${EVEROS_ROOT:-$HOME/Library/Application Support/Yishu/EverOS}}"
PINNED_VERSION="1.2.3"

HOME_PARENT="${HOME%/*}"
if [[ "$ROOT" == "/" || "$ROOT" == "." || "$ROOT" == ".." || "$ROOT" == "$HOME" || "$ROOT" == "$HOME_PARENT" ]]; then
  echo "Refusing unsafe EverOS root: $ROOT" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required to install EverOS" >&2
  exit 1
fi

mkdir -p "$VENV" "$ROOT"
chmod 700 "$ROOT"

if [[ ! -x "$VENV/bin/python" ]]; then
  if command -v python3.12 >/dev/null 2>&1; then
    uv venv --python 3.12 "$VENV"
  else
    uv venv "$VENV"
  fi
fi

if [[ -f "$VENDOR_EVEROS/pyproject.toml" ]]; then
  uv pip install --python "$VENV/bin/python" -e "$VENDOR_EVEROS"
else
  uv pip install --python "$VENV/bin/python" "everos==$PINNED_VERSION"
fi

if [[ ! -x "$VENV/bin/everos" ]]; then
  echo "EverOS CLI missing after install: $VENV/bin/everos" >&2
  exit 1
fi

if [[ ! -f "$ROOT/everos.toml" ]]; then
  "$VENV/bin/everos" init --root "$ROOT"
fi

echo "EverOS ready: $VENV/bin/everos"
echo "Memory root: $ROOT"
