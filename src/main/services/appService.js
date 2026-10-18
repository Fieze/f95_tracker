const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { OperationGate } = require("./operationGate");
const { ArchiveQueue } = require("./archiveQueue");
const { atomicWrite } = require("./safeFiles");
const { DatabaseService } = require("./db");
const { archiveHasSingleRootDirectory, extractArchiveWithProgress, testArchive } = require("./extractor");
const { FolderWatcher, hashFile } = require("./folderWatcher");
const { extractVersionFromFilename, findBestGameMatch } = require("./matcher");
const { parseThread } = require("./parser");
const { SyncScheduler } = require("./syncScheduler");
const { ThreadFetcher } = require("./threadFetcher");
const { noopLogger } = require("./logger");
const { normalizeThreadUrl, sanitizeVersion } = require("./utils");

const MANAGED_FOLDER_POLL_INTERVAL_MS = 15000;
const BACKUP_INTERVAL_MS = 15 * 60 * 1000;
const BACKUP_RETENTION_COUNT = 3;
const ASSET_DOWNLOAD_CONCURRENCY = 4;
const FINISHED_ACTIVITY_VISIBLE_MS = 4000;
const ARCHIVE_PATTERN = /\.(zip|rar|7z)$/i;

class AppService {
  constructor({ userDataPath, authSession, onStateChanged, onGameUpdateAvailable, logger, loggers = {}, folderWatcher, downloadFetch, launchProcess, fetcherOptions }) {
    this.onStateChanged = onStateChanged;
    this.onGameUpdateAvailable = onGameUpdateAvailable;
    this.authSession = authSession;
    this.userDataPath = userDataPath;
    this.logger = logger || noopLogger;
    this.loggers = {
      main: this.logger,
      download: loggers.download || this.logger,
      extraction: loggers.extraction || this.logger,
      parsing: loggers.parsing || this.logger
    };
    this.downloadLogger = this.loggers.download;
    this.extractionLogger = this.loggers.extraction;
    this.parsingLogger = this.loggers.parsing;
    this.assetCachePath = path.join(userDataPath, "thread-assets");
    this.backupPath = path.join(userDataPath, "backups");
    this.gate = new OperationGate();
    this.downloadService = new (require("./downloadService").DownloadService)(this);
    this.installationService = new (require("./installationService").InstallationService)(this);
    this.archiveService = new (require("./archiveService").ArchiveService)(this);

    this.extractionAbort = null;
    this.archiveQueue = new ArchiveQueue({
      prepare: async ({ jobId, gameId, detectedVersion }) => {
        const job = this.db.listArchiveJobs().find((entry) => entry.id === jobId);
        if (!job || !this.db.getGameById(gameId)) throw new Error("Archive job or game not found.");
        if (job.status === "processed") throw new Error("Archive already processed.");
        await this.db.updateArchiveJob(jobId, { status: "queued", gameId, detectedVersion, errorText: null });
        this.emitChange();
      },
      run: ({ jobId, gameId, detectedVersion }) => this.runExtractJob(jobId, gameId, detectedVersion),
      onError: (error) => this.extractionLogger.error("Archive queue failed.", error)
    });
    this.currentExtraction = null;
    this.activeExtractionHandle = null;
    this.folderSyncTimer = null;
    this.backupTimer = null;
    this.startupRefreshPromise = null;
    this.downloadFetch = downloadFetch || ((...args) => fetch(...args));
    this.launchProcess = launchProcess || require("child_process").spawn;
    this.processedArchiveRemovalTimers = new Map();
    this.folderSyncInFlight = false;
    this.lastManagedFolderPollAt = 0;
    this.lastExtractionProgressEmitAt = 0;
    this.lastExtractionProgressLogAt = 0;
    this.db = new DatabaseService(userDataPath);
    this.sessionSeenLoggedIn = null;
    this.activities = [];
    this.nextActivityId = 1;
    this.activityTimers = new Map();
    this.pendingThreadUrls = new Set();
    this.pendingFolderPaths = new Set();
    // Archives the user dropped in from elsewhere: kept after extraction instead of being deleted/moved.
    this.keepSourceArchives = new Set();
    this.addThreadQueue = Promise.resolve();
    this.fetcher = new ThreadFetcher(authSession, fetcherOptions);
    this.archiveHasSingleRootDirectory = archiveHasSingleRootDirectory;
    this.extractArchiveWithProgress = extractArchiveWithProgress;
    this.testArchive = testArchive;
    this.archivePasswords = new Map();
    this.folderWatcher = folderWatcher || new FolderWatcher({
      onArchiveDetected: async (payload) => this.processArchive(payload)
    });
    this.scheduler = new SyncScheduler({
      onTick: async () => this.refreshAllGames(),
      logger: this.logger
    });
  }

  // Download jobs live in the download service; this keeps the list readable for callers that used the old field.
  get downloadJobs() { return this.downloadService.listDownloadJobs(); }
  set downloadJobs(jobs) { this.downloadService.replaceJobs(jobs); }

