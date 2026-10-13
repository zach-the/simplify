#!/usr/bin/env bash
# Builds ~/Applications/Simplify.app from the castlabs Electron runtime in vendor/.
# Spotify only accepts Widevine from a production VMP-signed build, so this also
# signs with castlabs EVS when it is installed and you have an EVS account:
#   vendor/evs/bin/python -m pip install castlabs-evs
#   vendor/evs/bin/python -m castlabs_evs.account signup
# Linux needs neither the bundle nor VMP signing.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${SIMPLIFY_APP:-$HOME/Applications/Simplify.app}"
EVS="$DIR/vendor/evs/bin/python"

rm -rf "$APP"
ditto "$DIR/vendor/electron/Electron.app" "$APP"

# The bundle is only the runtime; it loads the app from this folder.
mkdir -p "$APP/Contents/Resources/app"
echo '{ "name": "simplify", "productName": "Simplify", "version": "0.1.0", "main": "main.js" }' \
  > "$APP/Contents/Resources/app/package.json"
echo "require($(printf '%s' "$DIR/main.js" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'));" \
  > "$APP/Contents/Resources/app/main.js"

cp "$DIR/assets/simplify.icns" "$APP/Contents/Resources/electron.icns"
/usr/libexec/PlistBuddy \
  -c "Set :CFBundleName Simplify" \
  -c "Set :CFBundleDisplayName Simplify" \
  -c "Set :CFBundleIdentifier local.simplify" \
  "$APP/Contents/Info.plist"

# VMP signing has to happen before code signing.
if "$EVS" -c "import castlabs_evs" 2>/dev/null; then
  "$EVS" -m castlabs_evs.vmp sign-pkg "$APP"
  codesign --force --deep --sign - "$APP"
  echo "Built and VMP-signed: $APP"
else
  codesign --force --sign - "$APP"
  echo "Built WITHOUT VMP signing (castlabs-evs not installed): Spotify playback will fail in $APP" >&2
fi
touch "$APP"
