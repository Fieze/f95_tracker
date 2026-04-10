const path = require("path");
const { app, BrowserWindow, dialog, ipcMain, shell, session } = require("electron");
const { AppService } = require("./services/appService");
const { Logger } = require("./services/logger");

let mainWindow;
let loginWindow;
let appService;
let logger;
const AUTH_PARTITION = "persist:f95-auth";
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico")
  : path.join(__dirname, "..", "..", "resources", "icon.ico");
const appRootPath = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, "..", "..");
const logFilePath = path.join(appRootPath, "app-log.txt");

async function createWindow() {
  await logger?.info("Creating main window.");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
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

function bindIpc() {
  const handle = (channel, listener) => {
    ipcMain.handle(channel, async (event, payload) => {
      await logger?.info(`IPC ${channel} started.`);
      try {
        const result = await listener(event, payload);
        await logger?.info(`IPC ${channel} completed.`);
        return result;
      } catch (error) {
        await logger?.error(`IPC ${channel} failed.`, error);
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
  handle("links:open", async (_event, url) => {
    await shell.openExternal(url);
    return { ok: true };
  });
}

app.whenReady().then(async () => {
  logger = new Logger({ filePath: logFilePath, scope: "main" });
  await logger.initialize();
  await logger.info("Application starting.", {
    isPackaged: app.isPackaged,
    logFilePath
  });

  const authSession = session.fromPartition(AUTH_PARTITION);
  appService = new AppService({
    userDataPath: app.getPath("userData"),
    authSession,
    logger: logger.child("service"),
    onStateChanged: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("state:changed");
      }
    }
  });

  await appService.initialize();
  bindIpc();
  await createWindow();
  await logger.info("Application ready.");

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await logger?.info("App activated with no open windows, recreating main window.");
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  logger?.info("All windows closed.");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
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
