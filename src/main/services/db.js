const fs = require("fs/promises");
const path = require("path");
const initSqlJs = require("sql.js");
const { deriveInstalledStateFromFolders, safeJsonParse, versionLabel } = require("./utils");

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
        thread_url TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        thread_title TEXT,
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(game_id, folder_path),
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
      );
    `);
    this.ensureColumn("games", "parser_debug", "TEXT DEFAULT '{}'");
    this.ensureColumn("games", "thread_title", "TEXT");
    this.ensureColumn("games", "release_date", "TEXT");
    this.ensureColumn("games", "banner_image_path", "TEXT");
    this.ensureColumn("games", "screenshot_images", "TEXT DEFAULT '[]'");
    this.ensureColumn("games", "thread_status", "TEXT");
    this.ensureColumn("games", "install_path", "TEXT");
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
    const existing = this.first("SELECT id, aliases FROM games WHERE thread_url = ?", [parsedThread.sourceUrl]);
    const aliasSet = new Set([
      ...(existing ? safeJsonParse(existing.aliases, []) : []),
      parsedThread.title,
      parsedThread.threadTitle
    ]);

    const stmt = this.db.prepare(`
      INSERT INTO games (
        id, thread_url, title, thread_title, current_version, developer, engine, thread_status, overview, release_date, changelog,
        banner_image_path, screenshot_images, tags,
        aliases, raw_op_html, raw_op_text, parser_debug, parser_warnings, last_sync_at, last_sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_url) DO UPDATE SET
        title = excluded.title,
        thread_title = excluded.thread_title,
        current_version = excluded.current_version,
        developer = excluded.developer,
        engine = excluded.engine,
        thread_status = excluded.thread_status,
        overview = excluded.overview,
        release_date = excluded.release_date,
        changelog = excluded.changelog,
        banner_image_path = excluded.banner_image_path,
        screenshot_images = excluded.screenshot_images,
        tags = excluded.tags,
        aliases = excluded.aliases,
        raw_op_html = excluded.raw_op_html,
        raw_op_text = excluded.raw_op_text,
        parser_debug = excluded.parser_debug,
        parser_warnings = excluded.parser_warnings,
        last_sync_at = excluded.last_sync_at,
        last_sync_status = excluded.last_sync_status
    `);

    stmt.run([
      existing ? existing.id : null,
      parsedThread.sourceUrl,
      parsedThread.title,
      parsedThread.threadTitle,
      parsedThread.currentVersion,
      parsedThread.developer,
      parsedThread.engine,
      parsedThread.threadStatus,
      parsedThread.overview,
      parsedThread.releaseDate,
      parsedThread.changelog,
      parsedThread.bannerImage?.localPath || null,
      JSON.stringify(parsedThread.screenshotImages || []),
      JSON.stringify(parsedThread.tags),
      JSON.stringify([...aliasSet]),
      parsedThread.rawOpHtml,
      parsedThread.rawOpText,
      JSON.stringify(parsedThread.parserDebug || {}),
      JSON.stringify(parsedThread.warnings),
      new Date().toISOString(),
      "success"
    ]);
    stmt.free();

    const game = this.first("SELECT * FROM games WHERE thread_url = ?", [parsedThread.sourceUrl]);
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

  insertSyncRun(gameId, success, warnings, errorText) {
    this.db.run(
      "INSERT INTO sync_runs (game_id, success, warnings, error_text, created_at) VALUES (?, ?, ?, ?, ?)",
      [gameId, success ? 1 : 0, JSON.stringify(warnings || []), errorText, new Date().toISOString()]
    );
  }

  getGames() {
    const rows = this.query("SELECT * FROM games ORDER BY title COLLATE NOCASE ASC");
    const links = this.query("SELECT * FROM download_links ORDER BY group_label, label");
    const folders = this.query("SELECT * FROM game_folders ORDER BY updated_at DESC, folder_name COLLATE NOCASE ASC");
    const linksByGame = this.groupRowsByKey(links, "game_id");
    const foldersByGame = this.groupRowsByKey(folders, "game_id");

    return rows.map((row) => this.hydrateGame(row, linksByGame[row.id] || [], foldersByGame[row.id] || []));
  }

  getGameById(gameId) {
    const row = this.first("SELECT * FROM games WHERE id = ?", [gameId]);
    if (!row) return null;
    const links = this.query("SELECT * FROM download_links WHERE game_id = ? ORDER BY group_label, label", [gameId]);
    const folders = this.query(
      "SELECT * FROM game_folders WHERE game_id = ? ORDER BY updated_at DESC, folder_name COLLATE NOCASE ASC",
      [gameId]
    );
    return this.hydrateGame(row, links, folders);
  }

  listGameFolders(gameId) {
    return this.query(
      "SELECT * FROM game_folders WHERE game_id = ? ORDER BY updated_at DESC, folder_name COLLATE NOCASE ASC",
      [gameId]
    ).map((row) => this.hydrateFolder(row));
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

    if (existing) {
      this.db.run(
        `UPDATE game_folders SET
          folder_name = ?, folder_path = ?, version = ?, version_source = ?, updated_at = ?
        WHERE id = ?`,
        [
          folder.folderName,
          folder.folderPath,
          folder.version ?? null,
          versionSource,
          now,
          existing.id
        ]
      );
    } else {
      this.db.run(
        `INSERT INTO game_folders (
          game_id, folder_name, folder_path, version, version_source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          gameId,
          folder.folderName,
          folder.folderPath,
          folder.version ?? null,
          versionSource,
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
    return this.listGameFolders(gameId);
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
    await this.persist();
    return this.first("SELECT * FROM archive_jobs WHERE id = last_insert_rowid()");
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
