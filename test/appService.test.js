const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { AppService } = require("../src/main/services/appService");

async function createService(options = {}) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "f95-app-service-"));
  const service = new AppService({
    userDataPath,
    authSession: {
      cookies: {
        get: async () => []
      }
    },
    onStateChanged: () => {},
    onGameUpdateAvailable: options.onGameUpdateAvailable
  });
  await service.db.initialize();
  return { service, userDataPath };
}

async function createGameWithInstalledVersion(service, overrides = {}) {
  const sourceUrl = overrides.sourceUrl || "https://f95zone.to/threads/update-game.4242/";
  const title = overrides.title || "Update Game";
  const currentVersion = overrides.currentVersion || "1.0";
  const installedVersion = Object.prototype.hasOwnProperty.call(overrides, "installedVersion")
    ? overrides.installedVersion
    : "1.0";

  const game = await service.db.upsertGameFromThread({
    sourceUrl,
    title,
    threadTitle: overrides.threadTitle || title,
    currentVersion,
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: [],
    rawOpHtml: overrides.rawOpHtml || "",
    rawOpText: overrides.rawOpText || "",
    parserDebug: {},
    downloadGroups: []
  });

  await service.db.updateInstalledVersion(game.id, installedVersion, null);
  return service.db.getGameById(game.id);
}

test("inferInstalledVersionFromFolder returns improved versions for common folder formats", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  assert.equal(
    service.inferInstalledVersionFromFolder("D:\\Games\\Example Game\\Example Game Ep.1-29").inferredVersion,
    "Ep.1-29"
  );
  assert.equal(
    service.inferInstalledVersionFromFolder("D:\\Games\\Example Game\\Example Game v0.15.1a").inferredVersion,
    "0.15.1a"
  );
});

test("createBackup keeps only the newest three backups", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  for (let index = 0; index < 4; index += 1) {
    await service.createBackup();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const files = await fs.readdir(path.join(userDataPath, "backups"));
  assert.equal(files.filter((name) => name.endsWith(".json")).length, 3);
});

test("initialize triggers one background refresh for all games", async (t) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "f95-app-service-init-"));
  const service = new AppService({
    userDataPath,
    authSession: {
      cookies: {
        get: async () => []
      }
    },
    onStateChanged: () => {}
  });

  let refreshCount = 0;
  service.refreshAllGames = async () => {
    refreshCount += 1;
    return service.getState();
  };

  t.after(async () => {
    await service.dispose();
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  await service.initialize();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(refreshCount, 1);
});

test("emitUpdateNotificationIfNeeded does not notify when no status change happened", async (t) => {
  const notifications = [];
  const { service, userDataPath } = await createService({
    onGameUpdateAvailable: async (payload) => {
      notifications.push(payload);
    }
  });
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const previousGame = await createGameWithInstalledVersion(service, {
    sourceUrl: "https://f95zone.to/threads/no-change.5001/",
    title: "No Change",
    currentVersion: "1.0",
    installedVersion: "1.0"
  });
  const nextGame = service.db.getGameById(previousGame.id);

  await service.emitUpdateNotificationIfNeeded(previousGame, nextGame);

  assert.equal(notifications.length, 0);
});

test("emitUpdateNotificationIfNeeded notifies when a game becomes update-available", async (t) => {
  const notifications = [];
  const { service, userDataPath } = await createService({
    onGameUpdateAvailable: async (payload) => {
      notifications.push(payload);
    }
  });
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const previousGame = await createGameWithInstalledVersion(service, {
    sourceUrl: "https://f95zone.to/threads/update-once.5002/",
    title: "Update Once",
    currentVersion: "1.0",
    installedVersion: "1.0"
  });

  await service.db.upsertGameFromThread({
    sourceUrl: previousGame.threadUrl,
    title: previousGame.title,
    threadTitle: previousGame.threadTitle,
    currentVersion: "1.1",
    developer: previousGame.developer,
    engine: previousGame.engine,
    threadStatus: previousGame.threadStatus,
    overview: previousGame.overview,
    releaseDate: previousGame.releaseDate,
    changelog: previousGame.changelog,
    bannerImage: previousGame.bannerImage,
    screenshotImages: previousGame.screenshotImages,
    tags: previousGame.tags,
    warnings: [],
    aliases: previousGame.aliases,
    rawOpHtml: "<article>updated</article>",
    rawOpText: "updated",
    parserDebug: {},
    downloadGroups: previousGame.downloadGroups
  });
  const nextGame = service.db.getGameById(previousGame.id);

  await service.emitUpdateNotificationIfNeeded(previousGame, nextGame);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].gameId, previousGame.id);
  assert.equal(notifications[0].title, "Update Once");
  assert.equal(notifications[0].status, "update-available");
  assert.equal(notifications[0].currentVersion, "1.1");
  assert.equal(notifications[0].installedVersion, "1.0");
});

