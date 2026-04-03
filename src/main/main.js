const path = require("path");
const { app, BrowserWindow, dialog, ipcMain, shell, session } = require("electron");
const { AppService } = require("./services/appService");

let mainWindow;
let loginWindow;
let appService;
const AUTH_PARTITION = "persist:f95-auth";

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
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
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 1100,
    height: 840,
    parent: mainWindow || undefined,
    modal: false,
    autoHideMenuBar: true,
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
      loginWindow.close();
      appService.emitChange();
    }
  };

  loginWindow.webContents.on("did-navigate", checkAuth);
  loginWindow.webContents.on("did-redirect-navigation", checkAuth);
  loginWindow.on("closed", () => {
    loginWindow = null;
  });
}

function bindIpc() {
  ipcMain.handle("app:bootstrap", async () => appService.bootstrap());
  ipcMain.handle("settings:update", async (_event, payload) => appService.updateSettings(payload));
  ipcMain.handle("folders:select", async (_event, payload) => {
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
  ipcMain.handle("auth:openLogin", async () => {
    await createLoginWindow();
    return appService.getAuthState();
  });
  ipcMain.handle("auth:logout", async () => {
    await appService.logout();
    return appService.bootstrap();
  });
  ipcMain.handle("auth:verify", async () => appService.verifyAuth());
  ipcMain.handle("games:addThread", async (_event, payload) => appService.addThread(payload.url));
  ipcMain.handle("games:delete", async (_event, gameId) => appService.deleteGame(gameId));
  ipcMain.handle("games:refresh", async (_event, gameId) => appService.refreshGame(gameId));
  ipcMain.handle("games:setInstalledVersion", async (_event, payload) =>
    appService.setInstalledVersion(payload.gameId, payload.installedVersion, payload.installPath)
  );
  ipcMain.handle("games:listFolders", async (_event, payload) => appService.listGameFolders(payload.gameId));
  ipcMain.handle("games:updateFolderVersion", async (_event, payload) => appService.updateGameFolderVersion(payload));
  ipcMain.handle("games:deleteFolder", async (_event, payload) => appService.deleteGameFolder(payload));
  ipcMain.handle("games:refreshFolders", async (_event, payload) => appService.refreshGameFolders(payload.gameId));
  ipcMain.handle("games:inferInstalledVersion", async (_event, payload) =>
    appService.inferInstalledVersionFromFolder(payload.folderPath)
  );
  ipcMain.handle("games:validateInstallPath", async (_event, payload) =>
    appService.validateInstallPath(payload.gameId)
  );
  ipcMain.handle("games:moveInstallPath", async (_event, payload) =>
    appService.moveInstallPathToExpected(payload.gameId)
  );
  ipcMain.handle("games:refreshAll", async () => appService.refreshAllGames());
  ipcMain.handle("jobs:decision", async (_event, payload) => appService.resolveArchiveMatch(payload));
  ipcMain.handle("links:open", async (_event, url) => {
    await shell.openExternal(url);
    return { ok: true };
  });
}

app.whenReady().then(async () => {
  const authSession = session.fromPartition(AUTH_PARTITION);
  appService = new AppService({
    userDataPath: app.getPath("userData"),
    authSession,
    onStateChanged: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("state:changed");
      }
    }
  });

  await appService.initialize();
  bindIpc();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  if (appService) {
    await appService.dispose();
  }
});
