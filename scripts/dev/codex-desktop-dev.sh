#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEV_APP_ID="${CODEX_DEV_APP_ID:-codex-desktop-dev}"
DEV_APP_NAME="${CODEX_DEV_APP_NAME:-ChatGPT Desktop (Dev)}"
DEV_INSTALL_ROOT="${CODEX_DEV_INSTALL_ROOT:-$HOME/.local/opt/$DEV_APP_ID}"
DEV_APP_DIR="${CODEX_DEV_APP_DIR:-$DEV_INSTALL_ROOT/app}"
DEV_BIN="${CODEX_DEV_BIN:-$HOME/.local/bin/$DEV_APP_ID}"
DEV_STATE_ROOT="${CODEX_DEV_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/$DEV_APP_ID}"
DEV_DESKTOP_FILE="${CODEX_DEV_DESKTOP_FILE:-${XDG_DATA_HOME:-$HOME/.local/share}/applications/$DEV_APP_ID.desktop}"
DEV_FEATURES_FILE="${CODEX_DEV_FEATURES_FILE:-$DEV_STATE_ROOT/features.json}"
DEV_REPORT_DIR="${CODEX_DEV_REPORT_DIR:-$DEV_STATE_ROOT/rebuild}"
DEV_CODEX_HOME="${CODEX_DEV_CODEX_HOME:-$DEV_STATE_ROOT/codex-home}"
DEV_WEBVIEW_PORT="${CODEX_DEV_WEBVIEW_PORT:-5190}"
DEV_FEATURES="${CODEX_DEV_FEATURES:-github-issues-tab}"

die() {
    echo "[dev] $*" >&2
    exit 1
}

validate_app_identity() {
    [[ "$DEV_APP_ID" =~ ^[A-Za-z0-9._-]+$ ]] || die "CODEX_DEV_APP_ID must contain only letters, numbers, '.', '_' or '-'"
    [ "$DEV_APP_ID" != "codex-desktop" ] || die "CODEX_DEV_APP_ID must differ from the stable codex-desktop app"
    case "$DEV_APP_NAME" in
        *$'\n'*|*$'\r'*) die "CODEX_DEV_APP_NAME must not contain newlines" ;;
    esac
    [ -n "$DEV_INSTALL_ROOT" ] || die "development install root must not be empty"
    [ -n "$DEV_APP_DIR" ] || die "development app directory must not be empty"
    [ -n "$DEV_STATE_ROOT" ] || die "development state root must not be empty"
    [ -n "$DEV_CODEX_HOME" ] || die "development Codex home must not be empty"
    [ -x "$REPO_DIR/install.sh" ] || die "installer not found: $REPO_DIR/install.sh"
}

