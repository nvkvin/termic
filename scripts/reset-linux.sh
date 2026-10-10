#!/usr/bin/env bash
# Linux half of `make reset` and `make reset_dev`: delete Termic's state.
#
# Usage: scripts/reset-linux.sh dev   the dev profile only, no prompt
#        scripts/reset-linux.sh all   everything, after typing "yes"
#
# The macOS recipes in the Makefile list ~/Library paths, none of which exist
# here, so on Linux both targets used to report success and delete nothing.
# The layout on Linux (XDG):
#
#   $XDG_DATA_HOME/termic              projects, tasks, settings   (release)
#   $XDG_DATA_HOME/termic_dev          the same, for a debug build
#   ~/termic_dev                       the dev build's worktrees
#   $XDG_DATA_HOME/com.simion.termic   the webview: localStorage, caches
#   $XDG_CONFIG_HOME/com.simion.termic window positions
#
# One trap the macOS side does not have: the webview directory is SHARED by
# the release app, the dev build and the beta, and what separates them is the
# localStorage FILE, one per origin (`tauri_localhost_0` for a built app,
# `http_localhost_1420` for the dev server). So `dev` removes that one file,
# never the directory, or it would take the installed app's UI prefs with it.
#
# Never touched: worktrees under ~/termic, your themes in ~/.config/termic,
# the desktop entry, and the AppImage files themselves.
#
# TERMIC_RESET_NO_QUIT=1 skips quitting running instances. It exists so this
# script can be exercised against a throwaway HOME without killing the app
# you are working in.
set -euo pipefail

MODE="${1:-}"
case "$MODE" in dev|all) ;; *) echo "usage: $0 dev|all" >&2; exit 2 ;; esac

DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}"
TMP="${TMPDIR:-/tmp}"

# Running instances, found by what they are EXECUTING, not by matching a
# command line: `pkill -f target/debug/termic` on Linux also matches the
# shell running this very script, whose command line contains that text.
pids_running() { # <shell glob for the exe path>
  local p exe
  for p in /proc/[0-9]*; do
    exe="$(readlink "$p/exe" 2>/dev/null || true)"
    # shellcheck disable=SC2254
    case "$exe" in $1) echo "${p#/proc/}" ;; esac
  done
}

quit() { # <label> <exe glob>
  [ "${TERMIC_RESET_NO_QUIT:-0}" = "1" ] && return 0
  local pids
  pids="$(pids_running "$2" | tr '\n' ' ')"
  [ -n "${pids// /}" ] || return 0
  echo "→ Quitting $1"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  pids="$(pids_running "$2" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  [ -z "${pids// /}" ] || kill -9 $pids 2>/dev/null || true
}

remove() { # paths...
  local t
  for t in "$@"; do
    if [ -e "$t" ] || [ -L "$t" ]; then echo "→ Removing $t"; rm -rf -- "$t"; else echo "  (absent) $t"; fi
  done
}

WEBVIEW="$DATA/com.simion.termic"

if [ "$MODE" = "dev" ]; then
  quit "the dev instance" "*/target/debug/termic"
  remove "$DATA/termic_dev" "$HOME/termic_dev" \
         "$WEBVIEW/localstorage/http_localhost_1420.localstorage" \
         "$WEBVIEW/localstorage/http_localhost_1420.localstorage-shm" \
         "$WEBVIEW/localstorage/http_localhost_1420.localstorage-wal" \
         "$CONFIG/com.simion.termic/.window-state-dev.json"
  echo "✓ Dev profile reset. Production 'termic' data untouched."
  exit 0
fi

TARGETS=(
  "$DATA/termic" "$DATA/termic_dev"
  "$WEBVIEW" "$DATA/com.simion.termic.beta"
  "$CONFIG/com.simion.termic" "$CONFIG/com.simion.termic.beta"
  "$CACHE/com.simion.termic" "$CACHE/com.simion.termic.beta"
  "$TMP/termic-debug.log" "$TMP/termic-workstate.log" "$TMP/termic-workstate-dev.log"
  "$TMP/termic-attachments"
)
echo "This will delete:"
printf '  %s\n' "${TARGETS[@]}"
echo "  $TMP/termic-proxy-*.filter"
echo ""
echo "Worktrees at ~/termic and ~/termic_dev are NOT touched (real git checkouts),"
echo "nor are your themes in $CONFIG/termic."
echo ""
read -r -p "Type 'yes' to confirm: " confirm
if [ "$confirm" != "yes" ]; then echo "✗ Aborted."; exit 1; fi
quit "the dev instance" "*/target/debug/termic"
quit "the installed app" "*/.mount_*/usr/bin/termic"
remove "${TARGETS[@]}"
rm -f "$TMP"/termic-proxy-*.filter 2>/dev/null || true
echo "✓ Wiped. Worktrees on disk are untouched."
