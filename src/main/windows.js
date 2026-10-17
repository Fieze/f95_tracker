const path = require("path");
const { BrowserWindow, shell } = require("electron");
const { isSafeBrowserUrl } = require("./services/browserSafety");
const { ctx, AUTH_PARTITION, appIconPath } = require("./context");
const { hideMainWindowToTray } = require("./tray");

function isF95Url(candidateUrl) {
  try {
    const url = new URL(String(candidateUrl || ""));
    return url.protocol === "https:" && (url.hostname === "f95zone.to" || url.hostname.endsWith(".f95zone.to"));
  } catch {
    return false;
  }
}

// Deny every permission request (camera, geolocation, notifications, ...) from remote pages.
function hardenSession(targetSession) {
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  targetSession.setPermissionCheckHandler(() => false);
}

async function createWindow() {
  await ctx.logger?.info("Creating main window.");
  ctx.mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    icon: appIconPath,
    backgroundColor: "#16211e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: AUTH_PARTITION
    }
  });

  await ctx.mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  ctx.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeBrowserUrl(url)) void shell.openExternal(url).catch((error) => ctx.logger?.warn("External link failed.", error));
    return { action: "deny" };
  });

  ctx.mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  ctx.mainWindow.webContents.on("will-redirect", (event) => event.preventDefault());

  ctx.mainWindow.on("close", (event) => {
    if (ctx.isQuitting) {
      return;
    }

    event.preventDefault();
    void hideMainWindowToTray();
  });

  ctx.mainWindow.on("closed", () => {
    ctx.mainWindow = null;
  });
}

async function createLoginWindow() {
  if (ctx.loginWindow && !ctx.loginWindow.isDestroyed()) {
    await ctx.logger?.info("Login window already open, focusing existing window.");
    ctx.loginWindow.focus();
    return;
  }

  await ctx.logger?.info("Creating login window.");
  ctx.loginWindow = new BrowserWindow({
    width: 1100,
    height: 840,
    parent: ctx.mainWindow || undefined,
    modal: false,
    autoHideMenuBar: true,
    icon: appIconPath,
    backgroundColor: "#16211e",
    webPreferences: {
      partition: AUTH_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  ctx.loginWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeBrowserUrl(url)) void shell.openExternal(url).catch((error) => ctx.logger?.warn("External link failed.", error));
    return { action: "deny" };
  });
  ctx.loginWindow.webContents.on("will-navigate", (event, candidateUrl) => {
    if (!isF95Url(candidateUrl)) {
      event.preventDefault();
      ctx.logger?.warn("Blocked navigation outside f95zone in login window.", { url: candidateUrl });
    }
  });

  const target = "https://f95zone.to/login/";
  await ctx.loginWindow.loadURL(target);

  const checkAuth = async () => {
    const currentUrl = ctx.loginWindow && !ctx.loginWindow.isDestroyed() ? ctx.loginWindow.webContents.getURL() : "";
    const state = await ctx.appService.getAuthState();
    const stillInAuthFlow = /\/login\/|\/two-step\//i.test(currentUrl);
    if (state.loggedIn && !stillInAuthFlow && ctx.loginWindow && !ctx.loginWindow.isDestroyed()) {
      await ctx.logger?.info("Authentication detected, closing login window.");
      ctx.loginWindow.close();
      ctx.appService.emitChange();
    }
  };

  ctx.loginWindow.webContents.on("did-navigate", checkAuth);
  ctx.loginWindow.webContents.on("did-redirect-navigation", checkAuth);
  ctx.loginWindow.on("closed", () => {
    ctx.logger?.info("Login window closed.");
    ctx.loginWindow = null;
    ctx.appService?.resumeAfterBrowserCheck();
  });
}

module.exports = { hardenSession, createWindow, createLoginWindow };