  async initialize() {
    await this.logger.info("Initializing application service.", {
      userDataPath: this.userDataPath
    });
    await this.db.initialize();
    await this.downloadService.loadPersistedJobs();
    await this.removeLegacyApiKey();
    await this.db.resetInterruptedArchiveJobs();
    await this.pruneMissingArchiveJobs();
    await fs.mkdir(this.assetCachePath, { recursive: true });
    const settings = this.db.getSettings();
    await this.applyRuntimeSettings(settings);
    await this.cleanupStagingDirectories();
    await this.pollManagedFolders({ emitOnChange: false });
    await this.createBackup();
    this.startBackupScheduler();
    void this.startStartupRefresh();
    await this.logger.info("Application service initialized.");
  }

  async bootstrap() {
    return this.getState();
  }

  async getState() {
    await this.pruneMissingArchiveJobs();
    await this.refreshManagedFoldersIfStale();
    return {
      settings: this.db.getSettings(),
      auth: await this.getAuthState(),
      activities: this.activities.map((activity) => ({ ...activity, progress: activity.progress && { ...activity.progress } })),
      games: this.db.getGames(),
      archiveJobs: this.db.listArchiveJobs(),
      currentExtraction: this.currentExtraction,
      downloadJobs: this.listDownloadJobs()
    };
  }

  async updateSettings(payload) {
    if (this.archiveQueue.busy && payload.installRoot !== undefined && payload.installRoot !== this.db.getSettings().installRoot) throw new Error("Finish archive jobs before changing the install root.");
    await this.logger.info("Updating settings.", {
      installRoot: payload?.installRoot || "",
      watchFolder: payload?.watchFolder || "",
      syncIntervalMinutes: payload?.syncIntervalMinutes ?? null
    });
    const settings = await this.db.saveSettings({
      watchFolder: payload.installRoot ? payload.watchFolder : payload.watchFolder,
      installRoot: payload.installRoot,
      syncIntervalMinutes: payload.syncIntervalMinutes,
      keepArchives: payload.keepArchives === undefined ? undefined : Boolean(payload.keepArchives),
      extraDownloadHosts: payload.extraDownloadHosts === undefined ? undefined : String(payload.extraDownloadHosts)
    });
    await this.applyRuntimeSettings(settings);
    await this.pollManagedFolders({ emitOnChange: false });
    this.emitChange();
    return this.getState();
  }

  async exportDataToFile(filePath) {
    const targetPath = path.resolve(String(filePath || ""));
    if (!targetPath) {
      throw new Error("Export path is required.");
    }

    const snapshot = this.db.exportSnapshot();
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await atomicWrite(targetPath, JSON.stringify(snapshot, null, 2));
    await this.logger.info("Exported data snapshot.", { targetPath });
    return { path: targetPath };
  }

