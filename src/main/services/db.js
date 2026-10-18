const fs = require("fs/promises");
const path = require("path");
const initSqlJs = require("sql.js");
const { atomicWrite } = require("./safeFiles");

class DatabaseService {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.dbPath = path.join(userDataPath, "f95-app.sqlite");
    this.sql = null;
    this.db = null;
    this.writeQueue = Promise.resolve();
    this.pendingWriteError = null;
    this.queuedPersist = null;
  }

  async initialize() {
    await fs.mkdir(this.userDataPath, { recursive: true });
    this.sql = await initSqlJs({
      locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm")
    });

    let buffer = null;
    try {
      buffer = await fs.readFile(this.dbPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      buffer = null;
    }

    this.db = buffer ? new this.sql.Database(buffer) : new this.sql.Database();
    const integrity = this.query("PRAGMA quick_check");
    if (integrity.some((row) => row.quick_check !== "ok")) throw new Error("Database integrity check failed.");
    if (buffer) {
      if (!this.query("PRAGMA table_info(games)").some((column) => column.name === "data_source")) {
        const apiBackup = path.join(this.userDataPath, "backups", "pre-api-upgrade.sqlite");
        try { await fs.access(apiBackup); } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await fs.mkdir(path.dirname(apiBackup), { recursive: true });
          await atomicWrite(apiBackup, buffer);
        }
      }
      const upgradeBackup = path.join(this.userDataPath, "backups", "pre-safety-upgrade.sqlite");
      try { await fs.access(upgradeBackup); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        await fs.mkdir(path.dirname(upgradeBackup), { recursive: true });
        await atomicWrite(upgradeBackup, buffer);
      }
    }
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

  // Bursts of persist() calls that arrive while a write is still queued share one export + write.
  // The snapshot is taken when the write starts, so it always includes every change made before the call.
  persist() {
    if (this.queuedPersist) return this.queuedPersist;
    const queued = this.enqueueWrite(() => {
      this.queuedPersist = null;
      const data = Buffer.from(this.db.export());
      return atomicWrite(this.dbPath, data);
    });
    this.queuedPersist = queued;
    return queued;
  }

  enqueueWrite(operation) {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(() => { this.pendingWriteError = null; }, (error) => {
      this.pendingWriteError = error;
    });
    return result;
  }

  async flush() {
    await this.writeQueue;
    if (this.pendingWriteError) throw this.pendingWriteError;
  }

  getSettings() {
    const rows = this.query("SELECT key, value FROM settings");
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      watchFolder: settings.watch_folder || "",
      installRoot: settings.install_root || "",
      syncIntervalMinutes: Number(settings.sync_interval_minutes || 30),
      keepArchives: settings.keep_archives === "1",
      extraDownloadHosts: settings.extra_download_hosts || ""
    };
  }

  async saveSettings(input) {
    const current = this.getSettings();
    const settings = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) };
    const map = {
      watch_folder: settings.watchFolder || "",
      install_root: settings.installRoot || "",
      sync_interval_minutes: String(settings.syncIntervalMinutes || 30),
      keep_archives: settings.keepArchives ? "1" : "0",
      extra_download_hosts: String(settings.extraDownloadHosts || "")
    };

    const stmt = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    Object.entries(map).forEach(([key, value]) => stmt.run([key, value]));
    stmt.free();
    await this.persist();
    return this.getSettings();
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

for (const mixin of ["schema", "games", "folders", "archiveJobs", "snapshot"]) {
  Object.assign(DatabaseService.prototype, require(`./db/${mixin}`));
}

module.exports = {
  DatabaseService
};
