#!/usr/bin/env bash
# Swap a freshly-built .app into /Applications and launch it.
#
# Shared by `make install` (the shipped app: Termic.app, com.simion.termic)
# and `make beta` (Termic Beta.app, com.simion.termic.beta — a parallel
# install that shares the production data dir, see src-tauri/tauri.beta.conf.json).
#
# Usage: scripts/install-app.sh [APP_NAME] [BUNDLE_ID]
#   APP_NAME  bundle basename without .app  (default: Termic)
#   BUNDLE_ID used to quit a running copy   (default: com.simion.termic)
set -euo pipefail

# Windows (Git Bash): an NSIS installer, not a .app. Same contract.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) exec "$(dirname "$0")/install-app-windows.sh" "${1:-Termic}" ;;
  # Linux: an AppImage in ~/Applications. Same contract.
  Linux) exec "$(dirname "$0")/install-app-linux.sh" "${1:-Termic}" ;;
esac

APP_NAME="${1:-Termic}"
BUNDLE_ID="${2:-com.simion.termic}"
SRC="src-tauri/target/release/bundle/macos/$APP_NAME.app"
DEST="/Applications/$APP_NAME.app"

if [ ! -d "$SRC" ]; then
  echo "✗ build artifact missing: $SRC"
  exit 1
fi

# The app is single-instance PER DATA DIR (lib.rs, release builds only): on
# launch it probes this socket and, if someone already answers, raises that
# instance and exits 0 before building a window. So a launch that races a
# not-yet-dead predecessor looks exactly like a crash — no window, no error.
# Wait for the socket to actually go quiet instead of guessing with `sleep 1`.
SOCK="$HOME/Library/Application Support/termic/termic.sock"
# Must never fail: `lsof` exits 1 when nobody holds the socket, and under
# `set -e -o pipefail` that would abort the script at `HOLDER="$(socket_owner)"`
# — i.e. the NO-conflict path, the common one.
socket_owner() { lsof -t "$SOCK" 2>/dev/null | head -1 || true; }

echo "→ Quitting any running $APP_NAME instance (by bundle id $BUNDLE_ID)"
osascript -e "tell application id \"$BUNDLE_ID\" to quit" 2>/dev/null || true

# Give the quit a chance, then escalate — but only ever at THIS app, which we
# are about to `rm -rf` anyway. Never at a foreign holder: that could be the
# user's other Termic with live agents in it.
for _ in $(seq 1 20); do
  pgrep -f "/$APP_NAME.app/Contents/MacOS/" >/dev/null || break
  sleep 0.25
done
if pgrep -f "/$APP_NAME.app/Contents/MacOS/" >/dev/null; then
  echo "  · quit didn't take (unresponsive or mid-dialog), killing it"
  pkill -f "/$APP_NAME.app/Contents/MacOS/" 2>/dev/null || true
  sleep 1
fi

# The predecessor can outlive its process by a beat while the socket closes.
for _ in $(seq 1 20); do
  [ -n "$(socket_owner)" ] || break
  sleep 0.25
done

echo "→ Removing $DEST (if present)"
rm -rf "$DEST"

echo "→ Copying $SRC → $DEST"
cp -R "$SRC" "$DEST"

echo "→ Refreshing icon cache"
touch "$DEST"
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "$DEST" 2>/dev/null || true
killall Finder 2>/dev/null || true

# A foreign holder (the shipped app vs the beta, or a stray direct run) is NOT
# ours to kill. Launching anyway would silently exit 0, so name the culprit and
# skip the launch instead of handing back a window that never appears.
HOLDER="$(socket_owner)"
if [ -n "$HOLDER" ]; then
  echo "✗ Not launching: pid $HOLDER already owns the shared data dir"
  ps -o pid=,comm= -p "$HOLDER" 2>/dev/null | sed 's/^/    /'
  echo "    Both the shipped app and the beta share ~/Library/Application Support/termic,"
  echo "    and the second one to start raises the first and exits. Quit that process,"
  echo "    then: open \"$DEST\""
  echo "✓ Installed $DEST (not launched)"
  exit 0
fi

# `-g` (background), NOT a plain `open`. Activating an app on macOS switches
# the user to whichever Space its window lands on, and a rebuild is the worst
# possible moment for that: you kicked off `make beta`, went to do something
# else on another desktop, and get yanked back mid-sentence minutes later.
# lib.rs already carries the same reasoning for `set_focus` (see
# `focus_window_unless_e2e`), and the CLI's own auto-launch is `open -ga`
# for exactly this reason.
#
# The app still comes up and still shows its window; it just does not steal
# the foreground, so whatever Space you are on is the Space you stay on.
# Cmd-Tab to it when you want it.
#
# LAUNCH_FOREGROUND=1 restores the old behaviour for anyone who wants the
# window in their face when the build lands.
if [ "${LAUNCH_FOREGROUND:-0}" = "1" ]; then
  echo "→ Launching $DEST (foreground, LAUNCH_FOREGROUND=1)"
  open "$DEST"
else
  echo "→ Launching $DEST (background: will not switch your Space)"
  open -g "$DEST"
fi
echo "✓ Installed $DEST"