  // The F95 API integration was removed; delete a key stored by an earlier version.
  async removeLegacyApiKey() {
    await fs.unlink(path.join(this.userDataPath, "f95-api-key.bin")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  // Scrapes the thread page with the app's F95Zone session. Guests can read metadata; only download links
  // and some tags need a login.
  async loadThread(url, details = {}) {
    const thread = await this.fetcher.fetchThread(url, { interactive: details.interactive !== false });
    this.noteLoggedInFromHtml(thread.html);
    return this.parseThreadWithLogging(thread.html, thread.url, details);
  }

  // Every F95Zone page states whether the session is logged in, which is more reliable than the cookie alone.
  noteLoggedInFromHtml(html) {
    const match = String(html || "").match(/<html[^>]*\sdata-logged-in="(true|false)"/i);
    if (!match) return null;
    const loggedIn = match[1] === "true";
    if (this.sessionSeenLoggedIn !== loggedIn) {
      this.sessionSeenLoggedIn = loggedIn;
      this.emitChange();
    }
    return loggedIn;
  }

  // A guest page must not wipe download links or hidden tags that an earlier logged-in sync stored.
  preserveMembersOnlyData(parsed, refreshMetadata, game) {
    if (!parsed.parserDebug?.guestView) return;
    if (!parsed.downloadGroups?.length) parsed.downloadGroups = refreshMetadata?.downloadGroups || game.downloadGroups || [];
    const known = new Set(parsed.tags);
    parsed.tags = [...parsed.tags, ...(game.tags || []).filter((tag) => !known.has(tag))];
  }

  async importDataFromFile(filePath) {
    const sourcePath = path.resolve(String(filePath || ""));
    if (!sourcePath) {
      throw new Error("Import path is required.");
    }

    if (this.archiveQueue.busy || this.downloadService.hasActiveJobs()) {
      throw new Error("Finish downloads and archive jobs before importing data.");
    }
    return this.gate.runExclusive(async () => {
      const content = await fs.readFile(sourcePath, "utf8");
      const candidate = this.db.prepareSnapshot(JSON.parse(content));
      try {
        await this.createBackup();
        await this.db.commitPreparedSnapshot(candidate);
      } finally { candidate.db?.close(); }
      if (this.gate.closed) return;
      const settings = this.db.getSettings();
      await this.applyRuntimeSettings(settings);
      await this.cleanupStagingDirectories();
      await this.pollManagedFolders({ emitOnChange: false });
      this.emitChange();
      await this.logger.info("Imported data snapshot.", { sourcePath });
      return this.getState();
    });
  }

  async deleteGame(gameId) {
    this.assertGameIdle(gameId);
    await this.logger.info("Deleting game.", { gameId: Number(gameId) });
    await this.db.deleteGame(gameId);
    this.emitChange();
    return this.getState();
  }

  async applyRuntimeSettings(settings) {
    if (this.gate.closed) return;
    await this.folderWatcher.start(settings.watchFolder);
    if (this.gate.closed) { await this.folderWatcher.stop(); return; }
    this.scheduler.start(settings.syncIntervalMinutes);
    this.startManagedFolderMonitor();
  }

  startStartupRefresh() {
    if (this.startupRefreshPromise) {
      return this.startupRefreshPromise;
    }

    this.startupRefreshPromise = Promise.resolve()
      .then(async () => {
        await this.logger.info("Starting initial refresh for all games.");
        return this.refreshAllGames();
      })
      .catch(async (error) => {
        await this.logger.error("Initial refresh for all games failed.", error);
      })
      .finally(() => {
        this.startupRefreshPromise = null;
      });

    return this.startupRefreshPromise;
  }

  // ---- Background activities, shown in the status line ----

  startActivity(kind, label, { total = 0 } = {}) {
    const id = this.nextActivityId++;
    this.activities.push({
      id, kind, label, status: "running", message: "", startedAt: new Date().toISOString(),
      progress: total ? { done: 0, total } : null
    });
    this.emitChange();
    return id;
  }

  updateActivity(id, patch) {
    const activity = this.activities.find((entry) => entry.id === id);
    if (!activity) return;
    Object.assign(activity, patch);
    if (patch.progress) activity.progress = { ...patch.progress };
    this.emitChange();
  }

  // Successful activities disappear after a moment; failed ones stay until the user dismisses them.
  finishActivity(id, { error = "", message = "" } = {}) {
    const activity = this.activities.find((entry) => entry.id === id);
    if (!activity) return;
    activity.status = error ? "error" : "done";
    activity.message = error || message;
    this.emitChange();
    if (!error) {
      const timer = setTimeout(() => this.dismissActivity(id), FINISHED_ACTIVITY_VISIBLE_MS);
      timer.unref?.();
      this.activityTimers.set(id, timer);
    }
  }

  dismissActivity(id) {
    clearTimeout(this.activityTimers.get(id));
    this.activityTimers.delete(id);
    const before = this.activities.length;
    this.activities = this.activities.filter((entry) => entry.id !== id || entry.status === "running");
    if (this.activities.length !== before) this.emitChange();
    return this.activities.length !== before;
  }

  // Validates the address right away, then imports the thread in the background; progress and errors show in the
  // status line so the add dialog can close immediately.
  addThreadInBackground(threadUrl) {
    const normalizedUrl = normalizeThreadUrl(threadUrl);
    if (this.pendingThreadUrls.has(normalizedUrl)) return { queued: false, duplicate: true };
    this.pendingThreadUrls.add(normalizedUrl);
    const slug = normalizedUrl.split("/threads/")[1]?.replace(/\.\d+\/?$/, "").replace(/-/g, " ") || normalizedUrl;
    const activityId = this.startActivity("add-thread", `Adding ${slug}`);
    const run = async () => {
      try {
        const game = await this.addThread(normalizedUrl);
        this.finishActivity(activityId, { message: `Added ${game.title}` });
      } catch (error) {
        this.finishActivity(activityId, { error: error.message });
        await this.logger.error("Background thread import failed.", { threadUrl: normalizedUrl, message: error.message });
      } finally {
        this.pendingThreadUrls.delete(normalizedUrl);
      }
    };
    this.addThreadQueue = this.addThreadQueue.then(run, run);
    return { queued: true, activityId };
  }

  // Adds an existing game folder (to a library game or a new one from a thread URL) in the background.
  // The folder is validated right away so mistakes show up in the dialog; moving and importing report in the status line.
  async addExistingFolderInBackground({ folderPath, mode = "keep", gameId = null, threadUrl = "", version = "" } = {}) {
    if (!["keep", "move"].includes(mode)) throw new Error("Unknown option for the folder.");
    let existingGame = null;
    let normalizedUrl = "";
    if (gameId) {
      existingGame = this.db.getGameById(Number(gameId));
      if (!existingGame) throw new Error("Game not found.");
    } else {
      normalizedUrl = normalizeThreadUrl(threadUrl);
    }
    const source = await this.validateExistingFolder(folderPath, mode, existingGame);
    const key = process.platform === "win32" ? source.folderPath.toLowerCase() : source.folderPath;
    if (this.pendingFolderPaths.has(key)) return { queued: false, duplicate: true };
    this.pendingFolderPaths.add(key);

    const verb = mode === "move" ? "Moving" : "Adding";
    const activityId = this.startActivity("add-folder", `${verb} folder ${source.folderName}`);
    const run = async () => {
      try {
        const game = existingGame || (await this.addThread(normalizedUrl));
        this.updateActivity(activityId, { label: `${verb} folder ${source.folderName} to ${game.title}` });
        await this.addExistingFolder({ folderPath: source.folderPath, gameId: game.id, mode, version });
        const moved = mode === "move" && !(await this.assetExists(source.folderPath));
        this.finishActivity(activityId, { message: `${moved ? "Moved" : "Added"} ${source.folderName} (${game.title})` });
      } catch (error) {
        this.finishActivity(activityId, { error: error.message });
        await this.logger.error("Adding an existing folder failed.", { folderPath: source.folderPath, message: error.message });
      } finally {
        this.pendingFolderPaths.delete(key);
      }
    };
    this.addThreadQueue = this.addThreadQueue.then(run, run);
    return { queued: true, activityId };
  }

  // Describes items dropped onto the window: what they are, the best matching library game and a guessed version.
  async inspectDroppedPaths(paths) {
    const games = this.db.getGames();
    const items = [];
    for (const raw of (Array.isArray(paths) ? paths : []).slice(0, 20)) {
      const value = String(raw || "");
      if (!path.isAbsolute(value)) continue;
      const resolved = path.resolve(value);
      const name = path.basename(resolved);
      const stats = await fs.stat(resolved).catch(() => null);
      const kind = stats?.isDirectory() ? "folder" : stats?.isFile() && ARCHIVE_PATTERN.test(name) ? "archive" : "unsupported";
      let game = null;
      if (kind !== "unsupported") {
        const match = findBestGameMatch(name, games);
        const best = match.bestMatch;
        if (best && (match.kind === "matched" || best.score >= 30)) game = games.find((entry) => entry.id === best.gameId) || null;
      }
      items.push({
        path: resolved,
        name,
        kind,
        gameId: game ? game.id : null,
        version: kind === "unsupported" ? null : extractVersionFromFilename(name, game || {})
      });
    }
    return items;
  }

  // Registers an archive from anywhere on disk for a game (existing or new from a thread URL). With `extract` it is
  // also unpacked into the install root. The original file is never deleted or moved.
  async addDroppedArchiveInBackground({ archivePath, gameId = null, threadUrl = "", version = "", extract = false } = {}) {
    const resolved = path.resolve(String(archivePath || ""));
    if (!path.isAbsolute(String(archivePath || "")) || !ARCHIVE_PATTERN.test(resolved)) throw new Error("Only ZIP, RAR and 7z archives can be added.");
    if (!(await fs.stat(resolved).catch(() => null))?.isFile()) throw new Error("The selected archive does not exist.");
    let existingGame = null;
    let normalizedUrl = "";
    if (gameId) {
      existingGame = this.db.getGameById(Number(gameId));
      if (!existingGame) throw new Error("Game not found.");
    } else {
      normalizedUrl = normalizeThreadUrl(threadUrl);
    }
    if (extract && !this.db.getSettings().installRoot) throw new Error("Set an install root in Settings before extracting.");
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (this.pendingFolderPaths.has(key)) return { queued: false, duplicate: true };
    this.pendingFolderPaths.add(key);

    const name = path.basename(resolved);
    const activityId = this.startActivity("add-folder", `${extract ? "Extracting" : "Adding"} archive ${name}`);
    const run = async () => {
      try {
        const game = existingGame || (await this.addThread(normalizedUrl));
        this.updateActivity(activityId, { label: `${extract ? "Extracting" : "Adding"} archive ${name} to ${game.title}` });
        const archiveHash = await hashFile(resolved);
        this.folderWatcher.ignoreFile(resolved, 45000);
        this.keepSourceArchives.add(key);
        const job = await this.processArchive({
          archivePath: resolved, archiveName: name, archiveHash, gameId: game.id,
          detectedVersion: sanitizeVersion(version) || null, autoExtract: Boolean(extract)
        });
        this.finishActivity(activityId, {
          message: extract && job?.status !== "processed" ? `Extracting ${name} (${game.title})` : `Added archive ${name} (${game.title})`
        });
      } catch (error) {
        this.finishActivity(activityId, { error: error.message });
        await this.logger.error("Adding an archive failed.", { archivePath: resolved, message: error.message });
      } finally {
        this.pendingFolderPaths.delete(key);
      }
    };
    this.addThreadQueue = this.addThreadQueue.then(run, run);
    return { queued: true, activityId };
  }

  async addThread(threadUrl) {
    const normalizedUrl = normalizeThreadUrl(threadUrl);
    await this.logger.info("Adding thread.", { threadUrl: normalizedUrl });
    const parsed = await this.loadThread(normalizedUrl, {
      action: "add_thread",
      threadUrl: normalizedUrl
    });
    const enriched = await this.hydrateThreadAssets(parsed);
    const game = await this.db.upsertGameFromThread(enriched);
    await this.syncGameFolders(game.id, { game: this.db.getGameById(game.id) });
    this.emitChange();
    await this.logger.info("Thread added.", { gameId: game.id, title: game.title });
    return this.db.getGameById(game.id);
  }

  async refreshGame(gameId, { background = false } = {}) {
    const game = this.db.getGameById(gameId);
    const refreshMetadata = this.db.getGameRefreshMetadata(gameId);
    if (!game) {
      throw new Error("Game not found.");
    }
    await this.logger.info("Refreshing game.", { gameId: Number(gameId), title: game.title });
    // A refresh of all games reports its own progress; single refreshes get their own entry.
    const activityId = background ? null : this.startActivity("refresh", `Refreshing ${game.title}`);
    try {
      const parsed = await this.loadThread(game.threadUrl, {
        interactive: !background,
        action: "refresh_game",
        gameId: game.id,
        title: game.title
      });
      this.preserveMembersOnlyData(parsed, refreshMetadata, game);
      if (!this.hasThreadChanges(refreshMetadata, parsed)) {
        await this.db.markSyncSuccess(game.id, parsed.warnings || []);
        await this.logger.info("Game refresh detected no thread changes.", {
          gameId: game.id,
          title: game.title
        });
        return this.db.getGameById(game.id);
      }

      const enriched = await this.hydrateThreadAssets(parsed, refreshMetadata);
      const updated = await this.db.upsertGameFromThread(enriched);
      await this.syncGameFolders(updated.id, { game: this.db.getGameById(updated.id) });
      const nextGame = this.db.getGameById(updated.id);
      await this.emitUpdateNotificationIfNeeded(game, nextGame);
      this.emitChange();
      await this.logger.info("Game refreshed.", { gameId: updated.id, title: updated.title });
      return nextGame;
    } catch (error) {
      await this.db.markSyncFailure(gameId, error.message);
      this.emitChange();
      await this.logger.error("Game refresh failed.", {
        gameId: Number(gameId),
        title: game.title,
        message: error.message
      });
      throw error;
    } finally {
      if (activityId) this.finishActivity(activityId);
    }
  }

  async parseThreadWithLogging(html, sourceUrl, details = {}) {
    const startedAt = Date.now();
    await this.parsingLogger.info("Parsing thread.", {
      sourceUrl,
      ...details
    });

    try {
      const parsed = parseThread(html, sourceUrl);
      await this.parsingLogger.info("Thread parsed.", {
        sourceUrl: parsed.sourceUrl || sourceUrl,
        title: parsed.title || "",
        warningCount: parsed.warnings?.length || 0,
        downloadGroupCount: parsed.downloadGroups?.length || 0,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...details
      });
      return parsed;
    } catch (error) {
      await this.parsingLogger.error("Thread parsing failed.", {
        sourceUrl,
        durationMs: Math.max(0, Date.now() - startedAt),
        message: error.message,
        ...details
      });
      throw error;
    }
  }

  async emitUpdateNotificationIfNeeded(previousGame, nextGame) {
    if (!previousGame || !nextGame) {
      return;
    }

    if (previousGame.status === "update-available" || nextGame.status !== "update-available") {
      return;
    }

    await this.logger.info("Game update became available.", {
      gameId: nextGame.id,
      title: nextGame.title,
      previousInstalledVersion: previousGame.installedVersion || null,
      nextInstalledVersion: nextGame.installedVersion || null,
      currentVersion: nextGame.currentVersion || null
    });

    await this.onGameUpdateAvailable?.({
      gameId: nextGame.id,
      title: nextGame.title,
      threadTitle: nextGame.threadTitle,
      currentVersion: nextGame.currentVersion || null,
      installedVersion: nextGame.installedVersion || null,
      previousStatus: previousGame.status || null,
      status: nextGame.status
    });
  }

  async refreshAllGames() {
    await this.logger.info("Refreshing all games.");
    const games = this.db.getGames();
    const activityId = games.length ? this.startActivity("refresh-all", "Refreshing games", { total: games.length }) : null;
    let failed = 0;
    let stoppedByCheck = false;
    for (const [index, game] of games.entries()) {
      this.updateActivity(activityId, { label: `Refreshing ${game.title}`, progress: { done: index, total: games.length } });
      try {
        await this.refreshGame(game.id, { background: true });
      } catch (error) {
        if (error.challenge) {
          // Every further request would just hit the same browser check; stop and wait for the user.
          await this.logger.warn("Refresh stopped: F95Zone is asking for a browser check.", { message: error.message });
          stoppedByCheck = true;
          break;
        }
        failed += 1;
        await this.logger.warn("Background refresh skipped failed game.", {
          gameId: game.id,
          title: game.title,
          message: error.message
        });
        // Keep background refresh resilient per game.
      }
    }
    await this.logger.info("Finished refreshing all games.", { count: games.length });
    if (activityId) {
      if (stoppedByCheck) {
        this.finishActivity(activityId, { error: "Refresh stopped: F95Zone wants a browser check. Open Login to complete it." });
      } else if (failed) {
        this.finishActivity(activityId, { error: `Refresh finished, but ${failed} game${failed === 1 ? "" : "s"} could not be updated (see log).` });
      } else {
        this.finishActivity(activityId, { message: `${games.length} games up to date` });
      }
    }
    return this.getState();
  }

  async hydrateThreadAssets(parsedThread, existingAssets = null) {
    const warnings = [...(parsedThread.warnings || [])];
    let bannerImage = null;
    const screenshotImages = [];

    const bannerPromise = parsedThread.bannerImageUrl
      ? this.resolveThreadAsset(parsedThread.bannerImageUrl, "banner", existingAssets?.bannerImage || null).catch((error) => {
          warnings.push(`Banner image could not be downloaded: ${error.message}`);
          return null;
        })
      : Promise.resolve(null);

    const existingScreenshots = new Map(
      (existingAssets?.screenshotImages || [])
        .filter((asset) => asset?.sourceUrl && asset?.localPath)
        .map((asset) => [asset.sourceUrl, asset])
    );

    // A few downloads at a time; results keep the order of the thread.
    const screenshotUrls = parsedThread.screenshotImageUrls || [];
    const screenshotResults = new Array(screenshotUrls.length);
    let nextScreenshot = 0;
    const worker = async () => {
      while (nextScreenshot < screenshotUrls.length) {
        const index = nextScreenshot++;
        try {
          screenshotResults[index] = await this.resolveThreadAsset(
            screenshotUrls[index], "screenshot", existingScreenshots.get(screenshotUrls[index]) || null
          );
        } catch (error) {
          screenshotResults[index] = { error: `Screenshot could not be downloaded: ${error.message}` };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ASSET_DOWNLOAD_CONCURRENCY, screenshotUrls.length) }, worker));
    for (const result of screenshotResults) {
      if (result?.error) warnings.push(result.error);
      else if (result) screenshotImages.push(result);
    }
    bannerImage = await bannerPromise;

    return {
      ...parsedThread,
      bannerImage,
      screenshotImages,
      warnings
    };
  }

  hasThreadChanges(existingThread, parsedThread) {
    if (!existingThread) {
      return true;
    }

    const existingWarnings = JSON.stringify(existingThread.parserWarnings || []);
    const parsedWarnings = JSON.stringify(parsedThread.warnings || []);
    const existingDownloads = JSON.stringify(existingThread.downloadGroups || []);
    const parsedDownloads = JSON.stringify(parsedThread.downloadGroups || []);

    return (
      String(existingThread.sourceUrl || "") !== String(parsedThread.sourceUrl || "") ||
      String(existingThread.rawOpHtml || "") !== String(parsedThread.rawOpHtml || "") ||
      String(existingThread.rawOpText || "") !== String(parsedThread.rawOpText || "") ||
      existingWarnings !== parsedWarnings ||
      existingDownloads !== parsedDownloads
    );
  }

  async resolveThreadAsset(assetUrl, prefix, existingAsset = null) {
    if (
      existingAsset?.sourceUrl &&
      existingAsset.sourceUrl === assetUrl &&
      existingAsset.localPath &&
      (await this.assetExists(existingAsset.localPath))
    ) {
      await this.downloadLogger.info("Reused cached asset.", {
        prefix,
        assetUrl,
        filePath: existingAsset.localPath
      });
      return existingAsset;
    }

    return this.downloadAsset(assetUrl, prefix);
  }

  async assetExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async downloadAsset(assetUrl, prefix) {
    const fetched = await this.fetcher.fetchBinary(assetUrl);
    const extension = this.resolveAssetExtension(fetched.url, fetched.contentType);
    const fileName = `${prefix}-${crypto.createHash("sha1").update(fetched.url).digest("hex")}${extension}`;
    const filePath = path.join(this.assetCachePath, fileName);
    await fs.writeFile(filePath, fetched.buffer);
    await this.downloadLogger.info("Downloaded asset.", {
      prefix,
      assetUrl: fetched.url,
      filePath
    });

    return {
      sourceUrl: fetched.url,
      localPath: filePath
    };
  }

  resolveAssetExtension(assetUrl, contentType) {
    const content = String(contentType || "").toLowerCase();
    if (content.includes("png")) return ".png";
    if (content.includes("webp")) return ".webp";
    if (content.includes("gif")) return ".gif";
    if (content.includes("jpeg") || content.includes("jpg")) return ".jpg";

    try {
      const parsed = new URL(assetUrl);
      const match = parsed.pathname.match(/\.(png|jpe?g|webp|gif)$/i);
      return match ? `.${match[1].toLowerCase().replace("jpeg", "jpg")}` : ".img";
    } catch {
      return ".img";
    }
  }

  emitChange() {
    this.onStateChanged?.();
  }

  async getAuthState() {
    const cookies = await this.authSession.cookies.get({ domain: "f95zone.to" });
    const cookieMap = new Map(cookies.map((cookie) => [cookie.name, cookie.value]));
    const hasUserCookie = cookieMap.has("xf_user");
    // A cookie that F95Zone no longer honours shows up as data-logged-in="false" on the next page we load.
    const sessionExpired = hasUserCookie && this.sessionSeenLoggedIn === false;
    const loggedIn = hasUserCookie && !sessionExpired;
    return {
      loggedIn,
      sessionExpired,
      hasSessionCookie: cookieMap.has("xf_session"),
      hasUserCookie: cookieMap.has("xf_user")
    };
  }

  // The user finished the browser check in the login window: allow scraping again.
  resumeAfterBrowserCheck() {
    this.fetcher.resetChallenge();
  }

  async verifyAuth() {
    const auth = await this.getAuthState();
    const response = await this.fetcher.fetchUrl("https://f95zone.to/account/");
    const html = response.html || "";
    const pageLoggedIn = this.noteLoggedInFromHtml(html);
    const redirectedToLogin = /\/login\//i.test(response.url);
    const hasLogoutLink = /\/logout\//i.test(html);
    const hasAccountMarker = /\/account\/|visitor-menu|menuTrigger/i.test(html);
    const loginFormVisible = /name="login"|two-step|tfa|authy/i.test(html);

    return {
      ...auth,
      checkedUrl: response.url,
      requestedUrl: response.requestedUrl,
      statusCode: response.status,
      redirectedToLogin,
      hasLogoutLink,
      hasAccountMarker,
      loginFormVisible,
      pageLoggedIn,
      ok: pageLoggedIn !== null ? pageLoggedIn : auth.loggedIn && !redirectedToLogin && !loginFormVisible
    };
  }

  async logout() {
    await this.logger.info("Clearing authentication cookies.");
    const cookies = await this.authSession.cookies.get({ domain: "f95zone.to" });
    await Promise.all(
      cookies.map((cookie) =>
        this.authSession.cookies.remove(`https://${cookie.domain.replace(/^\./, "")}${cookie.path}`, cookie.name)
      )
    );
    this.emitChange();
  }

  assertGameIdle(gameId) {
    if (this.archiveQueue.hasGame(gameId) || this.downloadService.hasActiveJobs(gameId)) {
      throw new Error("Finish downloads and archive jobs for this game first.");
    }
  }

  async dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.performDispose().catch((error) => { this.disposePromise = null; throw error; });
    return this.disposePromise;
  }

