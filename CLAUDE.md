# Simplify

A minimal personal Spotify player: saved albums/playlists/podcasts in a cover
grid, a cover-art "now playing" view, search, and a play bar. No feeds, no
recommendations. Built for one user (the repo owner) with their own Spotify
Premium account and their own Spotify developer app.

An Apple Music variant lives alongside it in `public-am/` — same UI shell, a
MusicKit JS backend instead of Spotify's. It's much newer and far less
exercised; see "Apple Music variant" below before trusting anything about it.

## Layout

- `public/` is the whole app: plain HTML/CSS/JS, no build step, no dependencies.
  - `app.js` holds everything: PKCE auth, Web API calls, Web Playback SDK player, views.
  - `config.js` holds the Spotify Client ID. It is a public PKCE client ID, not a
    secret, but it is the owner's personal app; don't replace or publish it casually.
- `main.js` is the Electron shell (the intended final form). It serves `public/`
  on `http://127.0.0.1:8974` and opens a frameless window. macOS-only tweaks
  (traffic-light inset, drag strip) are injected as CSS from here, not in `public/`.
- `build-mac.sh` builds `~/Applications/Simplify.app` from the Electron runtime
  in `vendor/` and VMP-signs it if the signing tool is installed. This is the
  dev-loop app: it re-requires `main.js` from this repo, so Cmd+R shows edits
  without rebuilding. It is not the distributable package (see below).
- `assets/simplify.icns` is a placeholder app icon; `assets/linux/icon-1024.png`
  is the same artwork (extracted from the icns) for electron-builder's Linux icon.
- `build/afterPack.js` is an electron-builder hook: on macOS it VMP-signs the
  packaged `.app` with castlabs EVS before electron-builder's own (ad-hoc)
  codesign step runs, same ordering `build-mac.sh` uses by hand. No-op on Linux.
- `vendor/` is gitignored: the Electron runtime zip(s) (also used by
  electron-builder, see below), the extracted runtime, and a Python venv for
  the signing tool.
- `public-am/`, `run-am.sh`, `server-am.py`, and `tools/apple-dev-token.js` are
  the separate Apple Music variant — see "Apple Music variant" below.

The port and path are fixed because the Spotify app's registered redirect URI is
exactly `http://127.0.0.1:8974/callback`. Changing the port means changing it in
the Spotify dashboard too.

## Running it

Electron is the only shell now; the Chrome fallback (`run.sh`/`server.py`) has
been removed.

- macOS: open `~/Applications/Simplify.app` (built by `./build-mac.sh`). It
  loads code from this folder, so edits show up on Cmd+R — no rebuild needed.
  Sign-in lives in `~/Library/Application Support/Simplify` and survives rebuilds.
- Linux: no live dev-loop script yet — `npm run dist:linux` bundles `public/`
  into the AppImage's asar archive, so seeing an edit means rebuilding and
  relaunching (`./dist/Simplify-<version>.AppImage`) each time. Sign-in lives in
  `~/.config/Simplify` and survives rebuilds. A `build-mac.sh`-style script that
  symlinks `node_modules/electron` to `vendor/electron` and runs `electron .`
  directly against `public/` would fix this if it becomes annoying enough to
  justify writing.

## Packaging a distributable build

`npm run dist:mac` (DMG) and `npm run dist:linux` (AppImage) use electron-builder
to produce a standalone, installable build — unlike `build-mac.sh`, the app's
code is frozen into the package (an asar archive), not loaded live from this
folder. Output lands in `dist/` (gitignored).

Both scripts set `ELECTRON_OVERRIDE_DIST_PATH` to `node_modules/electron/dist`
and the `build.electronDist`/`build.electronVersion` fields in `package.json`
point electron-builder at `vendor/` for the castlabs runtime zip, so it never
tries to download stock Electron. This means `vendor/` must hold the zip named
exactly as castlabs publishes it (see the recreate instructions below) before
either script runs; `npm install` alone can't fetch it, since it's a GitHub
release asset, not an npm-resolvable git dependency in some environments.

- Linux (AppImage): built and runtime-smoke-tested in this repo's dev sandbox —
  `npm run dist:linux` produces a working AppImage whose Electron process boots
  and serves `public/` on `127.0.0.1:8974`. Actual window rendering was not
  checked (no display in that sandbox); confirm a window actually opens and
  plays audio on real hardware.
- macOS (DMG): wired up (config + the `afterPack` VMP-sign hook) but **untested**
  — it can only be built and verified on a Mac. `identity: null` in the `mac`
  build config ad-hoc-signs the app, matching `build-mac.sh`'s `codesign --sign -`.
  If `vendor/evs` isn't set up, the hook skips VMP signing and warns, same as
  `build-mac.sh` without castlabs-evs installed.

## Current state

Everything below works in the Electron app unless marked untested. "Untested"
means written and syntax-checked but never exercised against the live account.

