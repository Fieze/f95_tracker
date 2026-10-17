const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog, session } = require("electron");
const { AppService } = require("./services/appService");
const { Logger } = require("./services/logger");
const {
  ctx,
  AUTH_PARTITION,
  DOWNLOAD_PARTITION,
  APP_USER_MODEL_ID,
  logFilePath,
  downloadLogFilePath,
  extractionLogFilePath,
  parsingLogFilePath
} = require("./context");
const { restoreMainWindow, createTray, showGameUpdateNotification } = require("./tray");
const { hardenSession, createWindow } = require("./windows");
const { attachDownloadSessionListeners } = require("./downloadWindow");
const { bindIpc } = require("./ipc");
const { createBrowserPageLoader } = require("./browserPageLoader");
const { startAutoUpdate, stopAutoUpdate } = require("./updater");

// Cloudflare ties its clearance cookie to the user agent. Version 1.0.3 briefly sent a modified one, which left
// clearance cookies that no longer match; drop them once so a fresh browser check can succeed.
async function resetStaleCloudflareClearance(authSession) {
  const markerPath = path.join(app.getPath("userData"), "browser-identity.txt");
  const identity = authSession.getUserAgent();
  const previous = await fs.promises.readFile(markerPath, "utf8").catch(() => "");
  if (previous === identity) return;
  const cookies = await authSession.cookies.get({ domain: "f95zone.to" }).catch(() => []);
  for (const cookie of cookies.filter((entry) => /^(cf_clearance|__cf_bm|cf_chl)/.test(entry.name))) {
    await authSession.cookies.remove(`https://${cookie.domain.replace(/^\./, "")}${cookie.path}`, cookie.name).catch(() => {});
  }
  await fs.promises.writeFile(markerPath, identity).catch(() => {});
}

if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
app.on("second-instance", restoreMainWindow);

if (hasInstanceLock) app.whenReady().then(async () => {
  ctx.logger = new Logger({ filePath: logFilePath, scope: "main" });
  ctx.downloadLogger = new Logger({ filePath: downloadLogFilePath, scope: "download" });
  ctx.extractionLogger = new Logger({ filePath: extractionLogFilePath, scope: "extraction" });
  ctx.parsingLogger = new Logger({ filePath: parsingLogFilePath, scope: "parsing" });
  await ctx.logger.initialize();
  await ctx.downloadLogger.initialize();
  await ctx.extractionLogger.initialize();
  await ctx.parsingLogger.initialize();
  await ctx.logger.info("Application starting.", {
    isPackaged: app.isPackaged,
    logFilePath
  });

  const authSession = session.fromPartition(AUTH_PARTITION);
  hardenSession(authSession);
  await resetStaleCloudflareClearance(authSession);
  hardenSession(session.fromPartition(DOWNLOAD_PARTITION));
  hardenSession(session.defaultSession);
  attachDownloadSessionListeners();
  ctx.appService = new AppService({
    userDataPath: app.getPath("userData"),
    authSession,
    logger: ctx.logger.child("service"),
    loggers: {
      download: ctx.downloadLogger,
      extraction: ctx.extractionLogger,
      parsing: ctx.parsingLogger
    },
    onGameUpdateAvailable: async (payload) => {
      await ctx.logger?.info("Showing Windows update notification.", payload);
      showGameUpdateNotification(payload);
    },
    onStateChanged: () => {
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send("state:changed");
      }
    }
  });

  ctx.pageLoader = createBrowserPageLoader({ partition: AUTH_PARTITION, session: authSession, logger: ctx.logger });
  ctx.appService.fetcher.setPageLoader((url, options) => ctx.pageLoader.load(url, options));
  await ctx.appService.initialize();
  bindIpc();
  createTray();
  await createWindow();
  await ctx.logger.info("Application ready.");
  startAutoUpdate();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await ctx.logger?.info("App activated with no open windows, recreating main window.");
      await createWindow();
      return;
    }

    restoreMainWindow();
  });
}).catch((error) => {
  ctx.logger?.error("Application startup failed.", error);
  dialog.showErrorBox("Application startup failed", error.message || String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  ctx.logger?.info("All windows closed.");
  if (process.platform === "darwin") {
    return;
  }

  if (ctx.isQuitting) {
    app.quit();
  }
});

let shutdownPromise = null;
let shutdownComplete = false;
app.on("before-quit", (event) => {
  ctx.isQuitting = true;
  if (shutdownComplete || !ctx.appService) return;
  event.preventDefault();
  ctx.appService.gate.closed = true;
  ctx.appService.archiveQueue.closed = true;
  if (shutdownPromise) return;
  shutdownPromise = (async () => {
    stopAutoUpdate();
    await ctx.logger?.info("Application shutting down.");
    ctx.pageLoader?.dispose();
    await ctx.appService.dispose();
    await Promise.all([ctx.logger, ctx.downloadLogger, ctx.extractionLogger, ctx.parsingLogger].map((entry) => entry?.state.writeQueue));
    shutdownComplete = true;
    app.quit();
  })().catch(async (error) => {
    await ctx.logger?.error("Shutdown failed.", error);
    shutdownPromise = null;
    dialog.showErrorBox("Shutdown failed", "Could not safely finish saving application data. " + error.message);
  });
});

process.on("uncaughtException", (error) => {
  ctx.logger?.error("Uncaught exception.", error);
});

process.on("unhandledRejection", (reason) => {
  ctx.logger?.error("Unhandled promise rejection.", reason instanceof Error ? reason : { reason: String(reason) });
});
