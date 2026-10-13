# Simplify

A minimal personal Spotify player: saved albums/playlists/podcasts in a cover
grid, a cover-art "now playing" view, search, and a play bar. No feeds, no
recommendations. Built for one user (the repo owner) with their own Spotify
Premium account and their own Spotify developer app.

## Layout

- `public/` is the whole app: plain HTML/CSS/JS, no build step, no dependencies.
  - `app.js` holds everything: PKCE auth, Web API calls, Web Playback SDK player, views.
  - `config.js` holds the Spotify Client ID. It is a public PKCE client ID, not a
    secret, but it is the owner's personal app; don't replace or publish it casually.
- `main.js` is the Electron shell (the intended final form). It serves `public/`
  on `http://127.0.0.1:8974` and opens a frameless window. macOS-only tweaks
  (traffic-light inset, drag strip) are injected as CSS from here, not in `public/`.
- `run.sh` + `server.py` are the fallback shell: a Python static server plus a
  Google Chrome `--app` window on its own profile. Works on macOS and Linux.
- `build-mac.sh` builds `~/Applications/Simplify.app` from the Electron runtime
  in `vendor/` and VMP-signs it if the signing tool is installed.
- `assets/simplify.icns` is a placeholder app icon.
- `vendor/` is gitignored: the Electron runtime, its zip, and a Python venv for the signing tool.

The port and path are fixed because the Spotify app's registered redirect URI is
exactly `http://127.0.0.1:8974/callback`. Changing the port means changing it in
the Spotify dashboard too.

## Running it

- Chrome shell (plays music today): `./run.sh`. It keeps running until every
  Chrome process on its profile has quit. Edit files in `public/`, then Cmd+R.
- Electron shell: open `~/Applications/Simplify.app` (built by `./build-mac.sh`).
  It loads code from this folder, so edits also show up on Cmd+R.

Each shell has its own browser profile, so each needs its own Spotify sign-in.
The Electron sign-in lives in `~/Library/Application Support/Simplify` and
survives rebuilds.

## Current state

Everything below works in the Chrome shell unless marked untested. "Untested"
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

`build-mac.sh` already does sign-then-codesign in the right order; the signing
half has never run. It is expected to fix playback but that is unconfirmed.

This is blocked on the owner's work Mac: a corporate security gateway
(GlobalProtect) returns 403 for PyPI and the npm registry on every network.
That block is deliberate. Do not route around it with mirrors, proxies, or by
disabling the security client. GitHub is reachable. Options the owner is
weighing: ask IT, or build on a personal computer.

To recreate `vendor/` on a machine without it:

    mkdir -p vendor && cd vendor
    curl -fL -o electron.zip "https://github.com/castlabs/electron-releases/releases/download/v44.5.1%2Bwvcus/electron-v44.5.1%2Bwvcus-darwin-arm64.zip"
    # sha256 9503ac243997f151a3687d4e87d6f15d45127f50726ff2a8fd4c758b966d0dd4
    mkdir electron && ditto -x -k electron.zip electron
    python3 -m venv evs

Once Electron plays, delete `run.sh` and `server.py`; the owner wants Electron only.

## Planned

- Linux: castlabs Electron needs no VMP signing on Linux, so `main.js` should
  work with the linux build of the same release. `package.json` pins it for `npm install`.
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
- Launching Chrome with a profile that is already running hands the window to
  the existing process and returns immediately; `run.sh` waits on the profile, not the command.
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
