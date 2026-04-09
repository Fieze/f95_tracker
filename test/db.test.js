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

test("upsertGameFromThread deduplicates entries with the same thread id but different slug", async (t) => {
  const { db, tempDir } = await createDb();
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const first = await db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/example-game-v1-dev.12345/",
    title: "Example Game",
    threadTitle: "Example Game [v1]",
    currentVersion: "1.0",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "Overview",
    releaseDate: "2026-04-03",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    downloadGroups: [
      {
        label: "Downloads",
        links: [{ label: "Mega", url: "https://example.com/v1" }]
      }
    ],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    warnings: []
  });

  const second = await db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/example-game-reboot-dev.12345/",
    title: "Example Game",
    threadTitle: "Example Game [v2]",
    currentVersion: "2.0",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "Updated overview",
    releaseDate: "2026-04-04",
    changelog: "Changes",
    bannerImage: null,
    screenshotImages: [],
    tags: ["tag-a"],
    downloadGroups: [
      {
        label: "Downloads",
        links: [{ label: "Gofile", url: "https://example.com/v2" }]
      }
    ],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    warnings: []
  });

  const games = db.getGames();
  assert.equal(games.length, 1);
  assert.equal(first.id, second.id);
  assert.equal(games[0].threadUrl, "https://f95zone.to/threads/example-game-reboot-dev.12345/");
  assert.equal(games[0].currentVersion, "2.0");
  assert.equal(games[0].downloadGroups[0].links[0].label, "Gofile");
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

test("importSnapshot merges duplicate games that share a thread id", async (t) => {
  const { db, tempDir } = await createDb();
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const snapshot = {
    format: "f95-app-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    tables: {
      settings: [],
      games: [
        {
          id: 1,
          thread_url: "https://f95zone.to/threads/example-game-v1-dev.12345/",
          title: "Example Game",
          thread_title: "Example Game [v1]",
          has_seasons: 1,
          current_version: "1.0",
          installed_version: "1.0",
          install_path: "D:\\Games\\Example Game\\v1",
          developer: "Dev",
          engine: "Ren'Py",
          thread_status: "Ongoing",
          overview: "Old overview",
          release_date: "2026-04-03",
          changelog: "",
          banner_image_path: null,
          screenshot_images: "[]",
          tags: "[]",
          aliases: "[\"Example Game [v1]\"]",
          raw_op_html: "",
          raw_op_text: "",
          parser_debug: "{}",
          parser_warnings: "[]",
          last_sync_at: "2026-04-08T10:00:00.000Z",
          last_sync_status: "failed"
        },
        {
          id: 2,
          thread_url: "https://f95zone.to/threads/example-game-reboot-dev.12345/",
          title: "Example Game",
          thread_title: "Example Game [v2]",
          has_seasons: 0,
          current_version: "2.0",
          installed_version: null,
          install_path: "D:\\Games\\Example Game\\v1",
          developer: "Dev",
          engine: "Ren'Py",
          thread_status: "Ongoing",
          overview: "New overview",
          release_date: "2026-04-04",
          changelog: "Changes",
          banner_image_path: null,
          screenshot_images: "[]",
          tags: "[\"tag-a\"]",
          aliases: "[\"Example Game [v2]\"]",
          raw_op_html: "",
          raw_op_text: "",
          parser_debug: "{}",
          parser_warnings: "[]",
          last_sync_at: "2026-04-09T10:00:00.000Z",
          last_sync_status: "success"
        }
      ],
      download_links: [
        {
          id: 1,
          game_id: 1,
          group_label: "Downloads",
          label: "Mega",
          url: "https://example.com/v1",
          last_seen_at: "2026-04-08T10:00:00.000Z"
        },
        {
          id: 2,
          game_id: 2,
          group_label: "Downloads",
          label: "Gofile",
          url: "https://example.com/v2",
          last_seen_at: "2026-04-09T10:00:00.000Z"
        }
      ],
      archive_jobs: [],
      sync_runs: [
        {
          id: 1,
          game_id: 1,
          success: 0,
          warnings: "[]",
          error_text: "fetch failed",
          created_at: "2026-04-08T10:00:00.000Z"
        },
        {
          id: 2,
          game_id: 2,
          success: 1,
          warnings: "[]",
          error_text: null,
          created_at: "2026-04-09T10:00:00.000Z"
        }
      ],
      game_folders: [
        {
          id: 1,
          game_id: 1,
          folder_name: "Example Game-v1",
          folder_path: "D:\\Games\\Example Game\\v1",
          version: "1.0",
          version_source: "manual",
          season_number: 1,
          season_final: 1,
          preferred_exe_path: null,
          sort_rank: 1,
          created_at: "2026-04-08T10:00:00.000Z",
          updated_at: "2026-04-08T10:00:00.000Z"
        },
        {
          id: 2,
          game_id: 2,
          folder_name: "Example Game-v1",
          folder_path: "D:\\Games\\Example Game\\v1",
          version: "1.0",
          version_source: "inferred",
          season_number: null,
          season_final: 0,
          preferred_exe_path: null,
          sort_rank: 1,
          created_at: "2026-04-09T10:00:00.000Z",
          updated_at: "2026-04-09T10:00:00.000Z"
        }
      ]
    }
  };

  await db.importSnapshot(snapshot);

  const games = db.getGames();
  assert.equal(games.length, 1);
  assert.equal(games[0].threadUrl, "https://f95zone.to/threads/example-game-reboot-dev.12345/");
  assert.equal(games[0].currentVersion, "2.0");
  assert.equal(games[0].hasSeasons, true);
  assert.equal(games[0].installPath, "D:\\Games\\Example Game\\v1");
  assert.equal(games[0].downloadGroups[0].links[0].label, "Gofile");
  assert.equal(games[0].folders.length, 1);
  assert.equal(games[0].folders[0].versionSource, "manual");
  assert.equal(games[0].folders[0].seasonNumber, 1);
  assert.equal(db.query("SELECT COUNT(*) AS count FROM sync_runs")[0].count, 2);
});
