#!/usr/bin/env bash
# Linux half of scripts/install-app.sh: put a freshly built AppImage where it
# can be run, and launch it. `make install` and `make beta` call this.
#
# Usage: scripts/install-app-linux.sh [APP_NAME]
#   APP_NAME  productName: "Termic" (default) or "Termic Beta"
#
# An AppImage is the one Linux bundle that needs no root and carries the
# `termic` CLI and the sounds with it, which a bare `--no-bundle` binary does
# not. It lands in ~/Applications (where AppImageLauncher and Gear Lever look),
# under a name with no space in it; set TERMIC_INSTALL_DIR to put it elsewhere.
#
# This is the bundler's AppImage as it comes. A RELEASE one is repacked by
# .github/workflows/release.yml (stale libwayland removed, symlinks made
# relative, modes normalized); none of that matters on the machine that built
# it, and all of it is there for other people's.
#
# Like the macOS script, it quits a running copy of THIS app first and never
# touches the other one: the shipped app and the beta share one data dir, and
# the second to start hands off to the first and exits (single instance).
set -euo pipefail

# An AppImage's own library path must not follow us into the one we launch
# (see src-tauri/src/appimage_env.rs): `make beta` typed into a Termic
# terminal is the ordinary way to run this.
unset LD_LIBRARY_PATH

APP_NAME="${1:-Termic}"
BUNDLE_DIR="src-tauri/target/release/bundle/appimage"
# The newest `<productName>_<version>_<arch>.AppImage`.
SRC="$(ls -t "$BUNDLE_DIR/${APP_NAME}"_*.AppImage 2>/dev/null | head -1 || true)"
if [ -z "$SRC" ]; then
  echo "✗ build artifact missing: $BUNDLE_DIR/${APP_NAME}_*.AppImage"
  exit 1
fi

DEST_DIR="${TERMIC_INSTALL_DIR:-$HOME/Applications}"
DEST="$DEST_DIR/${APP_NAME// /-}.AppImage"
mkdir -p "$DEST_DIR"

# Every process of a running AppImage has `APPIMAGE=<its file>` in its
# environment, the AppImage runtime puts it there. Matching on that, not on a
# process name, is what tells the beta from the shipped app: both run a binary
# called `termic`.
running_pids() {
  local p
  for p in /proc/[0-9]*; do
    [ -r "$p/environ" ] || continue
    if tr '\0' '\n' < "$p/environ" 2>/dev/null | grep -qxF "APPIMAGE=$DEST"; then
      echo "${p#/proc/}"
    fi
  done
}

PIDS="$(running_pids | tr '\n' ' ')"
if [ -n "${PIDS// /}" ]; then
  echo "→ Quitting the running $APP_NAME"
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null || true
  for _ in $(seq 1 20); do
    [ -z "$(running_pids)" ] && break
    sleep 0.25
  done
  if [ -n "$(running_pids)" ]; then
    echo "  · quit didn't take, killing it"
    # shellcheck disable=SC2046
    kill -9 $(running_pids) 2>/dev/null || true
    sleep 1
  fi
fi

echo "→ Copying $SRC → $DEST"
# Replace, never write in place: a file being executed cannot be opened for
# writing ("Text file busy"), and a rename is atomic.
cp "$SRC" "$DEST.new"
chmod +x "$DEST.new"
mv -f "$DEST.new" "$DEST"

# A foreign holder (the shipped app vs the beta, or a stray direct run) is NOT
# ours to kill. Launching anyway would silently exit 0, so name the culprit and
# skip the launch instead of handing back a window that never appears.
SOCK="${XDG_DATA_HOME:-$HOME/.local/share}/termic/termic.sock"
HOLDER=""
if [ -S "$SOCK" ] && command -v ss >/dev/null 2>&1; then
  HOLDER="$(ss -Hxlp 2>/dev/null | grep -F "$SOCK" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
fi
if [ -n "$HOLDER" ]; then
  echo "✗ Not launching: pid $HOLDER already owns the shared data dir"
  ps -o pid=,args= -p "$HOLDER" 2>/dev/null | cut -c1-100 | sed 's/^/    /'
  echo "    Both the shipped app and the beta share ${SOCK%/termic.sock},"
  echo "    and the second one to start raises the first and exits. Quit that process,"
  echo "    then: $DEST"
  echo "✓ Installed $DEST (not launched)"
  exit 0
fi

echo "→ Launching $DEST"
# Detached from this terminal and its process group, so closing the terminal
# (or make exiting) does not take the app with it.
setsid -f "$DEST" >/dev/null 2>&1 < /dev/null
echo "✓ Installed $DEST"
