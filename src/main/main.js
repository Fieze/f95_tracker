const path = require("path");
const { app, BrowserWindow, dialog, ipcMain, shell, session, Tray, Menu, Notification } = require("electron");
const { AppService } = require("./services/appService");
const { Logger } = require("./services/logger");

let mainWindow;
let loginWindow;
let downloadWindow;
let downloadWindowState = null;
let appService;
let logger;
let downloadLogger;
let extractionLogger;
let parsingLogger;
let tray;
let isQuitting = false;
const AUTH_PARTITION = "persist:f95-auth";
const DOWNLOAD_PARTITION = "persist:f95-downloads";
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico")
  : path.join(__dirname, "..", "..", "resources", "icon.ico");
const appRootPath = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, "..", "..");
const logDirectoryPath = path.join(appRootPath, "logs");
const logFilePath = path.join(logDirectoryPath, "main.log");
const downloadLogFilePath = path.join(logDirectoryPath, "download.log");
const extractionLogFilePath = path.join(logDirectoryPath, "extraction.log");
const parsingLogFilePath = path.join(logDirectoryPath, "parsing.log");
const APP_USER_MODEL_ID = "com.f95tracker.app";

if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");

function isSafeBrowserUrl(candidateUrl) {
  try {
    const parsed = new URL(String(candidateUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isSupportedDirectDownload(candidateUrl, label = "") {
  const normalizedLabel = String(label || "").toLowerCase();
  if (
    normalizedLabel.includes("pixeldrain") ||
    normalizedLabel.includes("vikingfile") ||
    normalizedLabel.includes("vik1ngfile")
  ) {
    return true;
  }

  try {
    const host = new URL(String(candidateUrl || "").trim()).host.toLowerCase();
    return (
      host === "vik1ngfile.site" ||
      host === "vikingfile.com" ||
      host === "pixeldrain.com" ||
      host === "www.pixeldrain.com"
    );
  } catch {
    return false;
  }
}

function restoreMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.setSkipTaskbar(false);
  mainWindow.show();
  mainWindow.focus();
}

async function hideMainWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  await logger?.info("Hiding main window to tray.");
  mainWindow.setSkipTaskbar(true);
  mainWindow.hide();
}

function createTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(appIconPath);
  tray.setToolTip("F95 Tracker");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open",
        click: () => {
          restoreMainWindow();
        }
      },
      { type: "separator" },
      {
        label: "Beenden",
        click: async () => {
          isQuitting = true;
          await logger?.info("Quit requested from tray.");
          app.quit();
        }
      }
    ])
  );
  tray.on("click", () => {
    restoreMainWindow();
  });
  return tray;
}

function buildUpdateNotificationBody(payload) {
  const title = payload?.title || "Ein beobachtetes Spiel";
  const currentVersion = payload?.currentVersion ? `v${payload.currentVersion}` : "eine neue Version";
  const installedVersion = payload?.installedVersion ? `Installiert: v${payload.installedVersion}` : "Noch nicht installiert";
  return `${title}: ${currentVersion} verfuegbar. ${installedVersion}`;
}

function showGameUpdateNotification(payload) {
  if (!Notification.isSupported()) {
    logger?.warn("System notifications are not supported on this platform.");
    return;
  }

  const notification = new Notification({
    title: "Update gefunden",
    body: buildUpdateNotificationBody(payload),
    icon: appIconPath,
    silent: false
  });

  notification.on("click", () => {
    restoreMainWindow();
  });
  notification.show();
}

function getDownloadSession() {
  return session.fromPartition(DOWNLOAD_PARTITION);
}

function buildDownloadWindowTitle(payload) {
  const label = String(payload?.label || "").trim();
  return label ? `Download - ${label}` : "Download";
}

function closeDownloadWindow() {
  if (!downloadWindow || downloadWindow.isDestroyed()) {
    downloadWindow = null;
    downloadWindowState = null;
    return;
  }

  if (downloadWindowState) {
    downloadWindowState.closing = true;
  }

  downloadWindow.close();
}

