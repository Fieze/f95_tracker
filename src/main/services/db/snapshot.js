// Export/import snapshots and duplicate merging. Mixed into DatabaseService (see ../db.js).
const { atomicWrite } = require("../safeFiles");
const { extractThreadId, safeJsonParse } = require("../utils");

module.exports = {
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
        game_history: this.query("SELECT * FROM game_history ORDER BY id"),
        game_folders: this.query("SELECT * FROM game_folders ORDER BY id")
      }
    };
  },

  prepareSnapshot(snapshot) {
    if (!snapshot || snapshot.format !== "f95-app-export" || snapshot.version !== 1 || !snapshot.tables ||
        typeof snapshot.tables !== "object" || Array.isArray(snapshot.tables)) {
      throw new Error("Backup file format is invalid.");
    }

    const candidate = new this.constructor(this.userDataPath);
    candidate.sql = this.sql;
    candidate.db = new this.sql.Database();
    try {
      candidate.migrate();
      for (const table of ["settings", "games", "download_links", "archive_jobs", "sync_runs", "game_folders", "game_history"]) {
        // game_history was added later; exports from older versions simply do not contain it.
        const rows = table === "game_history" ? snapshot.tables[table] ?? [] : snapshot.tables[table];
        if (!Array.isArray(rows)) throw new Error(`Invalid backup table: ${table}`);
        const columns = new Set(candidate.query(`PRAGMA table_info(${table})`).map((row) => row.name));
        for (const row of rows) {
          if (!row || typeof row !== "object" || Array.isArray(row) ||
              Object.keys(row).some((column) => !columns.has(column))) throw new Error(`Invalid backup row: ${table}`);
          if (table !== "settings" && !Number.isInteger(row.id)) throw new Error(`Invalid backup id: ${table}`);
          if (table === "settings" && (typeof row.key !== "string" || typeof row.value !== "string")) {
            throw new Error("Invalid backup settings.");
          }
        }
      }
      candidate.loadSnapshot(snapshot);
      if (candidate.query("PRAGMA foreign_key_check").length) throw new Error("Backup contains broken references.");
      if (candidate.query("SELECT id FROM archive_jobs WHERE game_id IS NOT NULL AND game_id NOT IN (SELECT id FROM games)").length) {
        throw new Error("Backup contains broken archive references.");
      }
      return candidate;
    } catch (error) {
      candidate.db.close();
      throw error;
    }
  },

  async commitPreparedSnapshot(candidate) {
    const data = Buffer.from(candidate.db.export());
    await this.enqueueWrite(() => atomicWrite(this.dbPath, data));
    const previous = this.db;
    this.db = candidate.db;
    candidate.db = null;
    previous.close();
  },

  async importSnapshot(snapshot) {
    const candidate = this.prepareSnapshot(snapshot);
    try { await this.commitPreparedSnapshot(candidate); }
    finally { candidate.db?.close(); }
  },

  loadSnapshot(snapshot) {

    const tableOrder = ["settings", "games", "download_links", "archive_jobs", "sync_runs", "game_folders", "game_history"];
    this.db.run("PRAGMA foreign_keys = OFF;");
    try {
      this.db.run("BEGIN TRANSACTION;");
      this.db.run("DROP INDEX IF EXISTS idx_games_thread_id");
      this.db.run("DELETE FROM download_links");
      this.db.run("DELETE FROM archive_jobs");
      this.db.run("DELETE FROM sync_runs");
      this.db.run("DELETE FROM game_history");
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

  },

  insertRows(tableName, rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return;
    }

    const columns = this.query(`PRAGMA table_info(${tableName})`).map((column) => column.name);
    const insertableColumns = columns.filter((column) => rows.some((row) => Object.prototype.hasOwnProperty.call(row, column)));
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
  },

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
  },

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
  },

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
      this.db.run("UPDATE game_history SET game_id = ? WHERE game_id = ?", [keeper.id, duplicateId]);
      this.db.run("UPDATE archive_jobs SET game_id = ? WHERE game_id = ?", [keeper.id, duplicateId]);
      this.db.run("DELETE FROM download_links WHERE game_id = ?", [duplicateId]);
      this.db.run("DELETE FROM games WHERE id = ?", [duplicateId]);
    }
  },

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
};