- Library grid with filter chips and sort (recently added / last played / artist / title); both persist.
- Hover enlarges a tile 43% (edge columns grow inward). Clicking a cover only
  shows its label; playback starts only from the green play or grey shuffle button.
- Cover view with artwork-tinted background; while a playlist plays, clicking the
  artwork flips between playlist cover and album cover (untested).
- Play bar: like, shuffle, previous, play/pause, next, repeat, add/remove from
  playlists, seek slider, track/artist/album label (hidden in cover view).
- Search with a "My library" / "All of Spotify" switch.
- Like and add-to-playlist (untested), last-track restore after reload (untested),
  system media keys via Media Session (untested).

### Open problem: Electron cannot play music yet

Stock Electron has no Widevine, so `vendor/` holds the castlabs build
(`v44.5.1+wvcus`, darwin-arm64). Widevine loads, but Spotify rejects its DRM on
macOS until the bundle is production VMP-signed: tracks skip, play a few seconds,
then stop. The fix is castlabs EVS:

    vendor/evs/bin/python -m pip install castlabs-evs
    vendor/evs/bin/python -m castlabs_evs.account signup   # the owner does this; it creates an account in their name
    ./build-mac.sh

`build-mac.sh` already does sign-then-codesign in the right order. The signing
half turns out not to need macOS at all (`castlabs_evs.vmp` is pure Python) and
has now run successfully from a Linux machine, worked around the PyPI block
below — see `HANDOFF.md` for the full story, the `sign-pkg` gotcha it took a
pass to find, and exactly what's left (Apple's own `codesign`, which does need
a Mac, then actually trying playback — still unconfirmed).

This is blocked on the owner's work Mac: a corporate security gateway
(GlobalProtect) returns 403 for PyPI and the npm registry on every network.
That block is deliberate. Do not route around it with mirrors, proxies, or by
disabling the security client. GitHub is reachable. Options the owner is
weighing: ask IT, or build on a personal computer.

To recreate `vendor/` on a machine without it (macOS, arm64 — swap the asset name
for a different arch/platform, e.g. `linux-x64`):

    mkdir -p vendor && cd vendor
    curl -fL -o "electron-v44.5.1+wvcus-darwin-arm64.zip" "https://github.com/castlabs/electron-releases/releases/download/v44.5.1%2Bwvcus/electron-v44.5.1%2Bwvcus-darwin-arm64.zip"
    # sha256 9503ac243997f151a3687d4e87d6f15d45127f50726ff2a8fd4c758b966d0dd4
    mkdir electron && ditto -x -k "electron-v44.5.1+wvcus-darwin-arm64.zip" electron
    python3 -m venv evs

Keep the zip's filename exactly as downloaded (`electron-v<version>-<platform>-<arch>.zip`,
matching castlabs' release asset name) — `npm run dist:mac`/`dist:linux` look
for it there by that name. `node_modules/electron` isn't installable via plain
`npm install` in every environment (it's a git dependency pointing at a GitHub
release, not a registry package); if that fails, build it by hand instead:
make `node_modules/electron/dist` a symlink to `vendor/electron`, write
`node_modules/electron/path.txt` containing the binary's path relative to that
folder (`electron` on Linux, `Electron.app/Contents/MacOS/Electron` on macOS),
and give `node_modules/electron` a minimal `package.json` (version
`44.5.1+wvcus`) and `index.js` that resolves to it — this is exactly what the
real `electron` npm package does, just pointed at the castlabs build already
in `vendor/`.

`run.sh`/`server.py` have already been deleted — the owner wants Electron
only, and the Linux build is now in day-to-day use. This section's fix is
still open specifically for macOS.

## Apple Music variant

`public-am/` is a second, independent copy of the UI (same `index.html`/
`style.css` shape, accent colour swapped to Apple's pink-red) backed by
MusicKit JS instead of the Spotify Web API + Web Playback SDK. Run it with
`./run-am.sh` (port 8975, its own Chrome profile under `simplify-am/`, no
`/callback` route needed — see below). It is much newer than the Spotify side
and has only been exercised against MusicKit JS itself, never against a real
Apple ID or Apple Music subscription.

### One-time setup (the owner's job, not something this session can do)

MusicKit needs a signed developer token (a JWT), and producing one needs a
private key that must never reach client-side code — the opposite of
Spotify's PKCE client ID, which is why this can't just be a `config.js` value
like the Spotify one:

1. Enroll in the Apple Developer Program (developer.apple.com, $99/yr) if not
   already enrolled.
2. Certificates, Identifiers & Profiles → Keys → create a key with MusicKit
   enabled. Download the `.p8` file — Apple only allows this once.
3. Note the Team ID (Membership page) and the key's Key ID.
4. `node tools/apple-dev-token.js --team <TEAM_ID> --key <KEY_ID> --p8 <path>`
   from the repo root. It signs the JWT locally (Node's built-in `crypto`,
   ES256, no dependency) and writes `public-am/config.js`, which is gitignored.
   Re-run it before the token expires — Apple caps that at 6 months, and there
   is no auto-refresh.

### Architecture differences from the Spotify side worth knowing

- No PKCE, no `/callback`, no refresh tokens: MusicKit JS owns both the
  developer token and the user's Music User Token once `authorize()` is
  called, and persists them itself. `server-am.py` is a plain static server
  with no special-cased routes.
- No device model: shuffle/repeat/seek are local properties on
  `music.player`, not REST calls against a "device id" the way Spotify's are.
- MusicKit JS is assumed to persist its own queue/now-playing state across
  reloads, so there's no equivalent of the Spotify version's `restoreSession`
  dance. Unverified.

### Feature gaps vs. the Spotify version (API limitations, not oversights)

- No podcasts: Apple Music's API has no public library-podcast endpoint, so
  there's no "Podcasts" filter chip here.
- "Last played" sort only reflects plays made inside this app — Apple's
  recently-played endpoints don't expose timestamps, so (unlike the Spotify
  version) there's no history to backfill from on first run.
