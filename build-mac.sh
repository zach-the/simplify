#!/usr/bin/env bash
# Builds ~/Applications/Simplify.app: the castlabs Electron runtime, renamed,
# loading the app live from this folder.
#
# Spotify only accepts Widevine from a production VMP-signed build. The bundle
# gets that signature one of two ways:
#   - vendor/signed/Simplify.app exists: it was VMP-signed on another machine
#     (see HANDOFF.md) and is used as the starting point.
#   - otherwise, if castlabs EVS is installed here and you have an EVS account,
#     it is signed during this build:
#       vendor/evs/bin/python -m pip install castlabs-evs
#       vendor/evs/bin/python -m castlabs_evs.account signup
# Linux needs neither the bundle nor VMP signing.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${SIMPLIFY_APP:-$HOME/Applications/Simplify.app}"
EVS="$DIR/vendor/evs/bin/python"
SIGNED="$DIR/vendor/signed/Simplify.app"

# Build in a folder of its own: EVS signs every .app in the folder it is given.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
STAGED="$STAGE/Simplify.app"

if [ -d "$SIGNED" ]; then
  ditto "$SIGNED" "$STAGED"
  vmp=presigned
else
  ditto "$DIR/vendor/electron/Electron.app" "$STAGED"
  vmp=none
fi

# The bundle is only the runtime; it loads the app from this folder.
mkdir -p "$STAGED/Contents/Resources/app"
echo '{ "name": "simplify", "productName": "Simplify", "version": "0.1.0", "main": "main.js" }' \
  > "$STAGED/Contents/Resources/app/package.json"
echo "require($(printf '%s' "$DIR/main.js" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'));" \
  > "$STAGED/Contents/Resources/app/main.js"

cp "$DIR/assets/simplify.icns" "$STAGED/Contents/Resources/electron.icns"
/usr/libexec/PlistBuddy \
  -c "Set :CFBundleName Simplify" \
  -c "Set :CFBundleDisplayName Simplify" \
  -c "Set :CFBundleIdentifier local.simplify" \
  "$STAGED/Contents/Info.plist"

# VMP signing has to happen before code signing.
if [ "$vmp" = none ] && "$EVS" -c "import castlabs_evs" 2>/dev/null; then
  "$EVS" -m castlabs_evs.vmp sign-pkg "$STAGE"
  vmp=signed
fi

xattr -dr com.apple.quarantine "$STAGED" 2>/dev/null || true
if [ "$vmp" = none ]; then
  codesign --force --sign - "$STAGED"
else
  codesign --force --deep --sign - "$STAGED"
fi

rm -rf "$APP"
ditto "$STAGED" "$APP"
touch "$APP"

if [ "$vmp" = none ]; then
  echo "Built WITHOUT VMP signing: Spotify playback will fail in $APP" >&2
else
  echo "Built ($vmp VMP signature): $APP"
fi
