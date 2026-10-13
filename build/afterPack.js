// electron-builder afterPack hook. Runs after the app's files are assembled
// but before macOS code signing — the same ordering build-mac.sh used by hand,
// because VMP signing has to happen before codesign (see CLAUDE.md).
// No-op on Linux: castlabs' build needs no VMP signing there.
const { execFileSync } = require("child_process");
const path = require("path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const evs = path.join(__dirname, "..", "vendor", "evs", "bin", "python");
  try {
    execFileSync(evs, ["-c", "import castlabs_evs"], { stdio: "ignore" });
  } catch {
    console.warn(
      "castlabs-evs not installed in vendor/evs; packaging WITHOUT VMP signing " +
        "(Spotify playback will fail in this build). See CLAUDE.md."
    );
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync(evs, ["-m", "castlabs_evs.vmp", "sign-pkg", appPath], { stdio: "inherit" });
  console.log("VMP-signed:", appPath);
};
