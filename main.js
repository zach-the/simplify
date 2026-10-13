// Electron shell for Simplify. Uses the castlabs Electron build, which bundles
// Widevine (stock Electron can't play Spotify). The app itself is the plain web
// page in public/, served on loopback so the Spotify redirect URI is the same
// in every shell (see run.sh for the Chrome one).
const { app, BrowserWindow, components, shell } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.SIMPLIFY_PORT || 8974);
const URL_ROOT = `http://127.0.0.1:${PORT}`;
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

// Room for the macOS traffic lights, plus a draggable strip along the top.
const MAC_CSS = `
  body::before { content: ""; position: fixed; top: 0; left: 0; right: 0; height: 52px; z-index: 4; -webkit-app-region: drag; }
  #nav, .filters, #search-bar, #toast { -webkit-app-region: no-drag; }
  .filters, #search-bar { left: 92px; }
  #search-input { width: min(420px, calc(100vw - 490px)); }
`;

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(new URL(req.url, URL_ROOT).pathname);
      if (rel === "/" || rel === "/callback") rel = "/index.html";
      const file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep)) return res.writeHead(403).end();
      fs.readFile(file, (err, data) => {
        if (err) return res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
        res.end(data);
      });
    });
    // If the port is taken, assume run.sh's server is already up and use that.
    server.once("error", resolve);
    server.listen(PORT, "127.0.0.1", resolve);
  });
}

function createWindow() {
  const mac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 520,
    minHeight: 420,
    title: "Simplify",
    backgroundColor: "#121212",
    autoHideMenuBar: true,
    titleBarStyle: mac ? "hiddenInset" : "default",
  });
  // Keep the window title fixed instead of following the page title.
  win.on("page-title-updated", (e) => e.preventDefault());
  if (mac) win.webContents.on("dom-ready", () => win.webContents.insertCSS(MAC_CSS));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadURL(URL_ROOT);
}

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Spotify's sign-in and player expect a regular Chrome user agent.
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|simplify|Simplify)\/\S+/g, "");

app.whenReady().then(async () => {
  await components.whenReady();
  if (process.env.SIMPLIFY_DEBUG) console.log("components:", JSON.stringify(components.status()));
  await serve();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