feature_ids() {
    local feature
    local -a requested=()

    IFS=, read -r -a requested <<< "$DEV_FEATURES"
    for feature in "${requested[@]}"; do
        feature="${feature//[[:space:]]/}"
        [ -n "$feature" ] || continue
        [[ "$feature" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "invalid development feature id: $feature"
        printf '%s\n' "$feature"
    done
}

write_feature_config() {
    local temporary_path
    local feature
    local feature_list
    local first=1

    [ -f "$DEV_FEATURES_FILE" ] && [ "${CODEX_DEV_RESET_FEATURES:-0}" != "1" ] && return 0
    feature_list="$(feature_ids)"
    mkdir -p "$(dirname "$DEV_FEATURES_FILE")"
    temporary_path="${DEV_FEATURES_FILE}.tmp.$$"
    {
        printf '{\n  "enabled": ['
        while IFS= read -r feature; do
            [ -n "$feature" ] || continue
            if [ "$first" -eq 0 ]; then
                printf ', '
            fi
            printf '"%s"' "$feature"
            first=0
        done <<< "$feature_list"
        printf ']\n}\n'
    } > "$temporary_path"
    mv -f -- "$temporary_path" "$DEV_FEATURES_FILE"
}

desktop_quote() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '"%s"' "$value"
}

write_launcher() {
    local temporary_path
    local app_dir_q
    local state_root_q
    local codex_home_q

    mkdir -p "$(dirname "$DEV_BIN")"
    temporary_path="${DEV_BIN}.tmp.$$"
    printf -v app_dir_q '%q' "$DEV_APP_DIR"
    printf -v state_root_q '%q' "$DEV_STATE_ROOT"
    printf -v codex_home_q '%q' "$DEV_CODEX_HOME"
    {
        printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
        printf 'DEV_APP_DIR=%s\n' "$app_dir_q"
        printf 'DEV_STATE_ROOT=%s\n' "$state_root_q"
        printf 'DEV_CODEX_HOME=%s\n' "$codex_home_q"
        # The following lines are emitted literally into the generated launcher.
        # shellcheck disable=SC2016
        printf '%s\n' \
            'if [ -z "${XDG_CONFIG_HOME:-}" ]; then XDG_CONFIG_HOME="$DEV_STATE_ROOT/config"; fi' \
            'if [ -z "${XDG_DATA_HOME:-}" ]; then XDG_DATA_HOME="$DEV_STATE_ROOT/data"; fi' \
            'if [ -z "${XDG_CACHE_HOME:-}" ]; then XDG_CACHE_HOME="$DEV_STATE_ROOT/cache"; fi' \
            'export XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME' \
            'if [ -z "${GH_CONFIG_DIR:-}" ] && [ -d "${HOME:-}/.config/gh" ]; then' \
            '    GH_CONFIG_DIR="$HOME/.config/gh"' \
            '    export GH_CONFIG_DIR' \
            'fi' \
            'if [ "${CODEX_DEV_SHARE_CODEX_HOME:-0}" != "1" ]; then' \
            '    mkdir -p "$DEV_CODEX_HOME"' \
            '    CODEX_HOME="$DEV_CODEX_HOME"' \
            '    export CODEX_HOME' \
            'fi' \
            'exec "$DEV_APP_DIR/start.sh" "$@"'
    } > "$temporary_path"
    chmod 0755 "$temporary_path"
    mv -f -- "$temporary_path" "$DEV_BIN"
}

write_desktop_entry() {
    local temporary_path
    local launcher_arg
    local icon_path

    mkdir -p "$(dirname "$DEV_DESKTOP_FILE")"
    temporary_path="${DEV_DESKTOP_FILE}.tmp.$$"
    launcher_arg="$(desktop_quote "$DEV_BIN")"
    icon_path="$DEV_APP_DIR/.codex-linux/$DEV_APP_ID.png"
    {
        printf '%s\n' '[Desktop Entry]' 'Type=Application'
        printf 'Name=%s\n' "$DEV_APP_NAME"
        printf '%s\n' 'Comment=Development build of ChatGPT Desktop for Linux'
        printf 'Exec=%s %%U\n' "$launcher_arg"
        printf 'TryExec=%s\n' "$DEV_BIN"
        printf 'Icon=%s\n' "$icon_path"
        printf '%s\n' 'Terminal=false' 'Categories=Development;IDE;' 'StartupNotify=true'
        printf 'StartupWMClass=%s\n' "$DEV_APP_ID"
        printf 'X-GNOME-WMClass=%s\n' "$DEV_APP_ID"
        printf '%s\n' 'Actions=new-window;'
        printf '\n%s\n' '[Desktop Action new-window]'
        printf '%s\n' 'Name=New Window'
        printf 'Exec=env CODEX_MULTI_LAUNCH=1 %s --new-instance\n' "$launcher_arg"
    } > "$temporary_path"
    chmod 0644 "$temporary_path"
    mv -f -- "$temporary_path" "$DEV_DESKTOP_FILE"
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$(dirname "$DEV_DESKTOP_FILE")" >/dev/null 2>&1 || true
    fi
}

print_config() {
    printf 'Development app id:       %s\n' "$DEV_APP_ID"
    printf 'Development app name:     %s\n' "$DEV_APP_NAME"
    printf 'Installation root:        %s\n' "$DEV_INSTALL_ROOT"
    printf 'App directory:             %s\n' "$DEV_APP_DIR"
    printf 'Launcher:                  %s\n' "$DEV_BIN"
    printf 'State/config root:         %s\n' "$DEV_STATE_ROOT"
    printf 'Codex home:                %s\n' "$DEV_CODEX_HOME"
    printf 'Feature config:            %s\n' "$DEV_FEATURES_FILE"
    printf 'Desktop entry:             %s\n' "$DEV_DESKTOP_FILE"
    printf 'Webview port:              %s\n' "$DEV_WEBVIEW_PORT"
    printf 'Features on first install: %s\n' "${DEV_FEATURES:-none}"
}

plan_install() {
    validate_app_identity
    print_config
    printf '\nBuild command:\n'
    printf '  CODEX_APP_ID=%q CODEX_APP_DISPLAY_NAME=%q CODEX_INSTALL_DIR=%q CODEX_WEBVIEW_PORT=%q CODEX_LINUX_FEATURES_CONFIG=%q REBUILD_REPORT_DIR=%q %q' \
        "$DEV_APP_ID" "$DEV_APP_NAME" "$DEV_APP_DIR" "$DEV_WEBVIEW_PORT" "$DEV_FEATURES_FILE" "$DEV_REPORT_DIR" "$REPO_DIR/install.sh"
    printf ' [DMG/options]\n'
}

install_dev() {
    validate_app_identity
    write_feature_config
    mkdir -p "$DEV_STATE_ROOT" "$DEV_REPORT_DIR"
    (
        cd "$REPO_DIR"
        CODEX_APP_ID="$DEV_APP_ID" \
        CODEX_APP_DISPLAY_NAME="$DEV_APP_NAME" \
        CODEX_INSTALL_DIR="$DEV_APP_DIR" \
        CODEX_WEBVIEW_PORT="$DEV_WEBVIEW_PORT" \
        CODEX_LINUX_FEATURES_CONFIG="$DEV_FEATURES_FILE" \
        REBUILD_REPORT_DIR="$DEV_REPORT_DIR" \
        ./install.sh "$@"
    )
    write_launcher
    write_desktop_entry
    echo "[dev] installed $DEV_APP_NAME"
    echo "[dev] run: $DEV_BIN"
    echo "[dev] stable app remains under its normal codex-desktop identity"
}

run_dev() {
    validate_app_identity
    [ -x "$DEV_BIN" ] || die "development app is not installed; run: make dev-install"
    exec "$DEV_BIN" "$@"
}

status_dev() {
    validate_app_identity
    print_config
    if [ -x "$DEV_BIN" ] && [ -x "$DEV_APP_DIR/start.sh" ]; then
        echo 'Installed:                  yes'
    else
        echo 'Installed:                  no'
    fi
    if [ -f "$DEV_FEATURES_FILE" ]; then
        echo 'Feature config present:     yes'
    else
        echo 'Feature config present:     no'
    fi
}

uninstall_dev() {
    validate_app_identity
    case "$DEV_INSTALL_ROOT" in
        ''|/|"$HOME"|"$REPO_DIR") die "refusing to remove unsafe development install root: $DEV_INSTALL_ROOT" ;;
    esac
    rm -rf -- "$DEV_INSTALL_ROOT"
    rm -f -- "$DEV_BIN" "$DEV_DESKTOP_FILE"
    echo "[dev] removed installation root, launcher, and desktop entry"
    echo "[dev] preserved state/config root: $DEV_STATE_ROOT"
}