test("emitUpdateNotificationIfNeeded does not notify twice for an already known update", async (t) => {
  const notifications = [];
  const { service, userDataPath } = await createService({
    onGameUpdateAvailable: async (payload) => {
      notifications.push(payload);
    }
  });
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const previousGame = await createGameWithInstalledVersion(service, {
    sourceUrl: "https://f95zone.to/threads/already-update.5003/",
    title: "Already Update",
    currentVersion: "1.1",
    installedVersion: "1.0"
  });
  const nextGame = service.db.getGameById(previousGame.id);

  await service.emitUpdateNotificationIfNeeded(previousGame, nextGame);

  assert.equal(notifications.length, 0);
});

test("hasThreadChanges returns false when the parsed thread content is unchanged", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  assert.equal(
    service.hasThreadChanges(
      {
        sourceUrl: "https://f95zone.to/threads/example-game.123/",
        rawOpHtml: "<article>same</article>",
        rawOpText: "same"
      },
      {
        sourceUrl: "https://f95zone.to/threads/example-game.123/",
        rawOpHtml: "<article>same</article>",
        rawOpText: "same"
      }
    ),
    false
  );
});

test("hasThreadChanges returns true when parser results change despite identical html", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  assert.equal(
    service.hasThreadChanges(
      {
        sourceUrl: "https://f95zone.to/threads/example-game.123/",
        rawOpHtml: "<article>same</article>",
        rawOpText: "same",
        parserWarnings: ["No download links were detected in the opening post."],
        downloadGroups: []
      },
      {
        sourceUrl: "https://f95zone.to/threads/example-game.123/",
        rawOpHtml: "<article>same</article>",
        rawOpText: "same",
        warnings: [],
        downloadGroups: [
          {
            label: "Win/Linux",
            links: [
              { label: "Mega", url: "https://example.org/win" }
            ]
          }
        ]
      }
    ),
    true
  );
});

test("hydrateThreadAssets reuses cached assets with the same source url", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const bannerPath = path.join(userDataPath, "thread-assets", "banner-existing.jpg");
  const screenshotPath = path.join(userDataPath, "thread-assets", "shot-existing.jpg");
  await fs.mkdir(path.dirname(bannerPath), { recursive: true });
  await fs.writeFile(bannerPath, "banner");
  await fs.writeFile(screenshotPath, "shot");

  let downloadCount = 0;
  service.downloadAsset = async () => {
    downloadCount += 1;
    throw new Error("download should not be called");
  };

  const hydrated = await service.hydrateThreadAssets(
    {
      bannerImageUrl: "https://example.com/banner.jpg",
      screenshotImageUrls: ["https://example.com/shot-1.jpg"],
      warnings: []
    },
    {
      bannerImage: {
        sourceUrl: "https://example.com/banner.jpg",
        localPath: bannerPath
      },
      screenshotImages: [
        {
          sourceUrl: "https://example.com/shot-1.jpg",
          localPath: screenshotPath
        }
      ]
    }
  );

  assert.equal(downloadCount, 0);
  assert.deepEqual(hydrated.bannerImage, {
    sourceUrl: "https://example.com/banner.jpg",
    localPath: bannerPath
  });
  assert.deepEqual(hydrated.screenshotImages, [
    {
      sourceUrl: "https://example.com/shot-1.jpg",
      localPath: screenshotPath
    }
  ]);
});

