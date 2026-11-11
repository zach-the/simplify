# Handoff: macOS VMP signing, done from Linux

Working around the work Mac's corporate gateway blocking PyPI (see "Open
problem" in CLAUDE.md): the castlabs EVS signup + signing doesn't need macOS at
all — `castlabs_evs.vmp.sign_pkg` is pure Python (uses `macholib` to parse the
Mach-O binary and `requests`/`boto3` to talk to castlabs' own API, not PyPI).
So the signing is being done on this Linux machine, personal/unblocked, and
only the final Apple `codesign` step (which genuinely requires macOS) is left
for the work Mac.

## Done so far (this Linux machine)

- `vendor/evs` — venv with `castlabs-evs` installed. Works here; this is the
  exact step that 403s on the work Mac's PyPI.
- castlabs EVS account created and confirmed (account name `zach-the`, see
  `~/.config/evs/config.json` on this machine — **do not commit or copy that
  file's contents anywhere public, it holds auth tokens**).
- `vendor/electron-v44.5.1+wvcus-darwin-arm64.zip` downloaded, sha256 verified
  against the one already in CLAUDE.md.
- `vendor/mac-app/Simplify.app` — extracted from that zip and staged exactly
  like `build-mac.sh` does, but with plain file ops instead of macOS-only
  tools (`ditto`/`PlistBuddy`):
  - `Contents/Resources/app/{package.json,main.js}` — the wrapper that
    `require()`s this repo's `main.js` live (same trick `build-mac.sh` uses).
  - `Contents/Resources/electron.icns` — copied from `assets/simplify.icns`.
  - `Contents/Info.plist` — `CFBundleName`/`CFBundleDisplayName` set to
    "Simplify", `CFBundleIdentifier` set to `local.simplify`, edited with
    Python's `plistlib` (pure Python stdlib, no `PlistBuddy` needed).

## Gotcha found while doing this

`castlabs_evs.vmp sign-pkg <path>` wants the **parent directory** of the
`.app`, not the `.app` path itself — it globs `<path>/*.app` internally
(`_detect_pkgs` in `vmp.py`). So the command is:

    vendor/evs/bin/python -m castlabs_evs.vmp sign-pkg vendor/mac-app

not `... sign-pkg vendor/mac-app/Simplify.app`. (First attempt with the direct
`.app` path failed with `FileNotFoundError: No matching executable found`.)
Worth fixing upstream in a future pass: `build-mac.sh` passes `"$APP"` (the
`.app` path) directly to `sign-pkg` too — if that's actually wrong there too,
it may explain part of why VMP signing was never confirmed working even before
the PyPI block. Check this once this Linux-side signing is confirmed to work.

## Status: VMP signing succeeded on this Linux machine

```
$ vendor/evs/bin/python -m castlabs_evs.vmp sign-pkg vendor/mac-app
...
 - Signature request successful: streaming, 1374 days left
$ vendor/evs/bin/python -m castlabs_evs.vmp verify-pkg vendor/mac-app
 - Signature is valid: streaming, 1374 days left
```

`vendor/mac-app/Simplify.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Electron Framework.sig`
exists and verifies. This is the exact piece that's been blocked on the work
Mac's PyPI gateway — it's done, from a personal/unblocked machine, same as
CLAUDE.md's "build on a personal computer" option, just split so only the
truly macOS-only step (Apple codesign) is left for the Mac.

## Update (2026-11-11, different session): the sign-pkg gotcha was also in afterPack.js

The "parent directory, not the `.app` path" gotcha noted above turned out to
also be the bug in `build/afterPack.js` (the electron-builder hook) — it was
passing the `.app` path straight to `sign-pkg`, which fails with exactly the
confusing `FileNotFoundError: No matching executable found` this doc already
diagnosed. **Fixed**: it now passes `context.appOutDir` instead. Confirmed
end-to-end today: `ELECTRON_OVERRIDE_DIST_PATH="$PWD/node_modules/electron/dist"
npx electron-builder --mac zip --arm64` now runs the full pipeline — package,
VMP-sign (reusing the same cached signature from the `vendor/mac-app` work
below, since it's the same underlying Electron Framework binary), skip native
codesign (Linux can't do that part), zip — producing
**`dist/Simplify-0.1.0-arm64-mac.zip`**.

This new zip is a better transfer artifact than `vendor/Simplify-vmp-signed.tar.gz`
below: it's electron-builder's normal frozen-`app.asar` package, so it has
**no hardcoded path to fix** (unlike the hand-built `vendor/mac-app` bundle,
whose `Resources/app/main.js` stub `require()`s this Linux checkout's absolute
path). `npm run dist:mac` itself (the `dmg` target) still can't run on this
Linux box — `dmg-builder` hard-requires the macOS-only optional dependency
`dmg-license` — so `--mac zip --arm64` is the way to produce something here
until this is run on an actual Mac.

## Next steps

1. Transfer **`dist/Simplify-0.1.0-arm64-mac.zip`** (124MB) to the Mac —
   ordinary zip, no symlink/tar caveats, no path to fix first. (The older
   `vendor/Simplify-vmp-signed.tar.gz` route below still works too, but needs
   step 2 below first; this new zip doesn't.)
2. ~~Fix the hardcoded path~~ — not needed for the new zip. Still applies if
   using the older `vendor/mac-app` tarball: fix
   `Simplify.app/Contents/Resources/app/main.js`'s hardcoded
   `require("/home/zach/simplify/main.js")` to point at wherever the repo
   lives on the Mac.
3. On the Mac, unzip and run: `codesign --force --deep --sign - "$APP"`
   (`$APP` = wherever `Simplify.app` ends up, e.g. after moving it into
   `~/Applications/Simplify.app`). The VMP signature already travels with the
   bundle either way — this is only the Apple ad-hoc signing step, which
   genuinely needs macOS.
4. Then launch it and actually try playing a track — **still unconfirmed**
   whether this fixes playback, only that the bundle is now validly
   VMP-signed AND (for the new zip) produced by the real packaging pipeline.
5. Longer-term, same as before: consider folding this personal-machine-signing
   path into `build-mac.sh`/`npm run dist:mac` docs as a standing option.

## Other repo context (already committed)

- Cross-platform packaging via electron-builder (`npm run dist:mac` /
  `dist:linux`) was added — see CLAUDE.md's "Packaging a distributable build"
  section. The Linux AppImage path was built and smoke-tested end to end on
  this machine (booted, served `public/` on 127.0.0.1:8974; no display
  available to confirm an actual window renders). The mac DMG path is wired up
  but **unbuilt and untested** — this signing work is a prerequisite for a
  DMG that would actually play music, not a substitute for running
  `npm run dist:mac` on a Mac.
- `node_modules/electron` in this checkout was hand-built (cli.js/path.txt/
  package.json `bin` field) because this sandbox's npm can't fetch git-type
  dependencies at all — a real `npm install` on an unrestricted machine
  wouldn't need this.

## Update (2026-11-11, Mac session): installed the zip, patched it in place

The Mac side installed `dist/Simplify-0.1.0-arm64-mac.zip` to
`~/Applications/Simplify.app` and ran `codesign --force --deep --sign -` on it.
Codesign verifies. Playback still needs to be tested by the owner. The old
live-loading dev app was kept as `~/Applications/Simplify (dev).app`.
Both have bundle ID `local.simplify`.

electron-builder can't run on the work Mac (no `node_modules`, npm registry
blocked), so these fixes were patched straight into the installed bundle and
**need to be committed and packaged on the Linux side**:

1. `main.js`: hide the macOS traffic lights (`setWindowButtonVisibility(false)`,
   `titleBarStyle: "hidden"`, no 92px left inset on the filters/search bar).
   This was already uncommitted in the Mac working tree. The zip was built
   from the committed version, which still showed the traffic lights.
2. `public/style.css` + `public/app.js`: with the tracks sidebar open, the play
   bar (`#controls`) now centers in the space left of the sidebar instead of
   the full window. `onState` toggles `body.paused`, which freezes the
   now-playing equalizer bars (`animation-play-state: paused`) while paused.

How the in-place patch was done (in case it ever needs doing again without a
rebuild): the bundle's fuses have `OnlyLoadAppFromAsar` and
`EmbeddedAsarIntegrityValidation` both off, so `Contents/Resources/app.asar`
was extracted to `Contents/Resources/app/`, the changed files were copied in,
`app.asar` was removed, the `ElectronAsarIntegrity` key was deleted from
`Info.plist`, and the bundle was re-signed ad hoc. The VMP `.sig` covers only
the Electron Framework binary, so it was not affected. A fresh
`electron-builder --mac zip --arm64` from the committed tree replaces all of
this. Just transfer it and codesign as in step 3 above.