usage() {
    cat <<'EOF'
Usage: scripts/dev/codex-desktop-dev.sh <command> [install.sh options]

Commands:
  plan       Show the isolated paths and build command without changing files
  install    Build/install the development app and desktop entry
  run        Launch the installed development app
  status     Show development paths and installation state
  uninstall  Remove the development app, launcher, and desktop entry

Environment overrides:
  CODEX_DEV_FEATURES=github-issues-tab,example-feature
  CODEX_DEV_RESET_FEATURES=1
  CODEX_DEV_CODEX_HOME=...
  CODEX_DEV_SHARE_CODEX_HOME=1
  CODEX_DEV_INSTALL_ROOT=...
  CODEX_DEV_APP_DIR=...
  CODEX_DEV_BIN=...
  CODEX_DEV_STATE_ROOT=...
  CODEX_DEV_WEBVIEW_PORT=5190
EOF
}

command_name="${1:-}"
if [ "$#" -gt 0 ]; then
    shift
fi

case "$command_name" in
    plan) plan_install "$@" ;;
    install) install_dev "$@" ;;
    run) run_dev "$@" ;;
    status) status_dev "$@" ;;
    uninstall) uninstall_dev "$@" ;;
    -h|--help|help|'') usage ;;
    *) die "unknown command '$command_name' (try --help)" ;;
esac