test("listLaunchExecutables only scans direct .exe files and recommends the best match", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const folderPath = path.join(userDataPath, "Away From Home", "Away From Home-0.10");
  await fs.mkdir(path.join(folderPath, "bin"), { recursive: true });
  await fs.writeFile(path.join(folderPath, "Away From Home.exe"), "");
  await fs.writeFile(path.join(folderPath, "UnityCrashHandler64.exe"), "");
  await fs.writeFile(path.join(folderPath, "bin", "NestedGame.exe"), "");

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/away-from-home.1234/",
    title: "Away From Home",
    threadTitle: "Away From Home [v0.10]",
    currentVersion: "0.10",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: ["AFH"],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  await service.db.replaceGameFolders(game.id, [
    {
      folderName: path.basename(folderPath),
      folderPath,
      version: "0.10",
      versionSource: "inferred"
    }
  ]);

  const folders = service.db.listGameFolders(game.id);
  const result = await service.listLaunchExecutables({ folderId: folders[0].id });

  assert.deepEqual(
    result.executables.map((entry) => entry.fileName),
    ["Away From Home.exe", "UnityCrashHandler64.exe"]
  );
  assert.equal(result.executables[0].isRecommended, true);
  assert.equal(result.executables[0].isSelected, false);
});

test("listLaunchExecutables marks the persisted preferred executable as selected", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const folderPath = path.join(userDataPath, "Chooser", "Chooser-1.0");
  await fs.mkdir(folderPath, { recursive: true });
  const preferredExePath = path.join(folderPath, "Chooser.exe");
  await fs.writeFile(preferredExePath, "");
  await fs.writeFile(path.join(folderPath, "helper.exe"), "");

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/chooser.1111/",
    title: "Chooser",
    threadTitle: "Chooser",
    currentVersion: "1.0",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  await service.db.replaceGameFolders(game.id, [
    {
      folderName: path.basename(folderPath),
      folderPath,
      version: "1.0",
      versionSource: "manual",
      preferredExePath
    }
  ]);

  const [folder] = service.db.listGameFolders(game.id);
  const result = await service.listLaunchExecutables({ folderId: folder.id });
  assert.equal(result.executables.find((entry) => entry.fullPath === preferredExePath)?.isSelected, true);
});

test("launchExecutable rejects paths outside the selected folder root", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const folderPath = path.join(userDataPath, "Away From Home", "Away From Home-0.10");
  const nestedPath = path.join(folderPath, "bin", "Away From Home.exe");
  await fs.mkdir(path.dirname(nestedPath), { recursive: true });
  await fs.writeFile(nestedPath, "");

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/away-from-home.9999/",
    title: "Away From Home",
    threadTitle: "Away From Home",
    currentVersion: "0.10",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  await service.db.replaceGameFolders(game.id, [
    {
      folderName: path.basename(folderPath),
      folderPath,
      version: "0.10",
      versionSource: "inferred"
    }
  ]);

  const folders = service.db.listGameFolders(game.id);

  await assert.rejects(
    service.launchExecutable({
      folderId: folders[0].id,
      executablePath: nestedPath
    }),
    /directly inside the selected game folder/i
  );
});

test("updateGameSeasons persists the game-level seasons flag", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/season-game.5555/",
    title: "Season Game",
    threadTitle: "Season Game",
    currentVersion: "1.0",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  const updated = await service.updateGameSeasons(game.id, true);
  assert.equal(updated.hasSeasons, true);
});

test("updateGameFolderMetadata persists season fields", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const folderPath = path.join(userDataPath, "Seasoned Game", "Seasoned Game-1.0");
  await fs.mkdir(folderPath, { recursive: true });

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/seasoned-game.7777/",
    title: "Seasoned Game",
    threadTitle: "Seasoned Game",
    currentVersion: "1.0",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  await service.db.replaceGameFolders(game.id, [
    {
      folderName: path.basename(folderPath),
      folderPath,
      version: "1.0",
      versionSource: "inferred"
    }
  ]);

  const [folder] = service.db.listGameFolders(game.id);
  const updatedGame = await service.updateGameFolderMetadata(
    { folderId: folder.id },
    { seasonNumber: 3, seasonFinal: true, preferredExePath: "D:\\Games\\Seasoned Game\\Seasoned Game-1.0\\Seasoned.exe" }
  );

  assert.equal(updatedGame.folders[0].seasonNumber, 3);
  assert.equal(updatedGame.folders[0].seasonFinal, true);
  assert.equal(updatedGame.folders[0].preferredExePath, "D:\\Games\\Seasoned Game\\Seasoned Game-1.0\\Seasoned.exe");
});

