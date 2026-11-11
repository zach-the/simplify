#!/usr/bin/env bash
# Starts the local server and opens Simplify's Apple Music variant in its own
# chromeless window. Unlike run.sh, MusicKit JS has no registered redirect URI,
# so the port here isn't load-bearing the way 8974 is for the Spotify version —
# it's just kept separate so both variants can run side by side.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${SIMPLIFY_AM_PORT:-8975}"
URL="http://127.0.0.1:${PORT}"
PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/simplify-am/profile"
LOG="$(dirname "$PROFILE")/server.log"
mkdir -p "$PROFILE"

if ! curl -s -o /dev/null "$URL"; then
  SIMPLIFY_AM_PORT="$PORT" python3 "$DIR/server-am.py" >"$LOG" 2>&1 &
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
    echo "No Chromium-based browser found. Install Google Chrome." >&2
    exit 1
    ;;
esac
