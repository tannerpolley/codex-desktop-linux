#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PREVIEW_DIR="$REPO_DIR/linux-features/local/github-issues-tab"
HOST="${CODEX_ISSUES_PREVIEW_HOST:-127.0.0.1}"
PORT="${CODEX_ISSUES_PREVIEW_PORT:-4173}"

die() {
    echo "[issues-preview] $*" >&2
    exit 1
}

case "$PORT" in
    ''|*[!0-9]*) die "CODEX_ISSUES_PREVIEW_PORT must be numeric" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    die "CODEX_ISSUES_PREVIEW_PORT must be between 1 and 65535"
fi
[ -f "$PREVIEW_DIR/preview/index.html" ] || die "preview entrypoint is missing"
command -v python3 >/dev/null 2>&1 || die "python3 is required"

case "${1:-run}" in
    run|serve)
        echo "[issues-preview] http://$HOST:$PORT/preview/"
        exec python3 -m http.server "$PORT" --bind "$HOST" --directory "$PREVIEW_DIR"
        ;;
    url)
        printf 'http://%s:%s/preview/\n' "$HOST" "$PORT"
        ;;
    -h|--help|help)
        cat <<'EOF'
Usage: scripts/dev/github-issues-preview.sh [run|url]

The preview uses local fixture data and the production Issues renderer. It does
not call GitHub or require Electron authentication.

Environment:
  CODEX_ISSUES_PREVIEW_HOST=127.0.0.1
  CODEX_ISSUES_PREVIEW_PORT=4173
EOF
        ;;
    *) die "unknown command '$1' (try --help)" ;;
esac
