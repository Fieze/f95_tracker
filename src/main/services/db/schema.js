// Schema creation and migrations. Mixed into DatabaseService (see ../db.js).


module.exports = {
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

      CREATE TABLE IF NOT EXISTS game_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL,
        version TEXT NOT NULL,
        previous_version TEXT,
        changelog TEXT,
        detected_at TEXT NOT NULL,
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
    this.ensureColumn("games", "data_source", "TEXT DEFAULT 'scraper'");
    this.ensureColumn("games", "api_last_promoted", "INTEGER");
    this.ensureColumn("games", "api_detail_checked_at", "TEXT");
    this.ensureColumn("games", "thread_updated", "TEXT");
    this.ensureColumn("games", "os", "TEXT");
    this.ensureColumn("games", "language", "TEXT");
    this.ensureColumn("games", "censored", "TEXT");
    this.ensureColumn("games", "developer_links", "TEXT DEFAULT '[]'");
    this.ensureColumn("games", "rating", "REAL");
    this.ensureColumn("games", "rating_count", "INTEGER");
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
    this.ensureColumn("game_folders", "branch", "TEXT");
    this.ensureColumn("games", "branch_overrides", "TEXT DEFAULT '{}'");
    this.ensureColumn("download_links", "branch", "TEXT");
    this.ensureColumn("download_links", "variant", "TEXT");
    this.ensureColumn("download_links", "platform", "TEXT");
    this.ensureColumn("download_links", "branch_version", "TEXT");
    this.ensureColumn("archive_jobs", "branch", "TEXT");
    this.ensureColumn("game_folders", "preferred_exe_path", "TEXT");
    this.ensureColumn("game_folders", "sort_rank", "INTEGER");
    this.backfillThreadIds();
    this.mergeDuplicateGamesByThreadId();
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_games_thread_id ON games(thread_id) WHERE thread_id IS NOT NULL");
  },

  ensureColumn(tableName, columnName, definition) {
    const columns = this.query(`PRAGMA table_info(${tableName})`);
    if (!columns.some((column) => column.name === columnName)) {
      this.db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }
};