async function buildCookieHeaderForUrl(targetUrl) {
  const downloadCookies = await getDownloadSession().cookies.get({ url: targetUrl });
  const authCookies = appService?.authSession
    ? await appService.authSession.cookies.get({ url: targetUrl }).catch(() => [])
    : [];
  const cookieMap = new Map();

  [...downloadCookies, ...authCookies].forEach((cookie) => {
    if (cookie?.name) {
      cookieMap.set(cookie.name, cookie.value);
    }
  });

  return [...cookieMap.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function syncAuthCookiesToDownloadSession(targetUrl) {
  if (!appService?.authSession || !isSafeBrowserUrl(targetUrl)) {
    return;
  }

  const authCookies = await appService.authSession.cookies.get({ url: targetUrl }).catch(() => []);
  if (authCookies.length === 0) {
    return;
  }

  const downloadSession = getDownloadSession();
  await Promise.all(
    authCookies.map(async (cookie) => {
      const cookieUrl = `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`;
      const payload = {
        url: cookieUrl,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite
      };

      if (cookie.expirationDate) {
        payload.expirationDate = cookie.expirationDate;
      }

      try {
        await downloadSession.cookies.set(payload);
      } catch (error) {
        downloadLogger?.warn("Failed to mirror auth cookie into download session.", {
          targetUrl,
          cookieName: cookie.name,
          message: error.message
        });
      }
    })
  );
}

async function takeOverResolvedDownload(jobId, payload = {}) {
  const job = appService.getDownloadJob(jobId);
  if (!job) {
    return null;
  }

  if (["resolving", "downloading", "completed"].includes(job.status)) {
    return job;
  }

  const resolvedUrl = String(payload.url || "").trim();
  if (!resolvedUrl) {
    throw new Error("No resolved download url was provided.");
  }

  await syncAuthCookiesToDownloadSession(resolvedUrl);
  const cookieHeader = payload.cookieHeader ?? (await buildCookieHeaderForUrl(resolvedUrl));
  const referrer =
    payload.referrer ||
    (downloadWindow && !downloadWindow.isDestroyed() ? downloadWindow.webContents.getURL() : job.sourceUrl);

  closeDownloadWindow();
  return appService.startResolvedDownload(jobId, {
    url: resolvedUrl,
    fileName: payload.fileName || "",
    referrer,
    cookieHeader
  });
}

function maybeTakeOverDownloadUrl(jobId, candidateUrl, extra = {}) {
  if (!appService.isProbableFileDownloadUrl(candidateUrl)) {
    return false;
  }

  void takeOverResolvedDownload(jobId, {
    url: candidateUrl,
    referrer: extra.referrer || candidateUrl,
    fileName: extra.fileName || ""
  }).catch((error) => {
    downloadLogger?.error("Failed to take over resolved download url.", {
      jobId,
      candidateUrl,
      message: error.message
    });
  });

  return true;
}

function attachDownloadSessionListeners() {
  const downloadSession = getDownloadSession();
  if (downloadSession.__f95DownloadListenersAttached) {
    return;
  }

  downloadSession.__f95DownloadListenersAttached = true;
  downloadSession.on("will-download", (event, item, webContents) => {
    const state = downloadWindowState;
    if (!state || webContents.id !== state.webContentsId) {
      return;
    }

    event.preventDefault();
    item.cancel();
    state.downloadStarted = true;

    void takeOverResolvedDownload(state.jobId, {
      url: item.getURL(),
      fileName: item.getFilename(),
      referrer: webContents.getURL()
    }).catch((error) => {
      downloadLogger?.error("Failed to take over browser-triggered download.", {
        jobId: state.jobId,
        url: item.getURL(),
        message: error.message
      });
    });
  });
}

async function createWindow() {
  await logger?.info("Creating main window.");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1320,
    minHeight: 720,
    icon: appIconPath,
    backgroundColor: "#16211e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      partition: AUTH_PARTITION
    }
  });

  await mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    void hideMainWindowToTray();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function createLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    await logger?.info("Login window already open, focusing existing window.");
    loginWindow.focus();
    return;
  }

  await logger?.info("Creating login window.");
  loginWindow = new BrowserWindow({
    width: 1100,
    height: 840,
    parent: mainWindow || undefined,
    modal: false,
    autoHideMenuBar: true,
    icon: appIconPath,
    backgroundColor: "#16211e",
    webPreferences: {
      partition: AUTH_PARTITION,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const target = "https://f95zone.to/login/";
  await loginWindow.loadURL(target);

  const checkAuth = async () => {
    const currentUrl = loginWindow && !loginWindow.isDestroyed() ? loginWindow.webContents.getURL() : "";
    const state = await appService.getAuthState();
    const stillInAuthFlow = /\/login\/|\/two-step\//i.test(currentUrl);
    if (state.loggedIn && !stillInAuthFlow && loginWindow && !loginWindow.isDestroyed()) {
      await logger?.info("Authentication detected, closing login window.");
      loginWindow.close();
      appService.emitChange();
    }
  };

  loginWindow.webContents.on("did-navigate", checkAuth);
  loginWindow.webContents.on("did-redirect-navigation", checkAuth);
  loginWindow.on("closed", () => {
    logger?.info("Login window closed.");
    loginWindow = null;
  });
}

async function createDownloadWindow(payload) {
  const targetUrl = String(payload?.url || "").trim();
  if (!isSupportedDirectDownload(targetUrl, payload?.label || "")) {
    throw new Error("Direct in-app downloads are currently only supported for Vikingfile and Pixeldrain links.");
  }

  await appService.ensureDownloadReady();

  if (downloadWindow && !downloadWindow.isDestroyed()) {
    if (downloadWindowState?.jobId) {
      appService.cancelDownloadJob(downloadWindowState.jobId, "Canceled because another download window was opened.");
    }
    closeDownloadWindow();
  }

  const job = appService.createDownloadJob(payload);
  await syncAuthCookiesToDownloadSession(targetUrl);

  await downloadLogger?.info("Creating download window.", {
    jobId: job.id,
    sourceUrl: targetUrl,
    host: job.host
  });

  downloadWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    parent: mainWindow || undefined,
    modal: true,
    autoHideMenuBar: true,
    icon: appIconPath,
    backgroundColor: "#16211e",
    title: buildDownloadWindowTitle(payload),
    webPreferences: {
      partition: DOWNLOAD_PARTITION,
      preload: path.join(__dirname, "downloadPreload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  downloadWindowState = {
    jobId: job.id,
    webContentsId: downloadWindow.webContents.id,
    closing: false,
    downloadStarted: false
  };

  downloadWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (maybeTakeOverDownloadUrl(job.id, url, { referrer: downloadWindow.webContents.getURL() })) {
      return { action: "deny" };
    }

    if (!isSafeBrowserUrl(url)) {
      downloadLogger?.warn("Blocked non-http download window target.", {
        jobId: job.id,
        url
      });
      return { action: "deny" };
    }

    void syncAuthCookiesToDownloadSession(url)
      .then(() => downloadWindow.loadURL(url))
      .catch((error) => {
        downloadLogger?.warn("Download window navigation failed.", {
          jobId: job.id,
          url,
          message: error.message
        });
      });
    return { action: "deny" };
  });

  const handlePotentialDownloadNavigation = (candidateUrl) => {
    if (!isSafeBrowserUrl(candidateUrl)) {
      return false;
    }

    maybeTakeOverDownloadUrl(job.id, candidateUrl, {
      referrer: downloadWindow && !downloadWindow.isDestroyed() ? downloadWindow.webContents.getURL() : targetUrl
    });
    return true;
  };

  downloadWindow.webContents.on("did-finish-load", () => {
    appService.markDownloadAwaiting(job.id);
  });
  downloadWindow.webContents.on("will-navigate", (event, candidateUrl) => {
    if (!isSafeBrowserUrl(candidateUrl)) {
      event.preventDefault();
      downloadLogger?.warn("Blocked non-http navigation inside download window.", {
        jobId: job.id,
        url: candidateUrl
      });
      return;
    }

    if (maybeTakeOverDownloadUrl(job.id, candidateUrl, { referrer: downloadWindow.webContents.getURL() })) {
      event.preventDefault();
    }
  });
  downloadWindow.webContents.on("did-redirect-navigation", (_event, candidateUrl) => {
    handlePotentialDownloadNavigation(candidateUrl);
  });
  downloadWindow.webContents.on("did-navigate", (_event, candidateUrl) => {
    handlePotentialDownloadNavigation(candidateUrl);
  });

  downloadWindow.on("closed", () => {
    const state = downloadWindowState;
    downloadWindow = null;
    downloadWindowState = null;

    if (state && !state.closing && !state.downloadStarted) {
      appService.cancelDownloadJob(state.jobId);
    }
  });

  try {
    await syncAuthCookiesToDownloadSession(targetUrl);
    await downloadWindow.loadURL(targetUrl);
    return job;
  } catch (error) {
    appService.failDownloadJob(job.id, error);
    closeDownloadWindow();
    throw error;
  }
}

function bindIpc() {
  const resolveChannelLogger = (channel) => (String(channel).startsWith("downloads:") ? downloadLogger : logger);
  const handle = (channel, listener) => {
    ipcMain.handle(channel, async (event, payload) => {
      const channelLogger = resolveChannelLogger(channel);
      await channelLogger?.info(`IPC ${channel} started.`);
      try {
        const result = await listener(event, payload);
        await channelLogger?.info(`IPC ${channel} completed.`);
        return result;
      } catch (error) {
        await channelLogger?.error(`IPC ${channel} failed.`, error);
        throw error;
      }
    });
  };

  handle("app:bootstrap", async () => appService.bootstrap());
  handle("settings:update", async (_event, payload) => appService.updateSettings(payload));
  handle("data:export", async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export data",
      defaultPath: path.join(app.getPath("documents"), "f95-app-export.json"),
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (result.canceled || !result.filePath) {
      await logger?.info("Export dialog canceled.");
      return { canceled: true, path: "" };
    }

    const exported = await appService.exportDataToFile(result.filePath);
    return { canceled: false, path: exported.path };
  });
  handle("data:import", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Import data",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    const filePath = result.filePaths?.[0] || "";
    if (result.canceled || !filePath) {
      await logger?.info("Import dialog canceled.");
      return { canceled: true, path: "" };
    }

    await appService.importDataFromFile(filePath);
    return { canceled: false, path: filePath };
  });
  handle("folders:select", async (_event, payload) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: payload?.title || "Select folder",
      defaultPath: payload?.defaultPath || undefined,
      properties: ["openDirectory", "createDirectory"]
    });

    return {
      canceled: result.canceled,
      path: result.filePaths?.[0] || ""
    };
  });
  handle("auth:openLogin", async () => {
    await createLoginWindow();
    return appService.getAuthState();
  });
  handle("auth:logout", async () => {
    await appService.logout();
    return appService.bootstrap();
  });
  handle("auth:verify", async () => appService.verifyAuth());
  handle("games:addThread", async (_event, payload) => appService.addThread(payload.url));
  handle("games:delete", async (_event, gameId) => appService.deleteGame(gameId));
  handle("games:refresh", async (_event, gameId) => appService.refreshGame(gameId));
  handle("games:updateSeasons", async (_event, payload) =>
    appService.updateGameSeasons(payload.gameId, payload.hasSeasons)
  );
  handle("games:setInstalledVersion", async (_event, payload) =>
    appService.setInstalledVersion(payload.gameId, payload.installedVersion, payload.installPath)
  );
  handle("games:listFolders", async (_event, payload) => appService.listGameFolders(payload.gameId));
  handle("games:updateFolderVersion", async (_event, payload) => appService.updateGameFolderVersion(payload));
  handle("games:updateFolderMetadata", async (_event, payload) => appService.updateGameFolderMetadata(payload, payload));
  handle("games:deleteFolder", async (_event, payload) => appService.deleteGameFolder(payload));
  handle("games:refreshFolders", async (_event, payload) => appService.refreshGameFolders(payload.gameId));
  handle("games:listLaunchExecutables", async (_event, payload) => appService.listLaunchExecutables(payload));
  handle("games:launchExecutable", async (_event, payload) => appService.launchExecutable(payload));
  handle("games:inferInstalledVersion", async (_event, payload) =>
    appService.inferInstalledVersionFromFolder(payload.folderPath)
  );
  handle("games:validateInstallPath", async (_event, payload) =>
    appService.validateInstallPath(payload.gameId)
  );
  handle("games:moveInstallPath", async (_event, payload) =>
    appService.moveInstallPathToExpected(payload.gameId)
  );
  handle("games:refreshAll", async () => appService.refreshAllGames());
  handle("jobs:decision", async (_event, payload) => appService.resolveArchiveMatch(payload));
  handle("jobs:deleteFile", async (_event, payload) => appService.deleteArchiveFile(payload?.jobId));
  handle("downloads:start", async (_event, payload) => createDownloadWindow(payload));
  handle("downloads:cancel", async (_event, payload) => {
    const jobId = Number(payload?.jobId);
    if (!Number.isFinite(jobId)) {
      throw new Error("A valid download job is required.");
    }

    if (downloadWindowState?.jobId === jobId) {
      closeDownloadWindow();
    }

    appService.cancelDownloadJob(jobId, "Download canceled by user.");
    return appService.getState();
  });
  handle("links:open", async (_event, url) => {
    await shell.openExternal(url);
    return { ok: true };
  });
}

