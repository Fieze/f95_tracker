const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { DatabaseService } = require("../src/main/services/db");

async function createDb() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "f95-db-test-"));
  const db = new DatabaseService(tempDir);
  await db.initialize();
  return {
    db,
    tempDir
  };
}

test("database migration creates the game_folders table", async (t) => {
  const { db, tempDir } = await createDb();
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game_folders'");
  assert.equal(tables.length, 1);

  const gameColumns = db.query("PRAGMA table_info(games)");
  const folderColumns = db.query("PRAGMA table_info(game_folders)");
  assert.equal(gameColumns.some((column) => column.name === "has_seasons"), true);
  assert.equal(folderColumns.some((column) => column.name === "season_number"), true);
  assert.equal(folderColumns.some((column) => column.name === "season_final"), true);
  assert.equal(folderColumns.some((column) => column.name === "preferred_exe_path"), true);
  assert.equal(folderColumns.some((column) => column.name === "sort_rank"), true);
});

test("applyDerivedInstallState hydrates folders into the game object", async (t) => {
  const { db, tempDir } = await createDb();
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const game = await db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/example-game.1/",
    title: "Example Game",
    threadTitle: "Example Game [v0.2]",
    currentVersion: "0.2",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "Overview",
    releaseDate: "2026-04-03",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    downloadGroups: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    warnings: []
  });

  await db.replaceGameFolders(game.id, [
    {
      folderName: "Example Game-0.1",
      folderPath: "D:\\Games\\Example Game\\Example Game-0.1",
      version: "0.1",
      versionSource: "manual"
    },
    {
      folderName: "Example Game-0.2",
      folderPath: "D:\\Games\\Example Game\\Example Game-0.2",
      version: "0.2",
      versionSource: "inferred"
    }
  ]);
  await db.applyDerivedInstallState(game.id, db.listGameFolders(game.id));

  const hydrated = db.getGameById(game.id);
  assert.equal(hydrated.installedVersion, "0.2");
  assert.equal(hydrated.installPath, "D:\\Games\\Example Game\\Example Game-0.2");
  assert.equal(hydrated.folders.length, 2);
});

test("replaceGameFolders preserves ids for unchanged folder paths", async (t) => {
  const { db, tempDir } = await createDb();
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const game = await db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/example-game-stable.2/",
    title: "Example Game Stable",
    threadTitle: "Example Game Stable [v0.2]",
    currentVersion: "0.2",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "Overview",
    releaseDate: "2026-04-03",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    downloadGroups: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    warnings: []
  });

  const [firstFolder] = await db.replaceGameFolders(game.id, [
    {
      folderName: "Example Game Stable-0.2",
      folderPath: "D:\\Games\\Example Game Stable\\Example Game Stable-0.2",
      version: "0.2",
      versionSource: "inferred"
    }
  ]);

  const [secondFolder] = await db.replaceGameFolders(game.id, [
    {
      folderName: "Example Game Stable-0.2",
      folderPath: "D:\\Games\\Example Game Stable\\Example Game Stable-0.2",
      version: "0.2",
      versionSource: "inferred"
    }
  ]);

  assert.equal(firstFolder.id, secondFolder.id);
});

test("exportSnapshot and importSnapshot round-trip settings and games", async (t) => {
  const { db, tempDir } = await createDb();
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await db.saveSettings({
    watchFolder: "C:\\Watch",
    installRoot: "D:\\Games",
    syncIntervalMinutes: 45
  });
  const game = await db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/backup-game.3/",
    title: "Backup Game",
    threadTitle: "Backup Game [v1.0]",
    currentVersion: "1.0",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "Overview",
    releaseDate: "2026-04-03",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: ["tag-a"],
    downloadGroups: [
      {
        label: "Downloads",
        links: [{ label: "Mega", url: "https://example.com/file" }]
      }
    ],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    warnings: []
  });
  await db.replaceGameFolders(game.id, [
    {
      folderName: "Backup Game-1.0",
      folderPath: "D:\\Games\\Backup Game\\Backup Game-1.0",
      version: "1.0",
      versionSource: "inferred",
      seasonNumber: 2,
      seasonFinal: true
    }
  ]);
  await db.updateGameSeasons(game.id, true);

  const snapshot = db.exportSnapshot();

  const { db: importedDb, tempDir: importedTempDir } = await createDb();
  t.after(async () => {
    await fs.rm(importedTempDir, { recursive: true, force: true });
  });

  await importedDb.importSnapshot(snapshot);

  const importedSettings = importedDb.getSettings();
  const importedGames = importedDb.getGames();
  assert.equal(importedSettings.watchFolder, "C:\\Watch");
  assert.equal(importedSettings.installRoot, "D:\\Games");
  assert.equal(importedSettings.syncIntervalMinutes, 45);
  assert.equal(importedGames.length, 1);
  assert.equal(importedGames[0].title, "Backup Game");
  assert.equal(importedGames[0].hasSeasons, true);
  assert.equal(importedGames[0].downloadGroups[0].links[0].label, "Mega");
  assert.equal(importedGames[0].folders[0].version, "1.0");
  assert.equal(importedGames[0].folders[0].seasonNumber, 2);
  assert.equal(importedGames[0].folders[0].seasonFinal, true);
});
