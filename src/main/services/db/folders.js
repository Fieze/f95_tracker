// Installed game folders. Mixed into DatabaseService (see ../db.js).
const { deriveInstalledStateFromFolders, rankGameFolders } = require("../utils");

module.exports = {
  listGameFolders(gameId) {
    return this.query("SELECT * FROM game_folders WHERE game_id = ? ORDER BY sort_rank ASC, id ASC", [gameId]).map((row) =>
      this.hydrateFolder(row)
    );
  },

  getGameFolder(folderId) {
    const row = this.first("SELECT * FROM game_folders WHERE id = ?", [folderId]);
    return row ? this.hydrateFolder(row) : null;
  },

  findGameFolderByPath(gameId, folderPath) {
    const row = this.first("SELECT * FROM game_folders WHERE game_id = ? AND folder_path = ?", [
      gameId,
      folderPath
    ]);
    return row ? this.hydrateFolder(row) : null;
  },

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
  },

  async updateGameFolderVersion(folderId, version, versionSource = "manual") {
    this.db.run(
      "UPDATE game_folders SET version = ?, version_source = ?, updated_at = ? WHERE id = ?",
      [version ?? null, versionSource, new Date().toISOString(), folderId]
    );
    await this.persist();
    return this.getGameFolder(folderId);
  },

  async updateGameFolderSortRanks(gameId, rankedFolders) {
    const stmt = this.db.prepare("UPDATE game_folders SET sort_rank = ?, updated_at = ? WHERE id = ?");
    const updatedAt = new Date().toISOString();
    for (const folder of rankedFolders || []) {
      stmt.run([folder.sortRank ?? null, updatedAt, folder.id]);
    }
    stmt.free();
    await this.persist();
    return this.listGameFolders(gameId);
  },

  async recalculateGameFolderRanks(gameId, options = {}) {
    const game = options.game || this.getGameById(gameId);
    if (!game) {
      return [];
    }

    const folders = options.folders || this.listGameFolders(gameId);
    const rankedFolders = rankGameFolders(folders, { hasSeasons: game.hasSeasons });
    return this.updateGameFolderSortRanks(game.id, rankedFolders);
  },

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
  },

  async deleteGameFolder(folderId) {
    this.db.run("DELETE FROM game_folders WHERE id = ?", [folderId]);
    await this.persist();
  },

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
  },

  async applyDerivedInstallState(gameId, folders, fallback = {}) {
    const derived = deriveInstalledStateFromFolders(folders, fallback);
    this.db.run("UPDATE games SET installed_version = ?, install_path = ? WHERE id = ?", [
      derived.installedVersion,
      derived.installPath,
      gameId
    ]);
    await this.persist();
    return this.getGameById(gameId);
  },

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
};