app.whenReady().then(async () => {
  logger = new Logger({ filePath: logFilePath, scope: "main" });
  downloadLogger = new Logger({ filePath: downloadLogFilePath, scope: "download" });
  extractionLogger = new Logger({ filePath: extractionLogFilePath, scope: "extraction" });
  parsingLogger = new Logger({ filePath: parsingLogFilePath, scope: "parsing" });
  await logger.initialize();
  await downloadLogger.initialize();
  await extractionLogger.initialize();
  await parsingLogger.initialize();
  await logger.info("Application starting.", {
    isPackaged: app.isPackaged,
    logFilePath
  });

  const authSession = session.fromPartition(AUTH_PARTITION);
  attachDownloadSessionListeners();
  appService = new AppService({
    userDataPath: app.getPath("userData"),
    authSession,
    logger: logger.child("service"),
    loggers: {
      download: downloadLogger,
      extraction: extractionLogger,
      parsing: parsingLogger
    },
    onGameUpdateAvailable: async (payload) => {
      await logger?.info("Showing Windows update notification.", payload);
      showGameUpdateNotification(payload);
    },
    onStateChanged: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("state:changed");
      }
    }
  });

  await appService.initialize();
  bindIpc();
  createTray();
  await createWindow();
  await logger.info("Application ready.");

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await logger?.info("App activated with no open windows, recreating main window.");
      await createWindow();
      return;
    }

    restoreMainWindow();
  });
});

app.on("window-all-closed", () => {
  logger?.info("All windows closed.");
  if (process.platform === "darwin") {
    return;
  }

  if (isQuitting) {
    app.quit();
  }
});

app.on("before-quit", async () => {
  isQuitting = true;
  await logger?.info("Application shutting down.");
  if (appService) {
    await appService.dispose();
  }
});

process.on("uncaughtException", (error) => {
  logger?.error("Uncaught exception.", error);
});

process.on("unhandledRejection", (reason) => {
  logger?.error("Unhandled promise rejection.", reason instanceof Error ? reason : { reason: String(reason) });
});
