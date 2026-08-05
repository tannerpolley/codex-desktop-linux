#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_DIR/scripts/dev/codex-desktop-dev.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TMP_DIR"' EXIT

HOME="$TMP_DIR/home"
export HOME
mkdir -p "$HOME"

output="$({
    CODEX_DEV_APP_ID=codex-desktop-dev \
    CODEX_DEV_APP_NAME='ChatGPT Desktop (Dev)' \
    CODEX_DEV_INSTALL_ROOT="$TMP_DIR/opt/codex-desktop-dev" \
    CODEX_DEV_STATE_ROOT="$TMP_DIR/state/codex-desktop-dev" \
    CODEX_DEV_BIN="$TMP_DIR/bin/codex-desktop-dev" \
    CODEX_DEV_DESKTOP_FILE="$TMP_DIR/share/applications/codex-desktop-dev.desktop" \
    CODEX_DEV_FEATURES=github-issues-tab \
    CODEX_DEV_WEBVIEW_PORT=5190 \
    bash "$SCRIPT" plan
})"

grep -F 'Installation root:        '"$TMP_DIR"'/opt/codex-desktop-dev' <<<"$output" >/dev/null
grep -F 'Feature config:            '"$TMP_DIR"'/state/codex-desktop-dev/features.json' <<<"$output" >/dev/null
grep -F 'Codex home:                '"$TMP_DIR"'/state/codex-desktop-dev/codex-home' <<<"$output" >/dev/null
grep -F 'Features on first install: github-issues-tab' <<<"$output" >/dev/null

if [ -e "$TMP_DIR/state/codex-desktop-dev/features.json" ]; then
    echo "plan must not create feature config" >&2
    exit 1
fi

if CODEX_DEV_APP_ID=codex-desktop CODEX_DEV_INSTALL_ROOT="$TMP_DIR/unsafe" bash "$SCRIPT" plan >/dev/null 2>&1; then
    echo "stable app id must be rejected" >&2
    exit 1
fi

echo "dev install smoke checks passed"
