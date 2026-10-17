// Game rows, sync bookkeeping and hydration. Mixed into DatabaseService (see ../db.js).
const { deriveInstalledStateFromFolders, extractThreadId, safeJsonParse, versionLabel } = require("../utils");

module.exports = {
  async upsertGameFromThread(parsedThread) {
    parsedThread = { ...parsedThread };
    const threadId = parsedThread.threadId || extractThreadId(parsedThread.sourceUrl);
    const existing = this.first(
      "SELECT id, aliases, has_seasons, installed_version, install_path, current_version FROM games WHERE thread_id = ? OR thread_url = ? ORDER BY id ASC LIMIT 1",
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
    this.db.run(
      `UPDATE games SET thread_updated = ?, os = ?, language = ?, censored = ?, developer_links = ?, rating = ?, rating_count = ?
       WHERE id = ?`,
      [
        parsedThread.threadUpdated ?? null,
        parsedThread.os ?? null,
        parsedThread.language ?? null,
        parsedThread.censored ?? null,
        JSON.stringify(parsedThread.developerLinks || []),
        parsedThread.rating ?? null,
        parsedThread.ratingCount ?? null,
        game.id
      ]
    );
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

    this.recordVersionHistory(game.id, parsedThread.currentVersion, parsedThread.changelog);
    this.insertSyncRun(game.id, true, parsedThread.warnings, null);
    await this.persist();
    return this.getGameById(game.id);
  },

  // Appends a history entry whenever the thread's version differs from the latest recorded one.
  recordVersionHistory(gameId, version, changelog) {
    const current = String(version || "").trim();
    if (!current) return;
    const latest = this.first("SELECT version FROM game_history WHERE game_id = ? ORDER BY id DESC LIMIT 1", [gameId]);
    if (latest?.version === current) return;
    this.db.run(
      "INSERT INTO game_history (game_id, version, previous_version, changelog, detected_at) VALUES (?, ?, ?, ?, ?)",
      [gameId, current, latest?.version ?? null, String(changelog || "").slice(0, 8000) || null, new Date().toISOString()]
    );
  },

  listGameHistory(gameId, limit = 20) {
    return this.query(
      "SELECT id, version, previous_version, changelog, detected_at FROM game_history WHERE game_id = ? ORDER BY id DESC LIMIT ?",
      [gameId, limit]
    ).map((row) => ({
      id: row.id,
      version: row.version,
      previousVersion: row.previous_version,
      changelog: row.changelog || "",
      detectedAt: row.detected_at
    }));
  },

  async markSyncFailure(gameId, errorMessage) {
    this.db.run(
      "UPDATE games SET last_sync_at = ?, last_sync_status = 'failed' WHERE id = ?",
      [new Date().toISOString(), gameId]
    );
    this.insertSyncRun(gameId, false, [], errorMessage);
    await this.persist();
  },

  async markSyncSuccess(gameId, warnings = []) {
    const now = new Date().toISOString();
    this.db.run(
      "UPDATE games SET last_sync_at = ?, last_sync_status = 'success', parser_warnings = ? WHERE id = ?",
      [now, JSON.stringify(warnings || []), gameId]
    );
    this.insertSyncRun(gameId, true, warnings, null);
    await this.persist();
    return this.getGameById(gameId);
  },

  insertSyncRun(gameId, success, warnings, errorText) {
    this.db.run(
      "INSERT INTO sync_runs (game_id, success, warnings, error_text, created_at) VALUES (?, ?, ?, ?, ?)",
      [gameId, success ? 1 : 0, JSON.stringify(warnings || []), errorText, new Date().toISOString()]
    );
  },

  getGames() {
    const rows = this.query("SELECT * FROM games ORDER BY title COLLATE NOCASE ASC");
    const links = this.query("SELECT * FROM download_links ORDER BY group_label, label");
    const folders = this.query("SELECT * FROM game_folders ORDER BY sort_rank ASC, id ASC");
    const linksByGame = this.groupRowsByKey(links, "game_id");
    const foldersByGame = this.groupRowsByKey(folders, "game_id");

    return rows.map((row) => this.hydrateGame(row, linksByGame[row.id] || [], foldersByGame[row.id] || []));
  },

  getGameById(gameId) {
    const row = this.first("SELECT * FROM games WHERE id = ?", [gameId]);
    if (!row) return null;
    const links = this.query("SELECT * FROM download_links WHERE game_id = ? ORDER BY group_label, label", [gameId]);
    const folders = this.query("SELECT * FROM game_folders WHERE game_id = ? ORDER BY sort_rank ASC, id ASC", [gameId]);
    return this.hydrateGame(row, links, folders);
  },

  getGameRefreshMetadata(gameId) {
    const row = this.first(
      "SELECT id, thread_url, raw_op_html, raw_op_text, banner_image_url, banner_image_path, screenshot_images, parser_warnings, parser_debug FROM games WHERE id = ?",
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
      parserDebug: safeJsonParse(row.parser_debug, {}),
      downloadGroups,
      bannerImage: row.banner_image_path
        ? {
            sourceUrl: row.banner_image_url || null,
            localPath: row.banner_image_path
          }
        : null,
      screenshotImages: safeJsonParse(row.screenshot_images, [])
    };
  },

  async updateGameSeasons(gameId, hasSeasons) {
    this.db.run("UPDATE games SET has_seasons = ? WHERE id = ?", [hasSeasons ? 1 : 0, gameId]);
    await this.persist();
    return this.getGameById(gameId);
  },

  async updateInstalledVersion(gameId, installedVersion, installPath) {
    this.db.run("UPDATE games SET installed_version = ?, install_path = ? WHERE id = ?", [
      installedVersion,
      installPath ?? null,
      gameId
    ]);
    await this.persist();
    return this.getGameById(gameId);
  },

  async updateInstallPath(gameId, installPath) {
    this.db.run("UPDATE games SET install_path = ? WHERE id = ?", [installPath ?? null, gameId]);
    await this.persist();
    return this.getGameById(gameId);
  },

  async deleteGame(gameId) {
    this.db.run("DELETE FROM download_links WHERE game_id = ?", [gameId]);
    this.db.run("DELETE FROM sync_runs WHERE game_id = ?", [gameId]);
    this.db.run("DELETE FROM game_history WHERE game_id = ?", [gameId]);
    this.db.run("DELETE FROM archive_jobs WHERE game_id = ?", [gameId]);
    this.db.run("DELETE FROM game_folders WHERE game_id = ?", [gameId]);
    this.db.run("DELETE FROM games WHERE id = ?", [gameId]);
    await this.persist();
  },

  async appendAlias(gameId, alias) {
    const game = this.first("SELECT aliases FROM games WHERE id = ?", [gameId]);
    if (!game) return;
    const aliases = new Set(safeJsonParse(game.aliases, []));
    aliases.add(alias);
    this.db.run("UPDATE games SET aliases = ? WHERE id = ?", [JSON.stringify([...aliases]), gameId]);
    await this.persist();
  },

  compareIsoDates(left, right) {
    const leftTime = left ? Date.parse(left) : Number.NaN;
    const rightTime = right ? Date.parse(right) : Number.NaN;
    const safeLeft = Number.isNaN(leftTime) ? -Infinity : leftTime;
    const safeRight = Number.isNaN(rightTime) ? -Infinity : rightTime;
    if (safeLeft === safeRight) {
      return 0;
    }
    return safeLeft < safeRight ? -1 : 1;
  },

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
      threadId: row.thread_id,
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
      threadUpdated: row.thread_updated,
      os: row.os,
      language: row.language,
      censored: row.censored,
      developerLinks: safeJsonParse(row.developer_links, []),
      rating: row.rating,
      ratingCount: row.rating_count,
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
      history: this.listGameHistory(row.id),
      lastSyncAt: row.last_sync_at,
      lastSyncStatus: row.last_sync_status
    };
  },

  groupRowsByKey(rows, key) {
    return rows.reduce((accumulator, row) => {
      if (!accumulator[row[key]]) {
        accumulator[row[key]] = [];
      }
      accumulator[row[key]].push(row);
      return accumulator;
    }, {});
  }
};