  async performDispose() {
    this.gate.closed = true;
    this.archiveQueue.closed = true;
    this.scheduler.stop();
    for (const timer of this.activityTimers.values()) clearTimeout(timer);
    this.activityTimers.clear();
    this.stopManagedFolderMonitor();
    this.stopBackupScheduler();
    this.extractionAbort?.abort();
    this.fetcher.abort?.();
    for (const controller of this.downloadService.controllers.values()) controller.abort();
    await this.logger.info("Disposing application service.");
    if (this.activeExtractionHandle?.terminate) {
      await this.activeExtractionHandle.terminate();
      this.activeExtractionHandle = null;
    }
    this.downloadService.controllers.clear();
    for (const timer of this.processedArchiveRemovalTimers.values()) {
      clearTimeout(timer);
    }
    this.processedArchiveRemovalTimers.clear();
    await this.downloadService.interruptAndPersist();
    await this.folderWatcher.stop();
    if (this.currentExtraction?.jobId) {
      await this.db.updateArchiveJob(this.currentExtraction.jobId, {
        status: "queued",
        errorText: "Extraction was interrupted when the app closed."
      });
      this.currentExtraction = null;
    }
    await this.archiveQueue.close();
    await this.gate.drain();
    await this.db.flush();
    await this.logger.info("Application service disposed.");
  }