test("resolveLaunchExecutablePath falls back to the recommended executable and persists it when none is saved", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const folderPath = path.join(userDataPath, "Fallback Game", "Fallback Game-1.0");
  await fs.mkdir(folderPath, { recursive: true });
  const expectedExePath = path.join(folderPath, "Fallback Game.exe");
  await fs.writeFile(expectedExePath, "");
  await fs.writeFile(path.join(folderPath, "UnityCrashHandler64.exe"), "");

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/fallback-game.1212/",
    title: "Fallback Game",
    threadTitle: "Fallback Game",
    currentVersion: "1.0",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  await service.db.replaceGameFolders(game.id, [
    {
      folderName: path.basename(folderPath),
      folderPath,
      version: "1.0",
      versionSource: "manual"
    }
  ]);

  const [folder] = service.db.listGameFolders(game.id);
  const resolvedPath = await service.resolveLaunchExecutablePath(folder);
  const updatedFolder = service.db.getGameFolder(folder.id);

  assert.equal(resolvedPath, expectedExePath);
  assert.equal(updatedFolder.preferredExePath, expectedExePath);
});

test("syncGameFolders preserves manual season metadata for unchanged folder paths", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const installRoot = path.join(userDataPath, "installs");
  const gameRoot = path.join(installRoot, "Season Sync");
  const versionFolder = path.join(gameRoot, "Season Sync-1.0");
  await fs.mkdir(versionFolder, { recursive: true });
  await service.db.saveSettings({
    watchFolder: "",
    installRoot,
    syncIntervalMinutes: 30
  });

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/season-sync.8888/",
    title: "Season Sync",
    threadTitle: "Season Sync",
    currentVersion: "1.0",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  await service.db.replaceGameFolders(game.id, [
    {
      folderName: "Season Sync-1.0",
      folderPath: versionFolder,
      version: "1.0",
      versionSource: "manual",
      seasonNumber: 4,
      seasonFinal: true
    }
  ]);

  await service.syncGameFolders(game.id, { game: service.db.getGameById(game.id) });
  const syncedGame = service.db.getGameById(game.id);

  assert.equal(syncedGame.folders[0].seasonNumber, 4);
  assert.equal(syncedGame.folders[0].seasonFinal, true);
});

test("updateGameFolderVersion recalculates sort ranks so newest version stays on top", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/rank-game.1010/",
    title: "Rank Game",
    threadTitle: "Rank Game",
    currentVersion: "1.0",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  await service.db.replaceGameFolders(game.id, [
    {
      folderName: "Rank Game-0.8",
      folderPath: "D:\\Games\\Rank Game\\Rank Game-0.8",
      version: "0.8",
      versionSource: "manual"
    },
    {
      folderName: "Rank Game-0.7",
      folderPath: "D:\\Games\\Rank Game\\Rank Game-0.7",
      version: "0.7",
      versionSource: "manual"
    }
  ]);

  const secondFolder = service.db.listGameFolders(game.id).find((folder) => folder.version === "0.7");
  await service.updateGameFolderVersion({ folderId: secondFolder.id, version: "0.9" });

  const rankedFolders = service.db.listGameFolders(game.id);
  assert.equal(rankedFolders[0].version, "0.9");
  assert.equal(rankedFolders[0].sortRank, 1);
});

