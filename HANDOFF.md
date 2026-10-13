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

## Next steps

1. `vendor/Simplify-vmp-signed.tar.gz` (123MB) is the archive to transfer —
   user is doing a cloud transfer. Made with `tar`, not `zip` (no `zip` binary
   in this sandbox), and verified the `.framework` symlinks (e.g.
   `Mantle.framework/Versions/Current -> A`) survived in the archive. On the
   Mac: `tar -xzf Simplify-vmp-signed.tar.gz` extracts `Simplify.app` same as
   `unzip` would.
2. **Before** using it on the Mac, fix
   `Simplify.app/Contents/Resources/app/main.js` — it currently hardcodes
   `require("/home/zach/simplify/main.js")`, an absolute path into *this*
   Linux checkout. Point it at wherever the repo actually lives on the Mac
   (this is what `build-mac.sh` normally does dynamically via `$DIR`; since
   this bundle was built by hand, it's hardcoded wrong).
3. On the Mac, **skip** the EVS sign step in `build-mac.sh` (already done,
   signature travels with the bundle) and just run:
   `codesign --force --deep --sign - "$APP"` (where `$APP` is wherever this
   `Simplify.app` ends up, e.g. after `ditto`-ing it into
   `~/Applications/Simplify.app`).
4. Then launch it and actually try playing a track — this has never been
   confirmed to fix playback, only to produce a validly-signed bundle.
5. Longer-term: consider folding this personal-machine-signing path into
   `build-mac.sh`/documentation as a standing option, since PyPI being
   blocked on the work Mac isn't going to un-block itself.

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
