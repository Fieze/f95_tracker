const path = require("path");
const { app, dialog, ipcMain, shell } = require("electron");
const { isSafeBrowserUrl, assertTrustedIpcSender } = require("./services/browserSafety");
const { ctx } = require("./context");
const { createLoginWindow } = require("./windows");
const { createDownloadWindow, closeDownloadWindow } = require("./downloadWindow");

function bindIpc() {
  const resolveChannelLogger = (channel) => (String(channel).startsWith("downloads:") ? ctx.downloadLogger : ctx.logger);
  const handle = (channel, listener) => {
    ipcMain.handle(channel, async (event, payload) => {
      assertTrustedIpcSender(event, ctx.mainWindow);
      if (ctx.appService.gate.closed || ctx.appService.gate.exclusive) throw new Error("Application is shutting down or importing data.");
      const channelLogger = resolveChannelLogger(channel);
      await channelLogger?.info(`IPC ${channel} started.`);
      try {
        const result = await (channel === "data:import"
          ? listener(event, payload)
          : ctx.appService.gate.run(() => listener(event, payload)));
        await channelLogger?.info(`IPC ${channel} completed.`);
        return result;
      } catch (error) {
        await channelLogger?.error(`IPC ${channel} failed.`, error);
        throw error;
      }
    });
  };

  handle("app:bootstrap", async () => ctx.appService.bootstrap());
  handle("settings:update", async (_event, payload) => ctx.appService.updateSettings(payload));
  handle("data:export", async () => {
    const result = await dialog.showSaveDialog(ctx.mainWindow, {
      title: "Export data",
      defaultPath: path.join(app.getPath("documents"), "f95-app-export.json"),
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (result.canceled || !result.filePath) {
      await ctx.logger?.info("Export dialog canceled.");
      return { canceled: true, path: "" };
    }

    const exported = await ctx.appService.exportDataToFile(result.filePath);
    return { canceled: false, path: exported.path };
  });
  handle("data:import", async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: "Import data",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    const filePath = result.filePaths?.[0] || "";
    if (result.canceled || !filePath) {
      await ctx.logger?.info("Import dialog canceled.");
      return { canceled: true, path: "" };
    }

    await ctx.appService.importDataFromFile(filePath);
    return { canceled: false, path: filePath };
  });
  handle("folders:select", async (_event, payload) => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
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
    return ctx.appService.getAuthState();
  });
  handle("auth:logout", async () => {
    await ctx.appService.logout();
    return ctx.appService.bootstrap();
  });
  handle("auth:verify", async () => ctx.appService.verifyAuth());
  handle("games:addThread", async (_event, payload) => ctx.appService.addThreadInBackground(payload.url));
  handle("folders:addExisting", async (_event, payload) => ctx.appService.addExistingFolderInBackground(payload));
  handle("drop:inspect", async (_event, payload) => ctx.appService.inspectDroppedPaths(payload?.paths));
  handle("drop:addArchive", async (_event, payload) => ctx.appService.addDroppedArchiveInBackground(payload));
  handle("activities:dismiss", async (_event, activityId) => ctx.appService.dismissActivity(Number(activityId)));
  handle("games:delete", async (_event, gameId) => ctx.appService.deleteGame(gameId));
  handle("games:refresh", async (_event, gameId) => ctx.appService.refreshGame(gameId));
  handle("games:updateSeasons", async (_event, payload) =>
    ctx.appService.updateGameSeasons(payload.gameId, payload.hasSeasons)
  );
  handle("games:setInstalledVersion", async (_event, payload) =>
    ctx.appService.setInstalledVersion(payload.gameId, payload.installedVersion, payload.installPath)
  );
  handle("games:listFolders", async (_event, payload) => ctx.appService.listGameFolders(payload.gameId));
  handle("games:updateFolderVersion", async (_event, payload) => ctx.appService.updateGameFolderVersion(payload));
  handle("games:updateFolderMetadata", async (_event, payload) => ctx.appService.updateGameFolderMetadata(payload, payload));
  handle("games:deleteFolder", async (_event, payload) => ctx.appService.deleteGameFolder(payload));
  handle("games:refreshFolders", async (_event, payload) => ctx.appService.refreshGameFolders(payload.gameId));
  handle("games:listLaunchExecutables", async (_event, payload) => ctx.appService.listLaunchExecutables(payload));
  handle("games:launchExecutable", async (_event, payload) => ctx.appService.launchExecutable(payload));
  handle("games:inferInstalledVersion", async (_event, payload) =>
    ctx.appService.inferInstalledVersionFromFolder(payload.folderPath)
  );
  handle("games:validateInstallPath", async (_event, payload) =>
    ctx.appService.validateInstallPath(payload.gameId)
  );
  handle("games:moveInstallPath", async (_event, payload) =>
    ctx.appService.moveInstallPathToExpected(payload.gameId)
  );
  handle("games:refreshAll", async () => ctx.appService.refreshAllGames());
  handle("jobs:decision", async (_event, payload) => ctx.appService.resolveArchiveMatch(payload));
  handle("jobs:password", async (_event, payload) => ctx.appService.setArchivePassword(payload));
  handle("jobs:deleteFile", async (_event, payload) => ctx.appService.deleteArchiveFile(payload?.jobId));
  handle("downloads:start", async (_event, payload) => createDownloadWindow(payload));
  handle("downloads:cancel", async (_event, payload) => {
    const jobId = Number(payload?.jobId);
    if (!Number.isFinite(jobId)) {
      throw new Error("A valid download job is required.");
    }

    if (ctx.downloadWindowState?.jobId === jobId) {
      closeDownloadWindow();
    }

    ctx.appService.cancelDownloadJob(jobId, "Download canceled by user.");
    return ctx.appService.getState();
  });
  handle("links:open", async (_event, url) => {
    if (!isSafeBrowserUrl(url)) throw new Error("Only HTTP and HTTPS links may be opened.");
    await shell.openExternal(url);
    return { ok: true };
  });
}

module.exports = { bindIpc };