  startManagedFolderMonitor() {
    this.stopManagedFolderMonitor();
    this.folderSyncTimer = setInterval(() => {
      this.pollManagedFolders().catch(() => {});
    }, MANAGED_FOLDER_POLL_INTERVAL_MS);
  }

  stopManagedFolderMonitor() {
    if (this.folderSyncTimer) {
      clearInterval(this.folderSyncTimer);
      this.folderSyncTimer = null;
    }
  }

  startBackupScheduler() {
    this.stopBackupScheduler();
    this.backupTimer = setInterval(() => {
      this.createBackup().catch(() => {});
    }, BACKUP_INTERVAL_MS);
  }

  stopBackupScheduler() {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
  }

  async createBackup() {
    await this.db.flush();
    await fs.mkdir(this.backupPath, { recursive: true });
    const snapshot = this.db.exportSnapshot();
    const safeTimestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\./g, "-");
    const filePath = path.join(this.backupPath, `backup-${safeTimestamp}.json`);
    await atomicWrite(filePath, JSON.stringify(snapshot, null, 2));
    await this.pruneBackups();
    await this.logger.info("Created backup.", { filePath });
    return filePath;
  }

  async pruneBackups() {
    const entries = await fs.readdir(this.backupPath, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^backup-.*\.json$/i.test(entry.name))
        .map(async (entry) => {
          const fullPath = path.join(this.backupPath, entry.name);
          const stats = await fs.stat(fullPath);
          return {
            fullPath,
            mtimeMs: stats.mtimeMs
          };
        })
    );

    const staleFiles = files
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(BACKUP_RETENTION_COUNT);

    await Promise.all(staleFiles.map((file) => fs.unlink(file.fullPath).catch(() => {})));
  }

  async pollManagedFolders({ emitOnChange = true } = {}) {
    if (this.folderSyncInFlight) {
      return false;
    }

    this.folderSyncInFlight = true;
    this.lastManagedFolderPollAt = Date.now();
    try {
      const changed = await this.syncAllManagedFolders();
      if (changed && emitOnChange) {
        this.emitChange();
      }
      return changed;
    } finally {
      this.folderSyncInFlight = false;
    }
  }

  async refreshManagedFoldersIfStale() {
    const settings = this.db.getSettings();
    if (!settings.installRoot || this.folderSyncInFlight) {
      return false;
    }

    const now = Date.now();
    if (now - this.lastManagedFolderPollAt < MANAGED_FOLDER_POLL_INTERVAL_MS) {
      return false;
    }

    return this.pollManagedFolders({ emitOnChange: false });
  }
}


