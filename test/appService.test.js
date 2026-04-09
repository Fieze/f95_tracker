const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { AppService } = require("../src/main/services/appService");

async function createService() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "f95-app-service-"));
  const service = new AppService({
    userDataPath,
    authSession: {
      cookies: {
        get: async () => []
      }
    },
    onStateChanged: () => {}
  });
  await service.db.initialize();
  return { service, userDataPath };
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