- Add-to-playlist can only add, never remove: Apple's library-playlist API has
  no delete-track endpoint. Rows already in a playlist show the checkmark but
  are inert instead of toggling off like the Spotify version's menu.
- The cover-view playlist/album toggle is tracked locally from the last
  explicit tile `play()` call, not from a MusicKit-provided "now playing
  context" field (none was found that's reliably populated) — it won't follow
  mid-playlist autoplay/radio the way the Spotify version's server-tracked
  context does.

### What's actually been verified, and what hasn't

Checked in a real (if display-less) Chrome, with real network access to
Apple's MusicKit CDN:
- MusicKit JS v3 loads and `MusicKit.configure()` succeeds.
- A malformed/expired developer token is rejected locally with a clean,
  catchable error (surfaced on the setup screen) — confirmed with a
  deliberately expired token.
- A correctly-dated but not-Apple-signed token passes local validation and
  reaches the "Sign in with Apple Music" screen with no console errors.
- Found and fixed a real bug this way: `music.player` is `undefined` for a
  window right after `configure()`, before any sign-in — the 500ms progress
  poll crashed on it. Fixed with optional chaining everywhere `music.player`
  is read outside a context gated by the signed-in UI being visible.

Never exercised, because they need a real Apple ID with an Apple Music
subscription and a real signed token: `authorize()`'s actual sign-in flow,
playback itself, library loading, ratings ("love"), catalog search, and
add-to-playlist. The exact shapes relied on for these —
`music.api.music()`'s error format, the Ratings API path and whether
`playParams.id` is really the catalog id it's assumed to be, catalog search's
`results.{albums,songs,playlists}.data` shape, `music.storefrontId`,
`MediaItem.artworkURL()` — all come from MusicKit JS/Apple Music API
documentation, not from having run them.

The biggest open question, parallel to the Spotify side's Widevine problem:
whether MusicKit JS playback works in Chrome/Chromium at all the way it does
in Safari. Apple's own web player is understood to work in Chrome too (via
Widevine, like Spotify), which would make the existing castlabs Electron
build potentially reusable for this variant — but that's untested, and no
Electron wiring (`main-am.js`) has been written for Apple Music yet; `run-am.sh`
is Chrome-only, same starting point the Spotify side had before Electron.

## Planned

- Linux: castlabs Electron needs no VMP signing on Linux, so `main.js` already
  works with the linux build of the same release (see Packaging, above, for the
  AppImage build — functionally smoke-tested, real display/audio unverified).
- iOS: discussed, not started. Third-party apps cannot stream on iOS; it would be
  a remote control for the official Spotify app (home-screen web app first).

## Things that have already bitten

- Spotify changed its Web API in February 2026. Use `/playlists/{id}/items`
  (entries carry `item`, older ones `track`), `/me/library` and
  `/me/library/contains` with `uris` query params, and search `limit` max 10.
  Check the current reference before adding endpoints.
- Adding an OAuth scope: `boot()` compares granted scopes to `SCOPES` and sends
  the user through Spotify consent once. No manual sign-out needed.
- SVG elements have no `.hidden` property; use `toggleAttribute("hidden", …)`.
- A script-only `.app` bundle is launched under Rosetta on Apple Silicon and the
  system `python3` then fails. Force `arch -arm64` if you ever make one again.
- Two Chromes running (the owner's and Simplify's) confuse AppleScript
  `tell application "Google Chrome"`; the owner's Hammerspoon Hyper+N shortcut
  opens windows in Simplify's blank profile. Their real profile is untouched.
  Don't edit `~/.hammerspoon` without asking.
- Don't pass `--deep` to `codesign` unless the bundle was just VMP-signed; the
  framework ships with a VMP signature that a deep re-sign invalidates.

## Working with the owner

- They test by pressing Cmd+R in the running window and report back with
  screenshots; say plainly what you could not test.
- No emojis anywhere in the UI.
- Keep it minimal: no frameworks, no build step, match the existing style in `app.js`.