const delegatedMethods = {
  "downloadService": [
    "listDownloadJobs",
    "ensureDownloadReady",
    "createDownloadJob",
    "updateDownloadJob",
    "getDownloadJob",
    "markDownloadAwaiting",
    "cancelDownloadJob",
    "failDownloadJob",
    "getDownloadHost",
    "isProbableFileDownloadUrl",
    "startResolvedDownload",
    "buildResolvedDownloadHeaders",
    "streamResponseToFile",
    "downloadWithResume",
    "resolveDownloadFileName",
    "sanitizeDownloadFileName",
    "extractFileNameFromContentDisposition",
    "reserveDownloadTargetPath"
  ],
  "installationService": [
    "setInstalledVersion",
    "inferInstalledVersionFromFolder",
    "listGameFolders",
    "resolveFolderReference",
    "updateGameFolderVersion",
    "updateGameSeasons",
    "updateGameFolderMetadata",
    "deleteGameFolder",
    "refreshGameFolders",
    "listLaunchExecutables",
    "resolveLaunchExecutablePath",
    "launchExecutable",
    "validateInstallPath",
    "moveInstallPathToExpected",
    "movePath",
    "validateExistingFolder",
    "addExistingFolder",
    "syncAllManagedFolders",
    "syncGameFolders",
    "ensureGameRootForGame",
    "ensureAllGameRoots",
    "listDirectSubdirectories",
    "resolveGameRootPath",
    "getManagedGameRootCandidates"
  ],
  "archiveService": [
    "pruneMissingArchiveJobs",
    "deleteArchiveFile",
    "scheduleProcessedArchiveRemoval",
    "cancelProcessedArchiveRemoval",
    "processArchive",
    "resolveArchiveMatch",
    "setArchivePassword",
    "retireArchive",
    "extractJob",
    "runExtractJob",
    "estimateExtractionDurationMs",
    "updateExtractionProgress",
    "cleanupStagingDirectories"
  ]
};
for (const [service, names] of Object.entries(delegatedMethods)) {
  for (const name of names) {
    AppService.prototype[name] = function (...args) { return this[service][name](...args); };
  }
}

// Gate top-level operations; nested calls retain the same operation context.
for (const name of ["bootstrap","getState","updateSettings","exportDataToFile","deleteGame","setInstalledVersion","updateGameFolderVersion","updateGameSeasons","updateGameFolderMetadata","deleteGameFolder","refreshGameFolders","listLaunchExecutables","launchExecutable","moveInstallPathToExpected","addThread","addExistingFolder","refreshGame","refreshAllGames","deleteArchiveFile","processArchive","resolveArchiveMatch","setArchivePassword","extractJob","startResolvedDownload","logout","pollManagedFolders","createBackup","syncGameFolders","syncAllManagedFolders","pruneMissingArchiveJobs"]) {
  const operation = AppService.prototype[name];
  AppService.prototype[name] = async function (...args) { return this.gate.run(() => operation.apply(this, args)); };
}

module.exports = {
  AppService
};
