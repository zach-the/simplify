#!/usr/bin/env bash
# Starts the local server and opens Simplify in its own chromeless window.
# The window is a Chromium "app" window, which is what gives us Spotify's DRM
# (Widevine) on both macOS and Linux.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${SIMPLIFY_PORT:-8974}"
URL="http://127.0.0.1:${PORT}"
PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/simplify/profile"
LOG="$(dirname "$PROFILE")/server.log"
mkdir -p "$PROFILE"

if ! curl -s -o /dev/null "$URL"; then
  SIMPLIFY_PORT="$PORT" python3 "$DIR/server.py" >"$LOG" 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 50); do
    curl -s -o /dev/null "$URL" && break
    sleep 0.1
  done
  if ! curl -s -o /dev/null "$URL"; then
    echo "Simplify's server did not start. See $LOG" >&2
    exit 1
  fi
fi

FLAGS=(
  "--app=$URL"
  "--user-data-dir=$PROFILE"
  "--autoplay-policy=no-user-gesture-required"
  "--no-first-run"
  "--no-default-browser-check"
  "--window-size=1100,760"
)

# If a browser with this profile is already running, the launch below just hands
# the window to it and returns at once, so don't tie the server to that command:
# keep serving until no browser is left on the profile.
wait_for_browser() {
  sleep 2
  while pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null; do
    sleep 2
  done
}

case "$(uname -s)" in
  Darwin)
    open -n -a "Google Chrome" --args "${FLAGS[@]}"
    wait_for_browser
    ;;
  *)
    for bin in google-chrome google-chrome-stable chromium chromium-browser brave-browser; do
      if command -v "$bin" >/dev/null 2>&1; then
        "$bin" "${FLAGS[@]}" &
        wait_for_browser
        exit 0
      fi
    done
    echo "No Chromium-based browser found. Install Google Chrome (Chromium builds often lack Widevine)." >&2
    exit 1
    ;;
esac