test("updateGameSeasons recalculates sort ranks using season order", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/rank-season-game.2020/",
    title: "Rank Season Game",
    threadTitle: "Rank Season Game",
    currentVersion: "1.0",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  await service.db.replaceGameFolders(game.id, [
    {
      folderName: "S1",
      folderPath: "D:\\Games\\Rank Season Game\\S1",
      version: "1.0",
      versionSource: "manual",
      seasonNumber: 1
    },
    {
      folderName: "S4",
      folderPath: "D:\\Games\\Rank Season Game\\S4",
      version: "1.0",
      versionSource: "manual",
      seasonNumber: 4
    },
    {
      folderName: "S2",
      folderPath: "D:\\Games\\Rank Season Game\\S2",
      version: "1.0",
      versionSource: "manual",
      seasonNumber: 2
    }
  ]);

  await service.updateGameSeasons(game.id, true);
  const rankedFolders = service.db.listGameFolders(game.id);
  assert.deepEqual(rankedFolders.map((folder) => folder.seasonNumber), [4, 1, 2]);
});

test("updating only seasonFinal keeps existing sort ranks stable", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/final-rank-game.3030/",
    title: "Final Rank Game",
    threadTitle: "Final Rank Game",
    currentVersion: "1.0",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  await service.db.replaceGameFolders(game.id, [
    {
      folderName: "A",
      folderPath: "D:\\Games\\Final Rank Game\\A",
      version: null,
      versionSource: "manual",
      sortRank: 1
    },
    {
      folderName: "B",
      folderPath: "D:\\Games\\Final Rank Game\\B",
      version: null,
      versionSource: "manual",
      sortRank: 2
    }
  ]);

  const beforeRanks = service.db.listGameFolders(game.id).map((folder) => folder.sortRank);
  const firstFolder = service.db.listGameFolders(game.id)[0];
  await service.updateGameFolderMetadata({ folderId: firstFolder.id }, { seasonFinal: true });
  const afterRanks = service.db.listGameFolders(game.id).map((folder) => folder.sortRank);

  assert.deepEqual(afterRanks, beforeRanks);
});

test("startResolvedDownload requires a configured watch folder", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const job = service.createDownloadJob({
    gameId: 1,
    linkId: 1,
    url: "https://example.com/file.zip",
    label: "Example"
  });

  await assert.rejects(
    () => service.startResolvedDownload(job.id, { url: "https://example.com/file.zip" }),
    /watch folder/i
  );
  assert.equal(service.getDownloadJob(job.id)?.status, "failed");
});

test("startResolvedDownload streams files into the watch folder", async (t) => {
  const { service, userDataPath } = await createService();
  const watchFolder = path.join(userDataPath, "watch");
  await service.updateSettings({
    watchFolder,
    installRoot: path.join(userDataPath, "installs"),
    syncIntervalMinutes: 30
  });

  const server = http.createServer((request, response) => {
    if (request.url === "/archive") {
      const payload = Buffer.from("download payload");
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": payload.length,
        "Content-Disposition": 'attachment; filename="sample.zip"'
      });
      response.end(payload);
      return;
    }

    response.writeHead(404);
    response.end("missing");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const archiveUrl = `http://127.0.0.1:${address.port}/archive`;

  t.after(async () => {
    server.close();
    await service.dispose();
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const job = service.createDownloadJob({
    gameId: 1,
    linkId: 2,
    url: archiveUrl,
    label: "Archive",
    detectedVersion: "1.2"
  });

  const autoExtractCalls = [];
  service.processArchive = async (payload) => {
    autoExtractCalls.push(payload);
    return { id: 99, status: "processed" };
  };

  const completed = await service.startResolvedDownload(job.id, {
    url: archiveUrl,
    referrer: "https://host.example/file"
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.fileName, "sample.zip");
  assert.match(completed.targetPath, /sample\.zip$/);
  assert.ok(completed.startedAt);
  assert.ok(completed.completedAt);
  assert.ok(Number(completed.speedBytesPerSecond) >= 0);
  assert.equal(await fs.readFile(completed.targetPath, "utf8"), "download payload");
  await assert.rejects(() => fs.access(`${completed.targetPath}.part`));
  assert.equal(autoExtractCalls.length, 1);
  assert.equal(autoExtractCalls[0].gameId, 1);
  assert.equal(autoExtractCalls[0].detectedVersion, "1.2");
  assert.equal(autoExtractCalls[0].autoExtract, true);
});

test("processArchive persists and returns a stable archive job", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await service.dispose();
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const job = await service.processArchive({
    archivePath: "C:\\Downloads\\Example-1.0-win.zip",
    archiveName: "Example-1.0-win.zip",
    archiveHash: "abc123"
  });

  assert.ok(job);
  assert.equal(job.archive_name, "Example-1.0-win.zip");
  assert.ok(job.status);
});

test("processArchive can force a game match and trigger extraction", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await service.dispose();
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/example-game.111/",
    title: "Example Game",
    threadTitle: "Example Game",
    currentVersion: "2.0",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  const extractCalls = [];
  service.extractJob = async (jobId, gameId, detectedVersion) => {
    extractCalls.push({ jobId, gameId, detectedVersion });
  };

  const job = await service.processArchive({
    archivePath: "C:\\Downloads\\Example-2.0-win.zip",
    archiveName: "Example-2.0-win.zip",
    archiveHash: "xyz987",
    gameId: game.id,
    detectedVersion: game.currentVersion,
    autoExtract: true
  });

  assert.ok(job);
  assert.equal(extractCalls.length, 1);
  assert.equal(extractCalls[0].gameId, game.id);
  assert.equal(extractCalls[0].detectedVersion, "2.0");
});

test("pruneMissingArchiveJobs removes queue entries whose files no longer exist", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await service.dispose();
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  await service.db.createArchiveJob({
    archivePath: path.join(userDataPath, "missing.zip"),
    archiveName: "missing.zip",
    archiveHash: "missing",
    status: "queued",
    confidence: "high",
    matchCandidates: []
  });

  await service.pruneMissingArchiveJobs();

  assert.equal(service.db.listArchiveJobs().length, 0);
});

