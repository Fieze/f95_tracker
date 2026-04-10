const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { DatabaseService } = require("./db");
const { archiveHasSingleRootDirectory, extractArchiveWithProgress } = require("./extractor");
const { FolderWatcher } = require("./folderWatcher");
const { extractVersionFromFilename, findBestGameMatch } = require("./matcher");
const { parseThread } = require("./parser");
const { SyncScheduler } = require("./syncScheduler");
const { ThreadFetcher } = require("./threadFetcher");
const { noopLogger } = require("./logger");
const {
  buildGameRootCandidates,
  buildInstallDirectory,
  buildVersionedInstallDirectory,
  isExpectedGameInstallPath,
  normalizeThreadUrl,
  rankLaunchExecutables,
  sanitizePathSegment,
  sanitizeVersion
} = require("./utils");

const MANAGED_FOLDER_POLL_INTERVAL_MS = 15000;
const EXTRACTION_PROGRESS_EMIT_INTERVAL_MS = 250;
const EXTRACTION_PROGRESS_LOG_INTERVAL_MS = 5000;
const BACKUP_INTERVAL_MS = 15 * 60 * 1000;
const BACKUP_RETENTION_COUNT = 3;
const DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS = 250;
const DOWNLOADABLE_FILE_EXTENSIONS = new Set([
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".tgz",
  ".exe",
  ".apk"
]);

class AppService {
  constructor({ userDataPath, authSession, onStateChanged, onGameUpdateAvailable, logger }) {
    this.onStateChanged = onStateChanged;
    this.onGameUpdateAvailable = onGameUpdateAvailable;
    this.authSession = authSession;
    this.userDataPath = userDataPath;
    this.logger = logger || noopLogger;
    this.assetCachePath = path.join(userDataPath, "thread-assets");
    this.backupPath = path.join(userDataPath, "backups");
    this.currentExtraction = null;
    this.activeExtractionHandle = null;
    this.folderSyncTimer = null;
    this.backupTimer = null;
    this.startupRefreshPromise = null;
    this.downloadJobs = [];
    this.nextDownloadJobId = 1;
    this.activeDownloadControllers = new Map();
    this.processedArchiveRemovalTimers = new Map();
    this.folderSyncInFlight = false;
    this.lastManagedFolderPollAt = 0;
    this.lastExtractionProgressEmitAt = 0;
    this.lastExtractionProgressLogAt = 0;
    this.db = new DatabaseService(userDataPath);
    this.fetcher = new ThreadFetcher(authSession);
    this.archiveHasSingleRootDirectory = archiveHasSingleRootDirectory;
    this.extractArchiveWithProgress = extractArchiveWithProgress;
    this.folderWatcher = new FolderWatcher({
      onArchiveDetected: async (payload) => this.processArchive(payload)
    });
    this.scheduler = new SyncScheduler({
      onTick: async () => this.refreshAllGames()
    });
  }

