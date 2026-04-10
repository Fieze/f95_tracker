const fs = require("fs/promises");
const path = require("path");
const initSqlJs = require("sql.js");
const {
  deriveInstalledStateFromFolders,
  extractThreadId,
  rankGameFolders,
  safeJsonParse,
  versionLabel
} = require("./utils");

class DatabaseService {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.dbPath = path.join(userDataPath, "f95-app.sqlite");
    this.sql = null;
    this.db = null;
  }

  async initialize() {
    await fs.mkdir(this.userDataPath, { recursive: true });
    this.sql = await initSqlJs({
      locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm")
    });

    let buffer = null;
    try {
      buffer = await fs.readFile(this.dbPath);
    } catch {
      buffer = null;
    }

    this.db = buffer ? new this.sql.Database(buffer) : new this.sql.Database();
    this.migrate();
    await this.persist();
  }

  async resetInterruptedArchiveJobs() {
    this.db.run(
      "UPDATE archive_jobs SET status = 'queued', error_text = ?, updated_at = ? WHERE status = 'processing'",
      ["Extraction was reset after app restart.", new Date().toISOString()]
    );
    await this.persist();
  }

  migrate() {
    this.db.run("PRAGMA foreign_keys = ON;");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT,
        thread_url TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        thread_title TEXT,
        has_seasons INTEGER NOT NULL DEFAULT 0,
        current_version TEXT,
        installed_version TEXT,
        install_path TEXT,
        developer TEXT,
        engine TEXT,
        thread_status TEXT,
        overview TEXT,
        release_date TEXT,
        changelog TEXT,
        banner_image_path TEXT,
        screenshot_images TEXT DEFAULT '[]',
        tags TEXT DEFAULT '[]',
        aliases TEXT DEFAULT '[]',
        raw_op_html TEXT,
        raw_op_text TEXT,
        parser_debug TEXT DEFAULT '{}',
        parser_warnings TEXT DEFAULT '[]',
        last_sync_at TEXT,
        last_sync_status TEXT DEFAULT 'never'
      );

      CREATE TABLE IF NOT EXISTS download_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL,
        group_label TEXT,
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS archive_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_path TEXT NOT NULL,
        archive_name TEXT NOT NULL,
        archive_hash TEXT,
        game_id INTEGER,
        detected_version TEXT,
        status TEXT NOT NULL,
        confidence TEXT,
        match_candidates TEXT DEFAULT '[]',
        error_text TEXT,
        extracted_to TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(archive_path, archive_name)
      );

      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL,
        success INTEGER NOT NULL,
        warnings TEXT DEFAULT '[]',
        error_text TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS game_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL,
        folder_name TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        version TEXT,
        version_source TEXT NOT NULL DEFAULT 'inferred',
        season_number INTEGER,
        season_final INTEGER NOT NULL DEFAULT 0,
        preferred_exe_path TEXT,
        sort_rank INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(game_id, folder_path),
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
      );
    `);
    this.ensureColumn("games", "parser_debug", "TEXT DEFAULT '{}'");
    this.ensureColumn("games", "thread_id", "TEXT");
    this.ensureColumn("games", "thread_title", "TEXT");
    this.ensureColumn("games", "release_date", "TEXT");
    this.ensureColumn("games", "banner_image_url", "TEXT");
    this.ensureColumn("games", "banner_image_path", "TEXT");
    this.ensureColumn("games", "screenshot_images", "TEXT DEFAULT '[]'");
    this.ensureColumn("games", "thread_status", "TEXT");
    this.ensureColumn("games", "install_path", "TEXT");
    this.ensureColumn("games", "has_seasons", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("game_folders", "season_number", "INTEGER");
    this.ensureColumn("game_folders", "season_final", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("game_folders", "preferred_exe_path", "TEXT");
    this.ensureColumn("game_folders", "sort_rank", "INTEGER");
    this.backfillThreadIds();
    this.mergeDuplicateGamesByThreadId();
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_games_thread_id ON games(thread_id) WHERE thread_id IS NOT NULL");
  }

  ensureColumn(tableName, columnName, definition) {
    const columns = this.query(`PRAGMA table_info(${tableName})`);
    if (!columns.some((column) => column.name === columnName)) {
      this.db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  persist() {
    const data = this.db.export();
    return fs.writeFile(this.dbPath, Buffer.from(data));
  }

  getSettings() {
    const rows = this.query("SELECT key, value FROM settings");
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      watchFolder: settings.watch_folder || "",
      installRoot: settings.install_root || "",
      syncIntervalMinutes: Number(settings.sync_interval_minutes || 30)
    };
  }

  async saveSettings(settings) {
    const map = {
      watch_folder: settings.watchFolder || "",
      install_root: settings.installRoot || "",
      sync_interval_minutes: String(settings.syncIntervalMinutes || 30)
    };

    const stmt = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    Object.entries(map).forEach(([key, value]) => stmt.run([key, value]));
    stmt.free();
    await this.persist();
    return this.getSettings();
  }

  async upsertGameFromThread(parsedThread) {
    const threadId = parsedThread.threadId || extractThreadId(parsedThread.sourceUrl);
    const existing = this.first(
      "SELECT id, aliases, has_seasons, installed_version, install_path FROM games WHERE thread_id = ? OR thread_url = ? ORDER BY id ASC LIMIT 1",
      [threadId, parsedThread.sourceUrl]
    );
    const aliasSet = new Set([
      ...(existing ? safeJsonParse(existing.aliases, []) : []),
      parsedThread.title,
      parsedThread.threadTitle
    ]);
    const now = new Date().toISOString();

    if (existing) {
      this.db.run(
        `UPDATE games SET
          thread_id = ?, thread_url = ?, title = ?, thread_title = ?, has_seasons = ?, current_version = ?, developer = ?, engine = ?,
          thread_status = ?, overview = ?, release_date = ?, changelog = ?, banner_image_url = ?, banner_image_path = ?, screenshot_images = ?, tags = ?,
          aliases = ?, raw_op_html = ?, raw_op_text = ?, parser_debug = ?, parser_warnings = ?, last_sync_at = ?, last_sync_status = ?
        WHERE id = ?`,
        [
          threadId,
          parsedThread.sourceUrl,
          parsedThread.title,
          parsedThread.threadTitle,
          existing.has_seasons ? 1 : parsedThread.hasSeasons ? 1 : 0,
          parsedThread.currentVersion,
          parsedThread.developer,
          parsedThread.engine,
          parsedThread.threadStatus,
          parsedThread.overview,
          parsedThread.releaseDate,
          parsedThread.changelog,
          parsedThread.bannerImage?.sourceUrl || null,
          parsedThread.bannerImage?.localPath || null,
          JSON.stringify(parsedThread.screenshotImages || []),
          JSON.stringify(parsedThread.tags),
          JSON.stringify([...aliasSet]),
          parsedThread.rawOpHtml,
          parsedThread.rawOpText,
          JSON.stringify(parsedThread.parserDebug || {}),
          JSON.stringify(parsedThread.warnings),
          now,
          "success",
          existing.id
        ]
      );
    } else {
      this.db.run(
        `INSERT INTO games (
          thread_id, thread_url, title, thread_title, has_seasons, current_version, developer, engine, thread_status, overview, release_date, changelog,
          banner_image_url, banner_image_path, screenshot_images, tags, aliases, raw_op_html, raw_op_text, parser_debug, parser_warnings, last_sync_at, last_sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          threadId,
          parsedThread.sourceUrl,
          parsedThread.title,
          parsedThread.threadTitle,
          parsedThread.hasSeasons ? 1 : 0,
          parsedThread.currentVersion,
          parsedThread.developer,
          parsedThread.engine,
          parsedThread.threadStatus,
          parsedThread.overview,
          parsedThread.releaseDate,
          parsedThread.changelog,
          parsedThread.bannerImage?.sourceUrl || null,
          parsedThread.bannerImage?.localPath || null,
          JSON.stringify(parsedThread.screenshotImages || []),
          JSON.stringify(parsedThread.tags),
          JSON.stringify([...aliasSet]),
          parsedThread.rawOpHtml,
          parsedThread.rawOpText,
          JSON.stringify(parsedThread.parserDebug || {}),
          JSON.stringify(parsedThread.warnings),
          now,
          "success"
        ]
      );
    }

    const game = this.first("SELECT * FROM games WHERE thread_id = ?", [threadId]);
    this.db.run("DELETE FROM download_links WHERE game_id = ?", [game.id]);

    const linkStmt = this.db.prepare(`
      INSERT INTO download_links (game_id, group_label, label, url, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    parsedThread.downloadGroups.forEach((group) => {
      group.links.forEach((link) => {
        linkStmt.run([game.id, group.label, link.label, link.url, new Date().toISOString()]);
      });
    });
    linkStmt.free();

    this.insertSyncRun(game.id, true, parsedThread.warnings, null);
    await this.persist();
    return this.getGameById(game.id);
  }

  async markSyncFailure(gameId, errorMessage) {
    this.db.run(
      "UPDATE games SET last_sync_at = ?, last_sync_status = 'failed' WHERE id = ?",
      [new Date().toISOString(), gameId]
    );
    this.insertSyncRun(gameId, false, [], errorMessage);
    await this.persist();
  }

  async markSyncSuccess(gameId, warnings = []) {
    const now = new Date().toISOString();
    this.db.run(
      "UPDATE games SET last_sync_at = ?, last_sync_status = 'success', parser_warnings = ? WHERE id = ?",
      [now, JSON.stringify(warnings || []), gameId]
    );
    this.insertSyncRun(gameId, true, warnings, null);
    await this.persist();
    return this.getGameById(gameId);
  }

  insertSyncRun(gameId, success, warnings, errorText) {
    this.db.run(
      "INSERT INTO sync_runs (game_id, success, warnings, error_text, created_at) VALUES (?, ?, ?, ?, ?)",
      [gameId, success ? 1 : 0, JSON.stringify(warnings || []), errorText, new Date().toISOString()]
    );
  }

  getGames() {
    const rows = this.query("SELECT * FROM games ORDER BY title COLLATE NOCASE ASC");
    const links = this.query("SELECT * FROM download_links ORDER BY group_label, label");
    const folders = this.query("SELECT * FROM game_folders ORDER BY sort_rank ASC, id ASC");
    const linksByGame = this.groupRowsByKey(links, "game_id");
    const foldersByGame = this.groupRowsByKey(folders, "game_id");

    return rows.map((row) => this.hydrateGame(row, linksByGame[row.id] || [], foldersByGame[row.id] || []));
  }

  getGameById(gameId) {
    const row = this.first("SELECT * FROM games WHERE id = ?", [gameId]);
    if (!row) return null;
    const links = this.query("SELECT * FROM download_links WHERE game_id = ? ORDER BY group_label, label", [gameId]);
    const folders = this.query("SELECT * FROM game_folders WHERE game_id = ? ORDER BY sort_rank ASC, id ASC", [gameId]);
    return this.hydrateGame(row, links, folders);
  }

  getGameRefreshMetadata(gameId) {
    const row = this.first(
      "SELECT id, thread_url, raw_op_html, raw_op_text, banner_image_url, banner_image_path, screenshot_images, parser_warnings FROM games WHERE id = ?",
      [gameId]
    );
    if (!row) {
      return null;
    }

    const links = this.query(
      "SELECT group_label, label, url FROM download_links WHERE game_id = ? ORDER BY group_label, label, url",
      [gameId]
    );
    const downloadGroups = [];
    links.forEach((link) => {
      let group = downloadGroups.find((entry) => entry.label === (link.group_label || "Downloads"));
      if (!group) {
        group = { label: link.group_label || "Downloads", links: [] };
        downloadGroups.push(group);
      }
      group.links.push({
        label: link.label || "",
        url: link.url || ""
      });
    });

    return {
      id: row.id,
      sourceUrl: row.thread_url,
      rawOpHtml: row.raw_op_html || "",
      rawOpText: row.raw_op_text || "",
      parserWarnings: safeJsonParse(row.parser_warnings, []),
      downloadGroups,
      bannerImage: row.banner_image_path
        ? {
            sourceUrl: row.banner_image_url || null,
            localPath: row.banner_image_path
          }
        : null,
      screenshotImages: safeJsonParse(row.screenshot_images, [])
    };
  }

  listGameFolders(gameId) {
    return this.query("SELECT * FROM game_folders WHERE game_id = ? ORDER BY sort_rank ASC, id ASC", [gameId]).map((row) =>
      this.hydrateFolder(row)
    );
  }

  getGameFolder(folderId) {
    const row = this.first("SELECT * FROM game_folders WHERE id = ?", [folderId]);
    return row ? this.hydrateFolder(row) : null;
  }

  findGameFolderByPath(gameId, folderPath) {
    const row = this.first("SELECT * FROM game_folders WHERE game_id = ? AND folder_path = ?", [
      gameId,
      folderPath
    ]);
    return row ? this.hydrateFolder(row) : null;
  }

  async upsertGameFolder(gameId, folder, options = {}) {
    const now = new Date().toISOString();
    const existing = this.first("SELECT * FROM game_folders WHERE game_id = ? AND folder_path = ?", [gameId, folder.folderPath]);
    const versionSource = folder.versionSource || existing?.version_source || "inferred";
    const seasonNumber = folder.seasonNumber ?? existing?.season_number ?? null;
    const seasonFinal = folder.seasonFinal ?? Boolean(existing?.season_final);
    const preferredExePath = folder.preferredExePath ?? existing?.preferred_exe_path ?? null;
    const sortRank = folder.sortRank ?? existing?.sort_rank ?? null;

    if (existing) {
      this.db.run(
        `UPDATE game_folders SET
          folder_name = ?, folder_path = ?, version = ?, version_source = ?, season_number = ?, season_final = ?, preferred_exe_path = ?, sort_rank = ?, updated_at = ?
        WHERE id = ?`,
        [
          folder.folderName,
          folder.folderPath,
          folder.version ?? null,
          versionSource,
          seasonNumber,
          seasonFinal ? 1 : 0,
          preferredExePath,
          sortRank,
          now,
          existing.id
        ]
      );
    } else {
      this.db.run(
        `INSERT INTO game_folders (
          game_id, folder_name, folder_path, version, version_source, season_number, season_final, preferred_exe_path, sort_rank, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
        [
          gameId,
          folder.folderName,
          folder.folderPath,
          folder.version ?? null,
          versionSource,
          seasonNumber,
          seasonFinal ? 1 : 0,
          preferredExePath,
          sortRank,
          now,
          now
        ]
      );
    }

    if (options.persist !== false) {
      await this.persist();
    }
    return this.listGameFolders(gameId);
  }

  async updateGameFolderVersion(folderId, version, versionSource = "manual") {
    this.db.run(
      "UPDATE game_folders SET version = ?, version_source = ?, updated_at = ? WHERE id = ?",
      [version ?? null, versionSource, new Date().toISOString(), folderId]
    );
    await this.persist();
    return this.getGameFolder(folderId);
  }

  async updateGameFolderSortRanks(gameId, rankedFolders) {
    const stmt = this.db.prepare("UPDATE game_folders SET sort_rank = ?, updated_at = ? WHERE id = ?");
    const updatedAt = new Date().toISOString();
    for (const folder of rankedFolders || []) {
      stmt.run([folder.sortRank ?? null, updatedAt, folder.id]);
    }
    stmt.free();
    await this.persist();
    return this.listGameFolders(gameId);
  }

  async recalculateGameFolderRanks(gameId, options = {}) {
    const game = options.game || this.getGameById(gameId);
    if (!game) {
      return [];
    }

    const folders = options.folders || this.listGameFolders(gameId);
    const rankedFolders = rankGameFolders(folders, { hasSeasons: game.hasSeasons });
    return this.updateGameFolderSortRanks(game.id, rankedFolders);
  }

  async updateGameSeasons(gameId, hasSeasons) {
    this.db.run("UPDATE games SET has_seasons = ? WHERE id = ?", [hasSeasons ? 1 : 0, gameId]);
    await this.persist();
    return this.getGameById(gameId);
  }

  async updateGameFolderMetadata(folderId, updates = {}) {
    const existing = this.first("SELECT * FROM game_folders WHERE id = ?", [folderId]);
    if (!existing) {
      throw new Error("Game folder not found.");
    }

    const nextVersion = Object.prototype.hasOwnProperty.call(updates, "version")
      ? updates.version ?? null
      : existing.version;
    const nextVersionSource = updates.versionSource || existing.version_source || "manual";
    const nextSeasonNumber = Object.prototype.hasOwnProperty.call(updates, "seasonNumber")
      ? updates.seasonNumber ?? null
      : existing.season_number;
    const nextSeasonFinal = Object.prototype.hasOwnProperty.call(updates, "seasonFinal")
      ? (updates.seasonFinal ? 1 : 0)
      : existing.season_final;
    const nextPreferredExePath = Object.prototype.hasOwnProperty.call(updates, "preferredExePath")
      ? updates.preferredExePath ?? null
      : existing.preferred_exe_path;

    this.db.run(
      `UPDATE game_folders SET
        version = ?, version_source = ?, season_number = ?, season_final = ?, preferred_exe_path = ?, updated_at = ?
      WHERE id = ?`,
      [
        nextVersion,
        nextVersionSource,
        nextSeasonNumber,
        nextSeasonFinal,
        nextPreferredExePath,
        new Date().toISOString(),
        folderId
      ]
    );
    await this.persist();
    return this.getGameFolder(folderId);
  }

  async deleteGameFolder(folderId) {
    this.db.run("DELETE FROM game_folders WHERE id = ?", [folderId]);
    await this.persist();
  }

  async replaceGameFolders(gameId, folders) {
    const existingFolders = this.listGameFolders(gameId);
    const nextFolders = Array.isArray(folders) ? folders : [];
    const nextPaths = new Set(nextFolders.map((folder) => folder.folderPath));

    for (const folder of nextFolders) {
      await this.upsertGameFolder(gameId, folder, { persist: false });
    }

    for (const existing of existingFolders) {
      if (!nextPaths.has(existing.folderPath)) {
        this.db.run("DELETE FROM game_folders WHERE id = ?", [existing.id]);
      }
    }

    await this.persist();
    const refreshedFolders = this.listGameFolders(gameId);
    const missingRanks = refreshedFolders.some((folder) => !Number.isFinite(Number(folder.sortRank)));
    const changedMembership =
      existingFolders.length !== refreshedFolders.length ||
      existingFolders.some((folder) => !nextPaths.has(folder.folderPath));

    if (missingRanks || changedMembership) {
      return this.recalculateGameFolderRanks(gameId);
    }

    return refreshedFolders;
  }

  async applyDerivedInstallState(gameId, folders, fallback = {}) {
    const derived = deriveInstalledStateFromFolders(folders, fallback);
    this.db.run("UPDATE games SET installed_version = ?, install_path = ? WHERE id = ?", [
      derived.installedVersion,
      derived.installPath,
      gameId
    ]);
    await this.persist();
    return this.getGameById(gameId);
  }

  async updateInstalledVersion(gameId, installedVersion, installPath) {
    this.db.run("UPDATE games SET installed_version = ?, install_path = ? WHERE id = ?", [
      installedVersion,
      installPath ?? null,
      gameId
    ]);
    await this.persist();
    return this.getGameById(gameId);
  }

  async updateInstallPath(gameId, installPath) {
    this.db.run("UPDATE games SET install_path = ? WHERE id = ?", [installPath ?? null, gameId]);
    await this.persist();
    return this.getGameById(gameId);
  }

  async deleteArchiveJob(jobId) {
    this.db.run("DELETE FROM archive_jobs WHERE id = ?", [jobId]);
    await this.persist();
  }

  async deleteGame(gameId) {
    this.db.run("DELETE FROM download_links WHERE game_id = ?", [gameId]);
    this.db.run("DELETE FROM sync_runs WHERE game_id = ?", [gameId]);
    this.db.run("DELETE FROM archive_jobs WHERE game_id = ?", [gameId]);
    this.db.run("DELETE FROM game_folders WHERE game_id = ?", [gameId]);
    this.db.run("DELETE FROM games WHERE id = ?", [gameId]);
    await this.persist();
  }

  async appendAlias(gameId, alias) {
    const game = this.first("SELECT aliases FROM games WHERE id = ?", [gameId]);
    if (!game) return;
    const aliases = new Set(safeJsonParse(game.aliases, []));
    aliases.add(alias);
    this.db.run("UPDATE games SET aliases = ? WHERE id = ?", [JSON.stringify([...aliases]), gameId]);
    await this.persist();
  }

  exportSnapshot() {
    return {
      format: "f95-app-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      tables: {
        settings: this.query("SELECT key, value FROM settings ORDER BY key"),
        games: this.query("SELECT * FROM games ORDER BY id"),
        download_links: this.query("SELECT * FROM download_links ORDER BY id"),
        archive_jobs: this.query("SELECT * FROM archive_jobs ORDER BY id"),
        sync_runs: this.query("SELECT * FROM sync_runs ORDER BY id"),
        game_folders: this.query("SELECT * FROM game_folders ORDER BY id")
      }
    };
  }

  async importSnapshot(snapshot) {
    if (!snapshot || snapshot.format !== "f95-app-export" || !snapshot.tables) {
      throw new Error("Backup file format is invalid.");
    }

    const tableOrder = ["settings", "games", "download_links", "archive_jobs", "sync_runs", "game_folders"];
    this.db.run("PRAGMA foreign_keys = OFF;");
    try {
      this.db.run("BEGIN TRANSACTION;");
      this.db.run("DROP INDEX IF EXISTS idx_games_thread_id");
      this.db.run("DELETE FROM download_links");
      this.db.run("DELETE FROM archive_jobs");
      this.db.run("DELETE FROM sync_runs");
      this.db.run("DELETE FROM game_folders");
      this.db.run("DELETE FROM games");
      this.db.run("DELETE FROM settings");

      for (const tableName of tableOrder) {
        this.insertRows(tableName, snapshot.tables[tableName] || []);
      }

      this.backfillThreadIds();
      this.mergeDuplicateGamesByThreadId();
      this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_games_thread_id ON games(thread_id) WHERE thread_id IS NOT NULL");

      this.db.run("COMMIT;");
    } catch (error) {
      this.db.run("ROLLBACK;");
      throw error;
    } finally {
      this.db.run("PRAGMA foreign_keys = ON;");
    }

    await this.persist();
  }

  insertRows(tableName, rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return;
    }

    const columns = this.query(`PRAGMA table_info(${tableName})`).map((column) => column.name);
    const insertableColumns = columns.filter((column) => Object.prototype.hasOwnProperty.call(rows[0], column));
    if (insertableColumns.length === 0) {
      return;
    }

    const placeholders = insertableColumns.map(() => "?").join(", ");
    const stmt = this.db.prepare(
      `INSERT INTO ${tableName} (${insertableColumns.join(", ")}) VALUES (${placeholders})`
    );

    for (const row of rows) {
      stmt.run(insertableColumns.map((column) => row[column] ?? null));
    }

    stmt.free();
  }

  backfillThreadIds() {
    const rows = this.query("SELECT id, thread_url, thread_id FROM games ORDER BY id ASC");
    const stmt = this.db.prepare("UPDATE games SET thread_id = ? WHERE id = ?");
    for (const row of rows) {
      if (row.thread_id) {
        continue;
      }

      const threadId = extractThreadId(row.thread_url);
      if (threadId) {
        stmt.run([threadId, row.id]);
      }
    }
    stmt.free();
  }

  mergeDuplicateGamesByThreadId() {
    const duplicateGroups = this.query(`
      SELECT thread_id
      FROM games
      WHERE thread_id IS NOT NULL
      GROUP BY thread_id
      HAVING COUNT(*) > 1
    `);

    for (const group of duplicateGroups) {
      const rows = this.query("SELECT * FROM games WHERE thread_id = ? ORDER BY id ASC", [group.thread_id]);
      if (rows.length < 2) {
        continue;
      }

      this.mergeGameGroup(rows);
    }
  }

  mergeGameGroup(rows) {
    const keeper = rows[0];
    const winner = [...rows].sort((left, right) => this.compareIsoDates(right.last_sync_at, left.last_sync_at) || right.id - left.id)[0];
    const duplicateIds = rows.slice(1).map((row) => row.id);
    const mergedAliases = new Set();

    for (const row of rows) {
      safeJsonParse(row.aliases, []).forEach((alias) => mergedAliases.add(alias));
      if (row.title) {
        mergedAliases.add(row.title);
      }
      if (row.thread_title) {
        mergedAliases.add(row.thread_title);
      }
    }

    for (const row of rows) {
      if (row.id === keeper.id) {
        continue;
      }

      this.db.run("UPDATE games SET thread_url = ? WHERE id = ?", [`${row.thread_url}#merged-${row.id}`, row.id]);
    }

    this.db.run(
      `UPDATE games SET
        thread_id = ?, thread_url = ?, title = ?, thread_title = ?, has_seasons = ?, current_version = ?, installed_version = ?, install_path = ?,
        developer = ?, engine = ?, thread_status = ?, overview = ?, release_date = ?, changelog = ?, banner_image_path = ?,
        screenshot_images = ?, tags = ?, aliases = ?, raw_op_html = ?, raw_op_text = ?, parser_debug = ?, parser_warnings = ?, last_sync_at = ?, last_sync_status = ?
      WHERE id = ?`,
      [
        keeper.thread_id || winner.thread_id,
        winner.thread_url || keeper.thread_url,
        winner.title || keeper.title,
        winner.thread_title || keeper.thread_title,
        rows.some((row) => Boolean(row.has_seasons)) ? 1 : 0,
        winner.current_version || keeper.current_version,
        keeper.installed_version || winner.installed_version,
        keeper.install_path || winner.install_path,
        winner.developer || keeper.developer,
        winner.engine || keeper.engine,
        winner.thread_status || keeper.thread_status,
        winner.overview || keeper.overview,
        winner.release_date || keeper.release_date,
        winner.changelog || keeper.changelog,
        winner.banner_image_path || keeper.banner_image_path,
        winner.screenshot_images || keeper.screenshot_images,
        winner.tags || keeper.tags,
        JSON.stringify([...mergedAliases]),
        winner.raw_op_html || keeper.raw_op_html,
        winner.raw_op_text || keeper.raw_op_text,
        winner.parser_debug || keeper.parser_debug,
        winner.parser_warnings || keeper.parser_warnings,
        winner.last_sync_at || keeper.last_sync_at,
        winner.last_sync_status || keeper.last_sync_status,
        keeper.id
      ]
    );

    const winnerLinks = this.query(
      "SELECT group_label, label, url, last_seen_at FROM download_links WHERE game_id = ? ORDER BY id ASC",
      [winner.id]
    );
    this.db.run("DELETE FROM download_links WHERE game_id = ?", [keeper.id]);
    if (winnerLinks.length) {
      const seenLinks = new Set();
      const stmt = this.db.prepare(
        "INSERT INTO download_links (game_id, group_label, label, url, last_seen_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (const link of winnerLinks) {
        const key = JSON.stringify([link.group_label || "", link.label || "", link.url || ""]);
        if (seenLinks.has(key)) {
          continue;
        }
        seenLinks.add(key);
        stmt.run([keeper.id, link.group_label, link.label, link.url, link.last_seen_at]);
      }
      stmt.free();
    }

    for (const duplicateId of duplicateIds) {
      this.mergeFoldersIntoGame(keeper.id, duplicateId);
      this.db.run("UPDATE sync_runs SET game_id = ? WHERE game_id = ?", [keeper.id, duplicateId]);
      this.db.run("UPDATE archive_jobs SET game_id = ? WHERE game_id = ?", [keeper.id, duplicateId]);
      this.db.run("DELETE FROM download_links WHERE game_id = ?", [duplicateId]);
      this.db.run("DELETE FROM games WHERE id = ?", [duplicateId]);
    }
  }

  mergeFoldersIntoGame(targetGameId, sourceGameId) {
    const sourceFolders = this.query("SELECT * FROM game_folders WHERE game_id = ? ORDER BY id ASC", [sourceGameId]);
    for (const folder of sourceFolders) {
      const existing = this.first("SELECT * FROM game_folders WHERE game_id = ? AND folder_path = ?", [
        targetGameId,
        folder.folder_path
      ]);

      if (!existing) {
        this.db.run("UPDATE game_folders SET game_id = ? WHERE id = ?", [targetGameId, folder.id]);
        continue;
      }

      this.db.run(
        `UPDATE game_folders SET
          folder_name = ?, version = ?, version_source = ?, season_number = ?, season_final = ?, preferred_exe_path = ?, sort_rank = ?, updated_at = ?
        WHERE id = ?`,
        [
          existing.folder_name || folder.folder_name,
          existing.version || folder.version,
          existing.version_source === "manual" ? existing.version_source : folder.version_source || existing.version_source,
          existing.season_number ?? folder.season_number ?? null,
          existing.season_final || folder.season_final ? 1 : 0,
          existing.preferred_exe_path || folder.preferred_exe_path,
          existing.sort_rank ?? folder.sort_rank ?? null,
          existing.updated_at || folder.updated_at || new Date().toISOString(),
          existing.id
        ]
      );
      this.db.run("DELETE FROM game_folders WHERE id = ?", [folder.id]);
    }
  }

  compareIsoDates(left, right) {
    const leftTime = left ? Date.parse(left) : Number.NaN;
    const rightTime = right ? Date.parse(right) : Number.NaN;
    const safeLeft = Number.isNaN(leftTime) ? -Infinity : leftTime;
    const safeRight = Number.isNaN(rightTime) ? -Infinity : rightTime;
    if (safeLeft === safeRight) {
      return 0;
    }
    return safeLeft < safeRight ? -1 : 1;
  }

  hydrateGame(row, links, folders) {
    const groups = [];
    for (const link of links) {
      let group = groups.find((entry) => entry.label === (link.group_label || "Downloads"));
      if (!group) {
        group = { label: link.group_label || "Downloads", links: [] };
        groups.push(group);
      }
      group.links.push({
        id: link.id,
        label: link.label,
        url: link.url
      });
    }

    const hydratedFolders = (folders || []).map((folder) => this.hydrateFolder(folder));
    const derived = deriveInstalledStateFromFolders(hydratedFolders, {
      installPath: row.install_path || null
    });

    return {
      id: row.id,
      threadUrl: row.thread_url,
      title: row.title,
      threadTitle: row.thread_title || row.title,
      hasSeasons: Boolean(row.has_seasons),
      currentVersion: row.current_version,
      installedVersion: derived.installedVersion ?? row.installed_version,
      installPath: derived.installPath ?? row.install_path,
      primaryFolderId: derived.primaryFolderId,
      status: versionLabel(row.current_version, derived.installedVersion ?? row.installed_version),
      developer: row.developer,
      engine: row.engine,
      threadStatus: row.thread_status,
      overview: row.overview,
      releaseDate: row.release_date,
      changelog: row.changelog,
      bannerImage: row.banner_image_path
        ? {
            sourceUrl: row.banner_image_url || null,
            localPath: row.banner_image_path
          }
        : null,
      screenshotImages: safeJsonParse(row.screenshot_images, []),
      tags: safeJsonParse(row.tags, []),
      aliases: safeJsonParse(row.aliases, []),
      parserDebug: safeJsonParse(row.parser_debug, {}),
      parserWarnings: safeJsonParse(row.parser_warnings, []),
      downloadGroups: groups,
      folders: hydratedFolders,
      lastSyncAt: row.last_sync_at,
      lastSyncStatus: row.last_sync_status
    };
  }

  hydrateFolder(row) {
    return {
      id: row.id,
      gameId: row.game_id,
      folderName: row.folder_name,
      folderPath: row.folder_path,
      version: row.version,
      versionSource: row.version_source || "inferred",
      seasonNumber: row.season_number ?? null,
      seasonFinal: Boolean(row.season_final),
      preferredExePath: row.preferred_exe_path || null,
      sortRank: row.sort_rank ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listArchiveJobs() {
    return this.query("SELECT * FROM archive_jobs ORDER BY created_at DESC").map((row) => ({
      id: row.id,
      archivePath: row.archive_path,
      archiveName: row.archive_name,
      gameId: row.game_id,
      detectedVersion: row.detected_version,
      status: row.status,
      confidence: row.confidence,
      matchCandidates: safeJsonParse(row.match_candidates, []),
      errorText: row.error_text,
      extractedTo: row.extracted_to,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  findArchiveJobByPath(archivePath, archiveName) {
    return this.first("SELECT * FROM archive_jobs WHERE archive_path = ? AND archive_name = ?", [
      archivePath,
      archiveName
    ]);
  }

  async createArchiveJob(payload) {
    this.db.run(
      `INSERT INTO archive_jobs (
        archive_path, archive_name, archive_hash, game_id, detected_version,
        status, confidence, match_candidates, error_text, extracted_to, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.archivePath,
        payload.archiveName,
        payload.archiveHash || null,
        payload.gameId || null,
        payload.detectedVersion || null,
        payload.status,
        payload.confidence || null,
        JSON.stringify(payload.matchCandidates || []),
        payload.errorText || null,
        payload.extractedTo || null,
        new Date().toISOString(),
        new Date().toISOString()
      ]
    );
    const insertedId = this.first("SELECT last_insert_rowid() AS id")?.id || null;
    await this.persist();
    return insertedId ? this.first("SELECT * FROM archive_jobs WHERE id = ?", [insertedId]) : null;
  }

  async updateArchiveJob(jobId, updates) {
    const existing = this.first("SELECT * FROM archive_jobs WHERE id = ?", [jobId]);
    if (!existing) {
      throw new Error("Archive job not found.");
    }

    const next = {
      archive_path: updates.archivePath ?? existing.archive_path,
      archive_name: updates.archiveName ?? existing.archive_name,
      archive_hash: updates.archiveHash ?? existing.archive_hash,
      game_id: updates.gameId ?? existing.game_id,
      detected_version: updates.detectedVersion ?? existing.detected_version,
      status: updates.status ?? existing.status,
      confidence: updates.confidence ?? existing.confidence,
      match_candidates: JSON.stringify(updates.matchCandidates ?? safeJsonParse(existing.match_candidates, [])),
      error_text: updates.errorText ?? existing.error_text,
      extracted_to: updates.extractedTo ?? existing.extracted_to,
      updated_at: new Date().toISOString()
    };

    this.db.run(
      `UPDATE archive_jobs SET
        archive_path = ?, archive_name = ?, archive_hash = ?, game_id = ?, detected_version = ?, status = ?,
        confidence = ?, match_candidates = ?, error_text = ?, extracted_to = ?, updated_at = ?
      WHERE id = ?`,
      [
        next.archive_path,
        next.archive_name,
        next.archive_hash,
        next.game_id,
        next.detected_version,
        next.status,
        next.confidence,
        next.match_candidates,
        next.error_text,
        next.extracted_to,
        next.updated_at,
        jobId
      ]
    );
    await this.persist();
    return this.first("SELECT * FROM archive_jobs WHERE id = ?", [jobId]);
  }

  groupRowsByKey(rows, key) {
    return rows.reduce((accumulator, row) => {
      if (!accumulator[row[key]]) {
        accumulator[row[key]] = [];
      }
      accumulator[row[key]].push(row);
      return accumulator;
    }, {});
  }

  query(sql, params = []) {
    const statement = this.db.prepare(sql, params);
    const rows = [];
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
    statement.free();
    return rows;
  }

  first(sql, params = []) {
    return this.query(sql, params)[0] || null;
  }
}

module.exports = {
  DatabaseService
};