test("deleteArchiveFile removes the file and queue entry", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await service.dispose();
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const archivePath = path.join(userDataPath, "delete-me.zip");
  await fs.writeFile(archivePath, "archive");
  const job = await service.db.createArchiveJob({
    archivePath,
    archiveName: "delete-me.zip",
    archiveHash: "delete",
    status: "queued",
    confidence: "high",
    matchCandidates: []
  });

  await service.deleteArchiveFile(job.id);

  await assert.rejects(() => fs.access(archivePath));
  assert.equal(service.db.listArchiveJobs().length, 0);
});

test("processed archive jobs are removed after the retention delay", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await service.dispose();
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const job = await service.db.createArchiveJob({
    archivePath: path.join(userDataPath, "processed.zip"),
    archiveName: "processed.zip",
    archiveHash: "processed",
    status: "processed",
    confidence: "high",
    matchCandidates: []
  });

  service.scheduleProcessedArchiveRemoval(job.id, 20);
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(service.db.listArchiveJobs().length, 0);
});

test("extractJob marks invalid archives as failed instead of throwing through IPC", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await service.dispose();
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const installRoot = path.join(userDataPath, "installs");
  const archivePath = path.join(userDataPath, "broken.rar");
  await fs.mkdir(installRoot, { recursive: true });
  await fs.writeFile(archivePath, "not a real archive");
  await service.db.saveSettings({
    watchFolder: path.join(userDataPath, "watch"),
    installRoot,
    syncIntervalMinutes: 30
  });

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/broken-archive.4040/",
    title: "Broken Archive",
    threadTitle: "Broken Archive",
    currentVersion: "0.9.2",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  const job = await service.db.createArchiveJob({
    archivePath,
    archiveName: "Midnight_Sin_v0.9.2.rar",
    archiveHash: "broken",
    gameId: game.id,
    detectedVersion: "0.9.2",
    status: "queued",
    confidence: "high",
    matchCandidates: []
  });

  service.archiveHasSingleRootDirectory = async () => {
    throw new Error(`ERROR: ${archivePath} : Cannot open the file as archive`);
  };

  await assert.doesNotReject(() => service.extractJob(job.id, game.id, "0.9.2"));

  const failedJob = service.db.listArchiveJobs().find((entry) => entry.id === job.id);
  assert.equal(failedJob.status, "failed");
  assert.match(failedJob.errorText, /cannot open the file as archive/i);
  assert.equal(service.currentExtraction, null);
});