  async initialize() {
    await this.logger.info("Initializing application service.", {
      userDataPath: this.userDataPath
    });
    await this.db.initialize();
    await this.db.resetInterruptedArchiveJobs();
    await this.pruneMissingArchiveJobs();
    await fs.mkdir(this.assetCachePath, { recursive: true });
    const settings = this.db.getSettings();
    await this.applyRuntimeSettings(settings);
    await this.ensureAllGameRoots();
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
      games: this.db.getGames(),
      archiveJobs: this.db.listArchiveJobs(),
      currentExtraction: this.currentExtraction,
      downloadJobs: this.listDownloadJobs()
    };
  }

  async updateSettings(payload) {
    await this.logger.info("Updating settings.", {
      installRoot: payload?.installRoot || "",
      watchFolder: payload?.watchFolder || "",
      syncIntervalMinutes: payload?.syncIntervalMinutes ?? null
    });
    const settings = await this.db.saveSettings({
      watchFolder: payload.installRoot ? payload.watchFolder : payload.watchFolder,
      installRoot: payload.installRoot,
      syncIntervalMinutes: payload.syncIntervalMinutes
    });
    await this.applyRuntimeSettings(settings);
    await this.ensureAllGameRoots();
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
    await fs.writeFile(targetPath, JSON.stringify(snapshot, null, 2), "utf8");
    await this.logger.info("Exported data snapshot.", { targetPath });
    return { path: targetPath };
  }

  async importDataFromFile(filePath) {
    const sourcePath = path.resolve(String(filePath || ""));
    if (!sourcePath) {
      throw new Error("Import path is required.");
    }

    const content = await fs.readFile(sourcePath, "utf8");
    const snapshot = JSON.parse(content);
    await this.db.importSnapshot(snapshot);
    const settings = this.db.getSettings();
    await this.applyRuntimeSettings(settings);
    await this.ensureAllGameRoots();
    await this.pollManagedFolders({ emitOnChange: false });
    this.emitChange();
    await this.logger.info("Imported data snapshot.", { sourcePath });
    return this.getState();
  }

  async deleteGame(gameId) {
    await this.logger.info("Deleting game.", { gameId: Number(gameId) });
    await this.db.deleteGame(gameId);
    this.emitChange();
    return this.getState();
  }

  async setInstalledVersion(gameId, installedVersion, installPath) {
    await this.logger.info("Setting installed version.", {
      gameId: Number(gameId),
      installedVersion: installedVersion || null,
      installPath: installPath || null
    });
    const game = this.db.getGameById(gameId);
    if (!game) {
      throw new Error("Game not found.");
    }

    const normalized = sanitizeVersion(installedVersion) || null;
    const folders = this.db.listGameFolders(game.id);
    if (folders.length > 0) {
      const targetFolder =
        folders.find((folder) => folder.folderPath === installPath) ||
        folders.find((folder) => folder.id === game.primaryFolderId) ||
        folders[0];
      await this.db.updateGameFolderVersion(targetFolder.id, normalized, "manual");
      const nextFolders = this.db.listGameFolders(game.id);
      const rankedFolders = await this.db.recalculateGameFolderRanks(game.id, { game, folders: nextFolders });
      const updatedGame = await this.db.applyDerivedInstallState(game.id, rankedFolders, {
        installPath: game.installPath || null
      });
      this.emitChange();
      return updatedGame;
    }

    const nextInstallPath = installPath !== undefined ? installPath || null : game.installPath || null;
    const updatedGame = await this.db.updateInstalledVersion(gameId, normalized, nextInstallPath);
    this.emitChange();
    return updatedGame;
  }

  inferInstalledVersionFromFolder(folderPath) {
    const folderName = path.basename(String(folderPath || ""));
    return {
      folderPath,
      folderName,
      inferredVersion: extractVersionFromFilename(folderName)
    };
  }

  async listGameFolders(gameId) {
    await this.syncGameFolders(gameId);
    return this.db.listGameFolders(Number(gameId));
  }

  resolveFolderReference(folderRef) {
    if (folderRef && typeof folderRef === "object") {
      const byId = folderRef.folderId ? this.db.getGameFolder(Number(folderRef.folderId)) : null;
      if (byId) {
        return byId;
      }

      if (folderRef.gameId && folderRef.folderPath) {
        return this.db.findGameFolderByPath(Number(folderRef.gameId), path.resolve(String(folderRef.folderPath)));
      }
      return null;
    }

    return this.db.getGameFolder(Number(folderRef));
  }

  async updateGameFolderVersion(folderRef, versionArg) {
    const version = folderRef && typeof folderRef === "object" ? folderRef.version : versionArg;
    const folder = this.resolveFolderReference(folderRef);
    if (!folder) {
      throw new Error("Game folder not found.");
    }

    await this.logger.info("Updating game folder version.", {
      folderId: folder.id,
      gameId: folder.gameId,
      version: sanitizeVersion(version) || null
    });

    await this.db.updateGameFolderVersion(folder.id, sanitizeVersion(version) || null, "manual");
    const game = this.db.getGameById(folder.gameId);
    const folders = await this.db.recalculateGameFolderRanks(folder.gameId, { game });
    await this.db.applyDerivedInstallState(folder.gameId, folders, {
      installPath: game?.installPath || null
    });
    this.emitChange();
    return this.db.getGameById(folder.gameId);
  }

  async updateGameSeasons(gameId, hasSeasons) {
    await this.logger.info("Updating game season mode.", {
      gameId: Number(gameId),
      hasSeasons: Boolean(hasSeasons)
    });
    const game = this.db.getGameById(Number(gameId));
    if (!game) {
      throw new Error("Game not found.");
    }

    const updatedGame = await this.db.updateGameSeasons(game.id, Boolean(hasSeasons));
    const folders = await this.db.recalculateGameFolderRanks(game.id, { game: updatedGame });
    await this.db.applyDerivedInstallState(game.id, folders, {
      installPath: updatedGame.installPath || null
    });
    this.emitChange();
    return this.db.getGameById(game.id);
  }

  async updateGameFolderMetadata(folderRef, updates = {}) {
    const folder = this.resolveFolderReference(folderRef);
    if (!folder) {
      throw new Error("Game folder not found.");
    }
    await this.logger.info("Updating game folder metadata.", {
      folderId: folder.id,
      gameId: folder.gameId,
      updates: {
        version: Object.prototype.hasOwnProperty.call(updates, "version") ? updates.version || null : undefined,
        seasonNumber: Object.prototype.hasOwnProperty.call(updates, "seasonNumber") ? updates.seasonNumber : undefined,
        seasonFinal: Object.prototype.hasOwnProperty.call(updates, "seasonFinal") ? Boolean(updates.seasonFinal) : undefined,
        preferredExePath: Object.prototype.hasOwnProperty.call(updates, "preferredExePath")
          ? updates.preferredExePath || null
          : undefined
      }
    });
    const previousSeasonNumber = folder.seasonNumber ?? null;
    const nextVersion = Object.prototype.hasOwnProperty.call(updates, "version")
      ? sanitizeVersion(updates.version) || null
      : undefined;

    const seasonNumberRaw = Object.prototype.hasOwnProperty.call(updates, "seasonNumber")
      ? updates.seasonNumber
      : undefined;
    const seasonNumber =
      seasonNumberRaw === undefined || seasonNumberRaw === null || seasonNumberRaw === ""
        ? null
        : Number(seasonNumberRaw);

    if (seasonNumber !== null && (!Number.isInteger(seasonNumber) || seasonNumber < 1 || seasonNumber > 10)) {
      throw new Error("Season must be between 1 and 10.");
    }

    await this.db.updateGameFolderMetadata(folder.id, {
      version: nextVersion,
      versionSource: nextVersion !== undefined ? "manual" : undefined,
      seasonNumber,
      seasonFinal: Object.prototype.hasOwnProperty.call(updates, "seasonFinal")
        ? Boolean(updates.seasonFinal)
        : undefined,
      preferredExePath: Object.prototype.hasOwnProperty.call(updates, "preferredExePath")
        ? updates.preferredExePath || null
        : undefined
    });

    if (previousSeasonNumber !== seasonNumber || nextVersion !== undefined) {
      const game = this.db.getGameById(folder.gameId);
      const folders = await this.db.recalculateGameFolderRanks(folder.gameId, { game });
      await this.db.applyDerivedInstallState(folder.gameId, folders, {
        installPath: game?.installPath || null
      });
    }

    this.emitChange();
    return this.db.getGameById(folder.gameId);
  }

  async deleteGameFolder(folderRef) {
    const folder = this.resolveFolderReference(folderRef);
    if (!folder) {
      throw new Error("Game folder not found.");
    }

    await this.logger.info("Deleting game folder.", {
      folderId: folder.id,
      gameId: folder.gameId,
      folderPath: folder.folderPath
    });

    await fs.rm(folder.folderPath, { recursive: true, force: true });
    await this.db.deleteGameFolder(folder.id);
    const game = this.db.getGameById(folder.gameId);
    await this.syncGameFolders(folder.gameId, { game, skipFsDeleteCheck: true });
    this.emitChange();
    return this.db.getGameById(folder.gameId);
  }

  async refreshGameFolders(gameId) {
    await this.logger.info("Refreshing game folders.", { gameId: Number(gameId) });
    await this.syncGameFolders(gameId);
    this.emitChange();
    return this.db.getGameById(Number(gameId));
  }

  async listLaunchExecutables(folderRef) {
    const folder = this.resolveFolderReference(folderRef);
    if (!folder) {
      throw new Error("Game folder not found.");
    }

    const game = this.db.getGameById(folder.gameId);
    if (!game) {
      throw new Error("Game not found.");
    }

    const entries = await fs.readdir(folder.folderPath, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });

    const executables = entries
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".exe")
      .map((entry) => ({
        fileName: entry.name,
        fullPath: path.join(folder.folderPath, entry.name)
      }));

    return {
      executables: rankLaunchExecutables(executables, {
        title: game.title,
        threadTitle: game.threadTitle,
        aliases: game.aliases
      }).map((entry) => ({
        ...entry,
        isSelected: Boolean(folder.preferredExePath && path.resolve(folder.preferredExePath) === path.resolve(entry.fullPath))
      }))
    };
  }

  async resolveLaunchExecutablePath(folder, executablePathArg) {
    const listed = await this.listLaunchExecutables({ folderId: folder.id });
    const executables = listed.executables || [];
    if (!executables.length) {
      throw new Error("No executable was found in this game folder.");
    }

    const requestedPath = executablePathArg ? path.resolve(String(executablePathArg)) : "";
    const preferredPath = folder.preferredExePath ? path.resolve(String(folder.preferredExePath)) : "";
    const selectedExecutable =
      executables.find((entry) => requestedPath && path.resolve(entry.fullPath) === requestedPath) ||
      executables.find((entry) => preferredPath && path.resolve(entry.fullPath) === preferredPath) ||
      executables.find((entry) => entry.isRecommended) ||
      executables[0];

    if (!selectedExecutable) {
      throw new Error("No executable was found in this game folder.");
    }

    if (!folder.preferredExePath || path.resolve(folder.preferredExePath) !== path.resolve(selectedExecutable.fullPath)) {
      await this.db.updateGameFolderMetadata(folder.id, {
        preferredExePath: selectedExecutable.fullPath
      });
    }

    return selectedExecutable.fullPath;
  }

  async launchExecutable(folderRef, executablePathArg) {
    const requestedExecutablePath =
      folderRef && typeof folderRef === "object" ? folderRef.executablePath : executablePathArg;
    const folder = this.resolveFolderReference(folderRef);
    if (!folder) {
      throw new Error("Game folder not found.");
    }

    const resolvedFolderPath = path.resolve(folder.folderPath);
    if (requestedExecutablePath) {
      const requestedResolvedPath = path.resolve(String(requestedExecutablePath));
      const relativeRequestedPath = path.relative(resolvedFolderPath, requestedResolvedPath);
      if (
        !relativeRequestedPath ||
        relativeRequestedPath.startsWith("..") ||
        path.isAbsolute(relativeRequestedPath) ||
        relativeRequestedPath.includes(path.sep)
      ) {
        throw new Error("Executable must be located directly inside the selected game folder.");
      }
    }
    const executablePath = await this.resolveLaunchExecutablePath(folder, requestedExecutablePath);
    const resolvedExecutablePath = path.resolve(String(executablePath || ""));
    if (!resolvedExecutablePath || path.extname(resolvedExecutablePath).toLowerCase() !== ".exe") {
      throw new Error("Executable path is invalid.");
    }

    const relativePath = path.relative(resolvedFolderPath, resolvedExecutablePath);
    if (
      !relativePath ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      relativePath.includes(path.sep)
    ) {
      throw new Error("Executable must be located directly inside the selected game folder.");
    }

    const stats = await fs.stat(resolvedExecutablePath).catch(() => null);
    if (!stats?.isFile()) {
      throw new Error("Executable could not be found.");
    }

    spawn(resolvedExecutablePath, [], {
      cwd: resolvedFolderPath,
      detached: true,
      stdio: "ignore",
      windowsHide: false
    }).unref();

    await this.logger.info("Launched executable.", {
      folderId: folder.id,
      gameId: folder.gameId,
      executablePath: resolvedExecutablePath
    });
    return { ok: true };
  }

  async validateInstallPath(gameId) {
    const state = await this.getState();
    const game = state.games.find((entry) => entry.id === Number(gameId));
    if (!game) {
      throw new Error("Game not found.");
    }

    const expectedRoot = state.settings.installRoot ? buildInstallDirectory(state.settings.installRoot, game.title) : "";
    const actualRoot = this.resolveGameRootPath(game, state.settings.installRoot);
    let exists = false;

    if (actualRoot) {
      try {
        await fs.access(actualRoot);
        exists = true;
      } catch {
        exists = false;
      }
    }

    return {
      gameId: game.id,
      installPath: game.installPath || "",
      actualRoot,
      expectedRoot,
      exists,
      expected: expectedRoot ? isExpectedGameInstallPath(state.settings.installRoot, game.title, actualRoot || game.installPath) : false,
      suggestedPath: expectedRoot,
      reason: !state.settings.installRoot
        ? "Install root is not configured."
        : actualRoot
          ? "Install path is not under the expected game subfolder structure."
          : "No managed install root exists for this game."
    };
  }

  async moveInstallPathToExpected(gameId) {
    await this.logger.info("Moving install path to expected location.", { gameId: Number(gameId) });
    const validation = await this.validateInstallPath(gameId);
    if (validation.expected) {
      return this.db.getGameById(Number(gameId));
    }
    if (!validation.actualRoot || !validation.exists) {
      throw new Error("The current game root does not exist.");
    }

    const sourceResolved = path.resolve(validation.actualRoot);
    const destinationResolved = path.resolve(validation.suggestedPath);

    if (sourceResolved === destinationResolved) {
      return this.db.getGameById(Number(gameId));
    }

    await fs.mkdir(path.dirname(destinationResolved), { recursive: true });
    await this.movePath(sourceResolved, destinationResolved);
    await this.logger.info("Moved install path.", {
      gameId: Number(gameId),
      sourceResolved,
      destinationResolved
    });

    const game = this.db.getGameById(Number(gameId));
    await this.syncGameFolders(game.id, {
      game,
      rootOverride: destinationResolved
    });
    this.emitChange();
    return this.db.getGameById(Number(gameId));
  }

  async movePath(sourcePath, destinationPath) {
    try {
      await fs.rename(sourcePath, destinationPath);
    } catch (error) {
      if (error.code !== "EXDEV") {
        throw error;
      }
      await fs.cp(sourcePath, destinationPath, { recursive: true });
      await fs.rm(sourcePath, { recursive: true, force: true });
    }
  }

  async applyRuntimeSettings(settings) {
    await this.folderWatcher.start(settings.watchFolder);
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

  async addThread(threadUrl) {
    const normalizedUrl = normalizeThreadUrl(threadUrl);
    await this.logger.info("Adding thread.", { threadUrl: normalizedUrl });
    const auth = await this.getAuthState();
    if (!auth.loggedIn) {
      throw new Error("Please log in to F95Zone first.");
    }
    const thread = await this.fetcher.fetchThread(normalizedUrl);
    const parsed = parseThread(thread.html, thread.url);
    const enriched = await this.hydrateThreadAssets(parsed);
    const game = await this.db.upsertGameFromThread(enriched);
    await this.ensureGameRootForGame(game);
    await this.syncGameFolders(game.id, { game: this.db.getGameById(game.id) });
    this.emitChange();
    await this.logger.info("Thread added.", { gameId: game.id, title: game.title });
    return this.db.getGameById(game.id);
  }

  async refreshGame(gameId) {
    const game = this.db.getGameById(gameId);
    const refreshMetadata = this.db.getGameRefreshMetadata(gameId);
    if (!game) {
      throw new Error("Game not found.");
    }
    await this.logger.info("Refreshing game.", { gameId: Number(gameId), title: game.title });
    try {
      const auth = await this.getAuthState();
      if (!auth.loggedIn) {
        throw new Error("Please log in to F95Zone first.");
      }
      const thread = await this.fetcher.fetchThread(game.threadUrl);
      const parsed = parseThread(thread.html, thread.url);
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
      await this.ensureGameRootForGame(updated);
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
    for (const game of games) {
      try {
        await this.refreshGame(game.id);
      } catch (error) {
        await this.logger.warn("Background refresh skipped failed game.", {
          gameId: game.id,
          title: game.title,
          message: error.message
        });
        // Keep background refresh resilient per game.
      }
    }
    await this.logger.info("Finished refreshing all games.", { count: games.length });
    return this.getState();
  }

  async pruneMissingArchiveJobs() {
    const jobsWithPaths = this.db.listArchiveJobs().filter((job) => job.archivePath);
    let changed = false;

    for (const job of jobsWithPaths) {
      try {
        await fs.access(job.archivePath);
      } catch {
        await this.db.deleteArchiveJob(job.id);
        changed = true;
      }
    }

    if (changed) {
      this.emitChange();
    }
  }

  async deleteArchiveFile(jobId) {
    const job = this.db.listArchiveJobs().find((entry) => entry.id === Number(jobId));
    if (!job) {
      throw new Error("Archive job not found.");
    }

    this.cancelProcessedArchiveRemoval(job.id);

    if (job.archivePath) {
      await fs.unlink(job.archivePath).catch((error) => {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      });
    }

    await this.db.deleteArchiveJob(job.id);
    this.emitChange();
    return this.getState();
  }

  scheduleProcessedArchiveRemoval(jobId, delayMs = 10000) {
    this.cancelProcessedArchiveRemoval(jobId);
    const timer = setTimeout(async () => {
      try {
        const job = this.db.listArchiveJobs().find((entry) => entry.id === Number(jobId));
        if (!job || job.status !== "processed") {
          return;
        }
        await this.db.deleteArchiveJob(job.id);
        this.emitChange();
      } catch (error) {
        await this.logger.warn("Failed to prune processed archive job after delay.", {
          jobId: Number(jobId),
          message: error.message
        });
      } finally {
        this.processedArchiveRemovalTimers.delete(Number(jobId));
      }
    }, delayMs);
    this.processedArchiveRemovalTimers.set(Number(jobId), timer);
  }

  cancelProcessedArchiveRemoval(jobId) {
    const timer = this.processedArchiveRemovalTimers.get(Number(jobId));
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.processedArchiveRemovalTimers.delete(Number(jobId));
  }

  async processArchive({ archivePath, archiveName, archiveHash, gameId = null, detectedVersion = null, autoExtract = false }) {
    await this.logger.info("Processing detected archive.", {
      archiveName,
      archivePath,
      gameId: gameId ? Number(gameId) : null,
      detectedVersion: detectedVersion || null,
      autoExtract: Boolean(autoExtract)
    });
    const existing = this.db.findArchiveJobByPath(archivePath, archiveName);
    if (existing && existing.archive_hash === archiveHash && ["queued", "needs-review", "unmatched", "processing", "processed"].includes(existing.status)) {
      return existing;
    }

    const games = this.db.getGames();
    const match = findBestGameMatch(archiveName, games);
    const forcedGame = gameId ? games.find((entry) => entry.id === Number(gameId)) : null;
    const payload = {
      archivePath,
      archiveName,
      archiveHash,
      gameId: forcedGame?.id || match.bestMatch?.gameId || null,
      detectedVersion: detectedVersion || match.bestMatch?.version || forcedGame?.currentVersion || null,
      status:
        forcedGame
          ? "queued"
          : match.kind === "matched"
          ? "queued"
          : match.kind === "needs-review"
            ? "needs-review"
            : "unmatched",
      confidence: match.confidence || "low",
      matchCandidates: match.candidates || []
    };

    let job;
    if (existing) {
      this.cancelProcessedArchiveRemoval(existing.id);
      job = await this.db.updateArchiveJob(existing.id, {
        archiveHash,
        gameId: payload.gameId,
        detectedVersion: payload.detectedVersion,
        status: payload.status,
        confidence: payload.confidence,
        matchCandidates: payload.matchCandidates,
        errorText: null
      });
    } else {
      job = await this.db.createArchiveJob(payload);
    }

    if (!job) {
      throw new Error("Archive job could not be persisted.");
    }

    this.emitChange();
    await this.logger.info("Archive job updated.", {
      archiveName,
      status: job.status,
      jobId: job.id
    });

    if (autoExtract && payload.gameId && job.status === "queued") {
      await this.extractJob(job.id, payload.gameId, payload.detectedVersion);
      return this.db.findArchiveJobByPath(archivePath, archiveName) || job;
    }

    return job;
  }

  async resolveArchiveMatch({ jobId, action, gameId }) {
    await this.logger.info("Resolving archive job.", {
      jobId: Number(jobId),
      action,
      gameId: gameId ? Number(gameId) : null
    });
    const job = this.db.listArchiveJobs().find((entry) => entry.id === Number(jobId));
    if (!job) {
      throw new Error("Archive job not found.");
    }

    if (!gameId) {
      throw new Error("A game selection is required.");
    }

    if (action === "accept") {
      await this.db.appendAlias(gameId, job.archiveName);
      await this.extractJob(job.id, gameId, job.detectedVersion);
      this.emitChange();
      return this.getState();
    }

    throw new Error("Unsupported archive action.");
  }

  async extractJob(jobId, gameId, detectedVersion) {
    await this.logger.info("Starting archive extraction.", {
      jobId: Number(jobId),
      gameId: Number(gameId),
      detectedVersion: detectedVersion || null
    });
    const state = await this.getState();
    const job = state.archiveJobs.find((entry) => entry.id === Number(jobId));
    const game = state.games.find((entry) => entry.id === Number(gameId));
    if (!job || !game) {
      throw new Error("Could not prepare extraction.");
    }

    if (!state.settings.installRoot) {
      await this.db.updateArchiveJob(job.id, {
        status: "failed",
        errorText: "Install root is not configured."
      });
      return;
    }

    try {
      const installDirectory = buildInstallDirectory(state.settings.installRoot, game.title);
      await fs.mkdir(installDirectory, { recursive: true });
      const archiveHasSingleRootFolder = await this.archiveHasSingleRootDirectory(job.archivePath);
      const versionForFolder = sanitizePathSegment(detectedVersion || game.currentVersion || "files");
      const targetDirectory = archiveHasSingleRootFolder
        ? installDirectory
        : buildVersionedInstallDirectory(installDirectory, game.title, versionForFolder);
      const archiveStats = await fs.stat(job.archivePath);
      const startedAt = new Date().toISOString();
      this.lastExtractionProgressLogAt = 0;
      this.currentExtraction = {
        jobId: job.id,
        archiveName: job.archiveName,
        archivePath: job.archivePath,
        startedAt,
        estimatedTotalMs: this.estimateExtractionDurationMs(job.archivePath, archiveStats.size),
        archiveSizeBytes: archiveStats.size,
        currentFile: "",
        processedFiles: 0,
        totalFiles: 0
      };
      await this.db.updateArchiveJob(job.id, {
        status: "processing",
        gameId,
        detectedVersion
      });
      this.emitChange();

      await fs.mkdir(targetDirectory, { recursive: true });
      await this.logger.info("Archive extraction prepared.", {
        jobId: job.id,
        gameId,
        archivePath: job.archivePath,
        archiveSizeBytes: archiveStats.size,
        archiveHasSingleRootFolder,
        installDirectory,
        targetDirectory,
        detectedVersion: detectedVersion || null
      });
      this.activeExtractionHandle = this.extractArchiveWithProgress(job.archivePath, targetDirectory, (progress) => {
        this.updateExtractionProgress(progress);
      });
      await this.activeExtractionHandle.completion;
      const finishedAt = Date.now();
      const startedAtMs = new Date(startedAt).getTime();
      await this.db.updateArchiveJob(job.id, {
        status: "processed",
        gameId,
        detectedVersion,
        extractedTo: targetDirectory,
        errorText: null
      });
      this.scheduleProcessedArchiveRemoval(job.id);
      await fs.unlink(job.archivePath).catch(() => {});
      await this.syncGameFolders(gameId, { game, rootOverride: installDirectory });
      await this.logger.info("Archive extraction completed.", {
        jobId: job.id,
        gameId,
        archivePath: job.archivePath,
        targetDirectory,
        elapsedMs: Number.isFinite(startedAtMs) ? Math.max(0, finishedAt - startedAtMs) : null,
        processedFiles: this.currentExtraction?.processedFiles || 0,
        totalFiles: this.currentExtraction?.totalFiles || 0
      });
    } catch (error) {
      this.cancelProcessedArchiveRemoval(job.id);
      await this.db.updateArchiveJob(job.id, {
        status: "failed",
        gameId,
        detectedVersion,
        errorText: error.message
      });
      await this.logger.error("Archive extraction failed.", {
        jobId: job.id,
        gameId,
        message: error.message
      });
    } finally {
      this.activeExtractionHandle = null;
      this.currentExtraction = null;
      this.emitChange();
    }
  }

  estimateExtractionDurationMs(archivePath, sizeBytes) {
    const extension = path.extname(archivePath).toLowerCase();
    const sizeMb = Math.max(1, sizeBytes / (1024 * 1024));
    const msPerMb = extension === ".rar" ? 140 : extension === ".7z" ? 125 : 95;
    return Math.round(3500 + sizeMb * msPerMb);
  }

  updateExtractionProgress(progress) {
    if (!this.currentExtraction) {
      return;
    }

    const now = Date.now();
    const elapsedMs = Date.now() - new Date(this.currentExtraction.startedAt).getTime();
    const processedFiles = Number(progress.processedFiles || 0);
    const totalFiles = Number(progress.totalFiles || 0);
    const estimatedRemainingMs =
      processedFiles > 0 && totalFiles > 0
        ? Math.max(0, Math.round((elapsedMs / processedFiles) * (totalFiles - processedFiles)))
        : this.currentExtraction.estimatedTotalMs;

    this.currentExtraction = {
      ...this.currentExtraction,
      currentFile: progress.currentFile || this.currentExtraction.currentFile,
      processedFiles,
      totalFiles,
      estimatedRemainingMs
    };
    const shouldEmit =
      processedFiles >= totalFiles ||
      now - this.lastExtractionProgressEmitAt >= EXTRACTION_PROGRESS_EMIT_INTERVAL_MS;
    const shouldLogProgress =
      processedFiles > 0 &&
      (processedFiles >= totalFiles ||
        now - this.lastExtractionProgressLogAt >= EXTRACTION_PROGRESS_LOG_INTERVAL_MS);

    if (shouldEmit) {
      this.lastExtractionProgressEmitAt = now;
      this.emitChange();
    }

    if (shouldLogProgress) {
      this.lastExtractionProgressLogAt = now;
      this.logger.info("Archive extraction progress.", {
        jobId: this.currentExtraction.jobId,
        archiveName: this.currentExtraction.archiveName,
        currentFile: this.currentExtraction.currentFile || "",
        processedFiles,
        totalFiles,
        estimatedRemainingMs
      }).catch(() => {});
    }
  }

  async hydrateThreadAssets(parsedThread, existingAssets = null) {
    const warnings = [...(parsedThread.warnings || [])];
    let bannerImage = null;
    const screenshotImages = [];

    if (parsedThread.bannerImageUrl) {
      try {
        bannerImage = await this.resolveThreadAsset(parsedThread.bannerImageUrl, "banner", existingAssets?.bannerImage || null);
      } catch (error) {
        warnings.push(`Banner image could not be downloaded: ${error.message}`);
      }
    }

    const existingScreenshots = new Map(
      (existingAssets?.screenshotImages || [])
        .filter((asset) => asset?.sourceUrl && asset?.localPath)
        .map((asset) => [asset.sourceUrl, asset])
    );

    for (const screenshotUrl of parsedThread.screenshotImageUrls || []) {
      try {
        screenshotImages.push(
          await this.resolveThreadAsset(screenshotUrl, "screenshot", existingScreenshots.get(screenshotUrl) || null)
        );
      } catch (error) {
        warnings.push(`Screenshot could not be downloaded: ${error.message}`);
      }
    }

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
      await this.logger.info("Reused cached asset.", {
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
    await this.logger.info("Downloaded asset.", {
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

  listDownloadJobs() {
    return [...this.downloadJobs].sort((left, right) => {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });
  }

  async ensureDownloadReady() {
    const settings = this.db.getSettings();
    const configuredPath = String(settings.watchFolder || "").trim();
    if (!configuredPath) {
      throw new Error("Please configure a watch folder before starting downloads.");
    }

    const watchFolder = path.resolve(configuredPath);
    await fs.mkdir(watchFolder, { recursive: true });
    return watchFolder;
  }

  createDownloadJob({ gameId, linkId = null, url, label = "", detectedVersion = "" }) {
    const sourceUrl = String(url || "").trim();
    if (!/^https?:/i.test(sourceUrl)) {
      throw new Error("Download url must be absolute.");
    }

    const job = {
      id: this.nextDownloadJobId++,
      gameId: Number(gameId) || null,
      linkId: linkId == null ? null : Number(linkId),
      sourceUrl,
      resolvedUrl: "",
      host: this.getDownloadHost(sourceUrl),
      label: String(label || "").trim(),
      detectedVersion: String(detectedVersion || "").trim() || null,
      fileName: "",
      targetPath: "",
      bytesReceived: 0,
      bytesTotal: 0,
      speedBytesPerSecond: 0,
      status: "opening_host",
      errorMessage: "",
      startedAt: "",
      completedAt: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.downloadJobs = [...this.downloadJobs, job];
    this.emitChange();
    return job;
  }

  updateDownloadJob(jobId, updates = {}) {
    let nextJob = null;
    this.downloadJobs = this.downloadJobs.map((entry) => {
      if (entry.id !== Number(jobId)) {
        return entry;
      }

      nextJob = {
        ...entry,
        ...updates,
        updatedAt: new Date().toISOString()
      };
      return nextJob;
    });

    if (nextJob) {
      this.emitChange();
    }

    return nextJob;
  }

  getDownloadJob(jobId) {
    return this.downloadJobs.find((entry) => entry.id === Number(jobId)) || null;
  }

  markDownloadAwaiting(jobId) {
    return this.updateDownloadJob(jobId, {
      status: "awaiting_download",
      speedBytesPerSecond: 0,
      errorMessage: ""
    });
  }

  cancelDownloadJob(jobId, errorMessage = "Download window was closed before a file download started.") {
    const job = this.getDownloadJob(jobId);
    if (!job) {
      return null;
    }

    if (["completed", "failed", "canceled"].includes(job.status)) {
      return job;
    }

    const controller = this.activeDownloadControllers.get(job.id);
    if (controller) {
      controller.abort();
      this.activeDownloadControllers.delete(job.id);
    }

    return this.updateDownloadJob(jobId, {
      status: "canceled",
      speedBytesPerSecond: 0,
      errorMessage
    });
  }

  failDownloadJob(jobId, error) {
    const message = error?.message || String(error || "Download failed.");
    this.activeDownloadControllers.delete(Number(jobId));
    return this.updateDownloadJob(jobId, {
      status: "failed",
      speedBytesPerSecond: 0,
      errorMessage: message
    });
  }

  getDownloadHost(downloadUrl) {
    try {
      return new URL(downloadUrl).host;
    } catch {
      return "";
    }
  }

  isProbableFileDownloadUrl(downloadUrl) {
    try {
      const parsed = new URL(downloadUrl);
      const extension = path.extname(parsed.pathname || "").toLowerCase();
      return DOWNLOADABLE_FILE_EXTENSIONS.has(extension);
    } catch {
      return false;
    }
  }

  async startResolvedDownload(jobId, options = {}) {
    const job = this.getDownloadJob(jobId);
    if (!job) {
      throw new Error("Download job not found.");
    }

    const controller = new AbortController();
    this.activeDownloadControllers.set(job.id, controller);

    try {
      await this.ensureDownloadReady();
      this.updateDownloadJob(job.id, {
        status: "resolving",
        resolvedUrl: String(options.url || job.sourceUrl || "").trim(),
        errorMessage: ""
      });

      const response = await fetch(String(options.url || job.sourceUrl || "").trim(), {
        headers: this.buildResolvedDownloadHeaders(options),
        redirect: "follow",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Download request failed with status ${response.status}`);
      }

      const resolvedUrl = response.url || String(options.url || job.sourceUrl || "").trim();
      const watchFolder = await this.ensureDownloadReady();
      const fileName = this.resolveDownloadFileName({
        preferredFileName: options.fileName,
        resolvedUrl,
        contentDisposition: response.headers.get("content-disposition") || ""
      });
      const targetPath = await this.reserveDownloadTargetPath(watchFolder, fileName);
      const tempPath = `${targetPath}.part`;
      const bytesTotal = Number(response.headers.get("content-length") || 0);

      this.updateDownloadJob(job.id, {
        status: "downloading",
        resolvedUrl,
        host: this.getDownloadHost(resolvedUrl),
        fileName,
        targetPath,
        bytesReceived: 0,
        bytesTotal: Number.isFinite(bytesTotal) ? bytesTotal : 0,
        speedBytesPerSecond: 0,
        startedAt: new Date().toISOString(),
        completedAt: ""
      });

      await this.streamResponseToFile(response, tempPath, {
        jobId: job.id,
        bytesTotal,
        signal: controller.signal
      });

      await fs.rename(tempPath, targetPath);
      this.activeDownloadControllers.delete(job.id);
      this.updateDownloadJob(job.id, {
        status: "completed",
        resolvedUrl,
        fileName,
        targetPath,
        bytesReceived: bytesTotal || this.getDownloadJob(job.id)?.bytesReceived || 0,
        bytesTotal: bytesTotal || this.getDownloadJob(job.id)?.bytesReceived || 0,
        speedBytesPerSecond: this.getDownloadJob(job.id)?.speedBytesPerSecond || 0,
        completedAt: new Date().toISOString(),
        errorMessage: ""
      });

      await this.logger.info("Resolved file download completed.", {
        jobId: job.id,
        sourceUrl: job.sourceUrl,
        resolvedUrl,
        targetPath
      });

      if (job.gameId) {
        this.folderWatcher.ignoreFile(targetPath, 45000);
        await this.processArchive({
          archivePath: targetPath,
          archiveName: fileName,
          archiveHash: null,
          gameId: job.gameId,
          detectedVersion: job.detectedVersion || null,
          autoExtract: true
        });
      }

      return this.getDownloadJob(job.id);
    } catch (error) {
      this.activeDownloadControllers.delete(job.id);
      if (error?.name === "AbortError") {
        this.cancelDownloadJob(job.id, "Download canceled.");
      } else {
        this.failDownloadJob(job.id, error);
      }
      throw error;
    }
  }

  buildResolvedDownloadHeaders(options = {}) {
    const headers = {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36"
    };

    if (options.cookieHeader) {
      headers.cookie = options.cookieHeader;
    }

    if (options.referrer) {
      headers.referer = options.referrer;
      headers.referrer = options.referrer;
    }

    return headers;
  }

  async streamResponseToFile(response, filePath, { jobId, bytesTotal = 0, signal } = {}) {
    const fileHandle = await fs.open(filePath, "w");
    let bytesReceived = 0;
    let lastEmitAt = 0;
    let completed = false;
    const startedAt = Date.now();

    try {
      if (!response.body || typeof response.body.getReader !== "function") {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (signal?.aborted) {
          const error = new Error("Download canceled.");
          error.name = "AbortError";
          throw error;
        }
        await fileHandle.writeFile(buffer);
        bytesReceived = buffer.length;
        this.updateDownloadJob(jobId, {
          bytesReceived,
          bytesTotal: bytesTotal || buffer.length,
          speedBytesPerSecond: bytesReceived
        });
        completed = true;
        return;
      }

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          break;
        }

        if (signal?.aborted) {
          const error = new Error("Download canceled.");
          error.name = "AbortError";
          throw error;
        }

        const chunk = Buffer.from(value);
        await fileHandle.write(chunk, 0, chunk.length);
        bytesReceived += chunk.length;

        const now = Date.now();
        if (now - lastEmitAt >= DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS) {
          lastEmitAt = now;
          const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
          this.updateDownloadJob(jobId, {
            bytesReceived,
            bytesTotal: bytesTotal || 0,
            speedBytesPerSecond: bytesReceived / elapsedSeconds
          });
        }
      }

      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      this.updateDownloadJob(jobId, {
        bytesReceived,
        bytesTotal: bytesTotal || bytesReceived,
        speedBytesPerSecond: bytesReceived / elapsedSeconds
      });
    } finally {
      await fileHandle.close();
      if (!completed) {
        await fs.unlink(filePath).catch(() => {});
      }
    }
  }

  resolveDownloadFileName({ preferredFileName, resolvedUrl, contentDisposition }) {
    const explicit = this.sanitizeDownloadFileName(preferredFileName);
    if (explicit) {
      return explicit;
    }

    const fromDisposition = this.sanitizeDownloadFileName(this.extractFileNameFromContentDisposition(contentDisposition));
    if (fromDisposition) {
      return fromDisposition;
    }

    try {
      const parsed = new URL(resolvedUrl);
      const fromPath = this.sanitizeDownloadFileName(decodeURIComponent(path.basename(parsed.pathname || "")));
      if (fromPath) {
        return fromPath;
      }
    } catch {
      // Ignore invalid urls and fall through to default file name.
    }

    return "download.bin";
  }

  sanitizeDownloadFileName(fileName) {
    const normalized = path.basename(String(fileName || "").trim()).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
    return normalized || "";
  }

  extractFileNameFromContentDisposition(contentDisposition) {
    const header = String(contentDisposition || "");
    const starMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (starMatch?.[1]) {
      return decodeURIComponent(starMatch[1]);
    }

    const plainMatch = header.match(/filename="?([^\";]+)"?/i);
    return plainMatch?.[1] || "";
  }

  async reserveDownloadTargetPath(folderPath, fileName) {
    const parsed = path.parse(fileName);
    let candidate = path.join(folderPath, fileName);
    let counter = 1;

    while (await this.assetExists(candidate)) {
      candidate = path.join(folderPath, `${parsed.name} (${counter})${parsed.ext}`);
      counter += 1;
    }

    return candidate;
  }

  emitChange() {
    this.onStateChanged?.();
  }

  async getAuthState() {
    const cookies = await this.authSession.cookies.get({ domain: "f95zone.to" });
    const cookieMap = new Map(cookies.map((cookie) => [cookie.name, cookie.value]));
    const loggedIn = cookieMap.has("xf_user");
    return {
      loggedIn,
      hasSessionCookie: cookieMap.has("xf_session"),
      hasUserCookie: cookieMap.has("xf_user")
    };
  }

  async verifyAuth() {
    const auth = await this.getAuthState();
    const response = await this.fetcher.fetchUrl("https://f95zone.to/account/");
    const html = response.html || "";
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
      ok: auth.loggedIn && !redirectedToLogin && !loginFormVisible
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

  async dispose() {
    await this.logger.info("Disposing application service.");
    if (this.activeExtractionHandle?.terminate) {
      this.activeExtractionHandle.terminate();
      this.activeExtractionHandle = null;
    }
    for (const controller of this.activeDownloadControllers.values()) {
      controller.abort();
    }
    this.activeDownloadControllers.clear();
    for (const timer of this.processedArchiveRemovalTimers.values()) {
      clearTimeout(timer);
    }
    this.processedArchiveRemovalTimers.clear();
    this.downloadJobs = this.downloadJobs.map((job) => {
      if (["downloading", "resolving", "opening_host", "awaiting_download"].includes(job.status)) {
        return {
          ...job,
          status: "canceled",
          errorMessage: "Download was interrupted when the app closed.",
          updatedAt: new Date().toISOString()
        };
      }
      return job;
    });
    this.scheduler.stop();
    this.stopManagedFolderMonitor();
    this.stopBackupScheduler();
    await this.folderWatcher.stop();
    if (this.currentExtraction?.jobId) {
      await this.db.updateArchiveJob(this.currentExtraction.jobId, {
        status: "queued",
        errorText: "Extraction was interrupted when the app closed."
      });
      this.currentExtraction = null;
    }
    await this.logger.info("Application service disposed.");
  }

  async syncAllManagedFolders() {
    const settings = this.db.getSettings();
    if (!settings.installRoot) {
      return false;
    }

    let changed = false;
    const games = this.db.getGames();
    for (const game of games) {
      changed = (await this.syncGameFolders(game.id, { game })) || changed;
    }
    return changed;
  }

  async syncGameFolders(gameId, options = {}) {
    const game = options.game || this.db.getGameById(Number(gameId));
    if (!game) {
      return false;
    }

    const settings = this.db.getSettings();
    if (!settings.installRoot) {
      return false;
    }

    const rootCandidates = options.rootOverride
      ? [path.resolve(options.rootOverride)]
      : this.getManagedGameRootCandidates(game, settings.installRoot);
    const existingFolders = this.db.listGameFolders(game.id);
    let gameRoot = rootCandidates[0] || buildInstallDirectory(settings.installRoot, game.title);
    let directSubdirectories = [];

    for (const candidate of rootCandidates) {
      try {
        directSubdirectories = await this.listDirectSubdirectories(candidate);
        gameRoot = candidate;
        break;
      } catch {
        directSubdirectories = [];
      }
    }

    const existingByPath = new Map(existingFolders.map((folder) => [path.resolve(folder.folderPath), folder]));
    const nextFolders = directSubdirectories.map((entry) => {
      const resolvedPath = path.resolve(entry.folderPath);
      const existing = existingByPath.get(resolvedPath);
      const inferredVersion = extractVersionFromFilename(entry.folderName, {
        currentVersion: game.currentVersion,
        installedVersion: game.installedVersion
      });
      const isManual = existing?.versionSource === "manual";
      return {
        folderName: entry.folderName,
        folderPath: resolvedPath,
        version: isManual ? existing.version : inferredVersion,
        versionSource: isManual ? "manual" : "inferred",
        seasonNumber: existing?.seasonNumber ?? null,
        seasonFinal: existing?.seasonFinal ?? false,
        preferredExePath: existing?.preferredExePath ?? null,
        createdAt: existing?.createdAt,
        updatedAt: existing?.updatedAt
      };
    });

    const beforeFolders = existingFolders.map((folder) => ({
      folderPath: path.resolve(folder.folderPath),
      folderName: folder.folderName,
      version: folder.version,
      versionSource: folder.versionSource,
      seasonNumber: folder.seasonNumber,
      seasonFinal: folder.seasonFinal,
      sortRank: folder.sortRank
    }));
    const beforeGame = this.db.getGameById(game.id);

    await this.db.replaceGameFolders(game.id, nextFolders);
    const syncedFolders = this.db.listGameFolders(game.id);
    const missingRanks = syncedFolders.some((folder) => !Number.isFinite(Number(folder.sortRank)));
    const changedMembership =
      beforeFolders.length !== syncedFolders.length ||
      beforeFolders.some((folder) => !syncedFolders.some((entry) => entry.folderPath === folder.folderPath));
    const rankedFolders = missingRanks || changedMembership
      ? await this.db.recalculateGameFolderRanks(game.id, {
          game: this.db.getGameById(game.id),
          folders: syncedFolders
        })
      : syncedFolders;
    const updatedGame = await this.db.applyDerivedInstallState(game.id, rankedFolders, {
      installPath: nextFolders[0]?.folderPath || null
    });

    const afterFolders = rankedFolders.map((folder) => ({
      folderPath: path.resolve(folder.folderPath),
      folderName: folder.folderName,
      version: folder.version,
      versionSource: folder.versionSource,
      seasonNumber: folder.seasonNumber,
      seasonFinal: folder.seasonFinal,
      sortRank: folder.sortRank
    }));

    return (
      JSON.stringify(beforeFolders) !== JSON.stringify(afterFolders) ||
      (beforeGame?.installedVersion || null) !== (updatedGame?.installedVersion || null) ||
      (beforeGame?.installPath || null) !== (updatedGame?.installPath || null)
    );
  }

  async ensureGameRootForGame(game) {
    const settings = this.db.getSettings();
    if (!settings.installRoot || !game?.title) {
      return null;
    }

    const gameRoot = buildInstallDirectory(settings.installRoot, game.title);
    await fs.mkdir(gameRoot, { recursive: true });
    return gameRoot;
  }

  async ensureAllGameRoots() {
    const settings = this.db.getSettings();
    if (!settings.installRoot) {
      return;
    }

    const games = this.db.getGames();
    for (const game of games) {
      await this.ensureGameRootForGame(game);
    }
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
    await fs.mkdir(this.backupPath, { recursive: true });
    const snapshot = this.db.exportSnapshot();
    const safeTimestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\./g, "-");
    const filePath = path.join(this.backupPath, `backup-${safeTimestamp}.json`);
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), "utf8");
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
      await this.ensureAllGameRoots();
      const changed = await this.syncAllManagedFolders();
      if (changed && emitOnChange) {
        this.emitChange();
      }
      return changed;
    } finally {
      this.folderSyncInFlight = false;
    }
  }

  async listDirectSubdirectories(rootPath) {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        folderName: entry.name,
        folderPath: path.join(rootPath, entry.name)
      }))
      .sort((left, right) => left.folderName.localeCompare(right.folderName, undefined, { sensitivity: "base" }));
  }

  resolveGameRootPath(game, installRoot) {
    if (game.folders?.length) {
      return path.dirname(game.folders[0].folderPath);
    }

    if (!game.installPath) {
      return installRoot && game.title ? buildInstallDirectory(installRoot, game.title) : "";
    }

    const installPath = path.resolve(game.installPath);
    const base = path.basename(installPath).toLowerCase();
    const titleSegment = sanitizePathSegment(game.title || "").toLowerCase();
    if (base === titleSegment) {
      return installPath;
    }

    if (installRoot && game.title && isExpectedGameInstallPath(installRoot, game.title, installPath)) {
      return path.dirname(installPath);
    }

    return path.dirname(installPath);
  }

  getManagedGameRootCandidates(game, installRoot) {
    const candidates = buildGameRootCandidates(installRoot, game.title).map((entry) => path.resolve(entry));
    const actualRoot = this.resolveGameRootPath(game, installRoot);
    if (actualRoot) {
      const resolvedRoot = path.resolve(actualRoot);
      if (!candidates.includes(resolvedRoot)) {
        candidates.unshift(resolvedRoot);
      }
    }
    return candidates;
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

module.exports = {
  AppService
};
