const fs = require("fs/promises");
const path = require("path");
const { assertNoLinks, assertSafeTree, assertManagedInstallPath, isWithin } = require("./safeFiles");
const { extractVersionFromFilename } = require("./matcher");
const { buildGameRootCandidates, buildInstallDirectory, isExpectedGameInstallPath, rankLaunchExecutables, sanitizePathSegment, sanitizeVersion } = require("./utils");
const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

// Shared application state and facade calls are supplied by AppService.
class InstallationService {
  constructor(app) { this.app = app; }
  async setInstalledVersion(gameId, installedVersion, installPath) {
    await this.app.logger.info("Setting installed version.", {
      gameId: Number(gameId),
      installedVersion: installedVersion || null,
      installPath: installPath || null
    });
    const game = this.app.db.getGameById(gameId);
    if (!game) {
      throw new Error("Game not found.");
    }

    const normalized = sanitizeVersion(installedVersion) || null;
    const folders = this.app.db.listGameFolders(game.id);
    if (folders.length > 0) {
      const targetFolder =
        folders.find((folder) => folder.folderPath === installPath) ||
        folders.find((folder) => folder.id === game.primaryFolderId) ||
        folders[0];
      await this.app.db.updateGameFolderVersion(targetFolder.id, normalized, "manual");
      const nextFolders = this.app.db.listGameFolders(game.id);
      const rankedFolders = await this.app.db.recalculateGameFolderRanks(game.id, { game, folders: nextFolders });
      const updatedGame = await this.app.db.applyDerivedInstallState(game.id, rankedFolders, {
        installPath: game.installPath || null
      });
      this.app.emitChange();
      return updatedGame;
    }

    const nextInstallPath = installPath !== undefined ? installPath || null : game.installPath || null;
    const updatedGame = await this.app.db.updateInstalledVersion(gameId, normalized, nextInstallPath);
    this.app.emitChange();
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
    await this.app.syncGameFolders(gameId);
    return this.app.db.listGameFolders(Number(gameId));
  }

  resolveFolderReference(folderRef) {
    if (folderRef && typeof folderRef === "object") {
      const byId = folderRef.folderId ? this.app.db.getGameFolder(Number(folderRef.folderId)) : null;
      if (byId) {
        return byId;
      }

      if (folderRef.gameId && folderRef.folderPath) {
        return this.app.db.findGameFolderByPath(Number(folderRef.gameId), path.resolve(String(folderRef.folderPath)));
      }
      return null;
    }

    return this.app.db.getGameFolder(Number(folderRef));
  }

  async updateGameFolderVersion(folderRef, versionArg) {
    const version = folderRef && typeof folderRef === "object" ? folderRef.version : versionArg;
    const folder = this.app.resolveFolderReference(folderRef);
    if (!folder) {
      throw new Error("Game folder not found.");
    }

    await this.app.logger.info("Updating game folder version.", {
      folderId: folder.id,
      gameId: folder.gameId,
      version: sanitizeVersion(version) || null
    });

    await this.app.db.updateGameFolderVersion(folder.id, sanitizeVersion(version) || null, "manual");
    const game = this.app.db.getGameById(folder.gameId);
    const folders = await this.app.db.recalculateGameFolderRanks(folder.gameId, { game });
    await this.app.db.applyDerivedInstallState(folder.gameId, folders, {
      installPath: game?.installPath || null
    });
    this.app.emitChange();
    return this.app.db.getGameById(folder.gameId);
  }

  async updateGameSeasons(gameId, hasSeasons) {
    await this.app.logger.info("Updating game season mode.", {
      gameId: Number(gameId),
      hasSeasons: Boolean(hasSeasons)
    });
    const game = this.app.db.getGameById(Number(gameId));
    if (!game) {
      throw new Error("Game not found.");
    }

    const updatedGame = await this.app.db.updateGameSeasons(game.id, Boolean(hasSeasons));
    const folders = await this.app.db.recalculateGameFolderRanks(game.id, { game: updatedGame });
    await this.app.db.applyDerivedInstallState(game.id, folders, {
      installPath: updatedGame.installPath || null
    });
    this.app.emitChange();
    return this.app.db.getGameById(game.id);
  }

  async updateGameFolderMetadata(folderRef, updates = {}) {
    const folder = this.app.resolveFolderReference(folderRef);
    if (!folder) {
      throw new Error("Game folder not found.");
    }
    await this.app.logger.info("Updating game folder metadata.", {
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

    await this.app.db.updateGameFolderMetadata(folder.id, {
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
      const game = this.app.db.getGameById(folder.gameId);
      const folders = await this.app.db.recalculateGameFolderRanks(folder.gameId, { game });
      await this.app.db.applyDerivedInstallState(folder.gameId, folders, {
        installPath: game?.installPath || null
      });
    }

    this.app.emitChange();
    return this.app.db.getGameById(folder.gameId);
  }

  async deleteGameFolder(folderRef) {
    const folder = this.app.resolveFolderReference(folderRef);
    if (!folder) {
      throw new Error("Game folder not found.");
    }

    await this.app.logger.info("Deleting game folder.", {
      folderId: folder.id,
      gameId: folder.gameId,
      folderPath: folder.folderPath
    });

    this.app.assertGameIdle(folder.gameId);
    const installRoot = this.app.db.getSettings().installRoot;
    const gameRoots = buildGameRootCandidates(installRoot, this.app.db.getGameById(folder.gameId)?.title);
    await assertManagedInstallPath(installRoot, gameRoots, folder.folderPath);
    await assertManagedInstallPath(installRoot, gameRoots, folder.folderPath);
    await fs.rm(folder.folderPath, { recursive: true, force: true });
    await this.app.db.deleteGameFolder(folder.id);
    const game = this.app.db.getGameById(folder.gameId);
    await this.app.syncGameFolders(folder.gameId, { game, skipFsDeleteCheck: true });
    this.app.emitChange();
    return this.app.db.getGameById(folder.gameId);
  }

  async refreshGameFolders(gameId) {
    await this.app.logger.info("Refreshing game folders.", { gameId: Number(gameId) });
    await this.app.syncGameFolders(gameId);
    this.app.emitChange();
    return this.app.db.getGameById(Number(gameId));
  }

  async listLaunchExecutables(folderRef) {
    const folder = this.app.resolveFolderReference(folderRef);
    if (!folder) {
      throw new Error("Game folder not found.");
    }

    const game = this.app.db.getGameById(folder.gameId);
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
    const listed = await this.app.listLaunchExecutables({ folderId: folder.id });
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
      await this.app.db.updateGameFolderMetadata(folder.id, {
        preferredExePath: selectedExecutable.fullPath
      });
    }

    return selectedExecutable.fullPath;
  }

  async launchExecutable(folderRef, executablePathArg) {
    const requestedExecutablePath =
      folderRef && typeof folderRef === "object" ? folderRef.executablePath : executablePathArg;
    const folder = this.app.resolveFolderReference(folderRef);
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
    const executablePath = await this.app.resolveLaunchExecutablePath(folder, requestedExecutablePath);
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

    this.app.launchProcess(resolvedExecutablePath, [], {
      cwd: resolvedFolderPath,
      detached: true,
      stdio: "ignore",
      windowsHide: false
    }).unref();

    await this.app.logger.info("Launched executable.", {
      folderId: folder.id,
      gameId: folder.gameId,
      executablePath: resolvedExecutablePath
    });
    return { ok: true };
  }

  async validateInstallPath(gameId) {
    const state = await this.app.getState();
    const game = state.games.find((entry) => entry.id === Number(gameId));
    if (!game) {
      throw new Error("Game not found.");
    }

    const expectedRoot = state.settings.installRoot ? buildInstallDirectory(state.settings.installRoot, game.title) : "";
    const actualRoot = this.app.resolveGameRootPath(game, state.settings.installRoot);
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
    this.app.assertGameIdle(gameId);
    await this.app.logger.info("Moving install path to expected location.", { gameId: Number(gameId) });
    const validation = await this.app.validateInstallPath(gameId);
    if (validation.expected) {
      return this.app.db.getGameById(Number(gameId));
    }
    if (!validation.actualRoot || !validation.exists) {
      throw new Error("The current game root does not exist.");
    }

    const sourceResolved = path.resolve(validation.actualRoot);
    const destinationResolved = path.resolve(validation.suggestedPath);

    if (sourceResolved === destinationResolved) {
      return this.app.db.getGameById(Number(gameId));
    }

    const installRoot = this.app.db.getSettings().installRoot;
    if (!installRoot || !isWithin(installRoot, sourceResolved) || !isWithin(installRoot, destinationResolved)) {
      throw new Error("Move is only allowed inside the configured install root.");
    }
    await assertNoLinks(sourceResolved);
    await assertNoLinks(destinationResolved);
    if (await this.app.assetExists(destinationResolved)) throw new Error("Destination already exists.");
    await fs.mkdir(path.dirname(destinationResolved), { recursive: true });
    await this.app.movePath(sourceResolved, destinationResolved);
    await this.app.logger.info("Moved install path.", {
      gameId: Number(gameId),
      sourceResolved,
      destinationResolved
    });

    const game = this.app.db.getGameById(Number(gameId));
    await this.app.syncGameFolders(game.id, {
      game,
      rootOverride: destinationResolved
    });
    this.app.emitChange();
    return this.app.db.getGameById(Number(gameId));
  }

  // Checks a folder the user wants to add as an existing installation. Returns the resolved path and name;
  // throws a readable error for anything that must not be registered or moved.
  // With a game, a move is also checked against that game's folder: a folder that is already inside it needs no
  // move (alreadyInPlace), and the game's own folder (or a parent of it) cannot be moved into itself.
  async validateExistingFolder(folderPath, mode = "keep", game = null) {
    const raw = String(folderPath || "").trim();
    if (!raw || !path.isAbsolute(raw)) throw new Error("Choose a folder first.");
    const resolved = path.resolve(raw);
    const stats = await fs.stat(resolved).catch(() => null);
    if (!stats?.isDirectory()) throw new Error("The selected folder does not exist.");
    await assertNoLinks(resolved);
    if (path.parse(resolved).root === resolved) throw new Error("A drive root cannot be added as a game folder.");

    const settings = this.app.db.getSettings();
    const contains = (outer, inner) => pathKey(outer) === pathKey(inner) || isWithin(outer, inner);
    for (const [label, other] of [
      ["install root", settings.installRoot],
      ["watch folder", settings.watchFolder],
      ["application data folder", this.app.userDataPath]
    ]) {
      if (other && contains(resolved, other)) throw new Error(`This folder contains the ${label}; pick the game's own folder instead.`);
    }
    if (settings.watchFolder && contains(settings.watchFolder, resolved)) {
      throw new Error("This folder is inside the watch folder, which is used for downloads and archives.");
    }
    for (const game of this.app.db.getGames()) {
      for (const folder of this.app.db.listGameFolders(game.id)) {
        if (contains(folder.folderPath, resolved) || contains(resolved, folder.folderPath)) {
          throw new Error(`This folder is already part of "${game.title}".`);
        }
      }
    }

    let alreadyInPlace = false;
    if (mode === "move") {
      if (!settings.installRoot) throw new Error("Set an install root in Settings before moving a folder into it.");
      if (game) {
        const gameRoot = path.resolve(buildInstallDirectory(settings.installRoot, game.title));
        if (contains(resolved, gameRoot)) {
          throw new Error(`This is the install folder of "${game.title}" itself (or contains it); pick one of the version folders inside it.`);
        }
        alreadyInPlace = isWithin(gameRoot, resolved);
      }
      if (!alreadyInPlace) {
        // Symbolic links or junctions inside the tree would be copied or broken by a move.
        await assertSafeTree(resolved).catch(() => {
          throw new Error("The folder contains symbolic links or junctions and cannot be moved safely.");
        });
      }
    }
    return { folderPath: resolved, folderName: path.basename(resolved), alreadyInPlace };
  }

  // Registers an existing game folder for a game, optionally moving it into <install root>/<game title>/.
  async addExistingFolder({ folderPath, gameId, mode = "keep" }) {
    const game = this.app.db.getGameById(Number(gameId));
    if (!game) throw new Error("Game not found.");
    const source = await this.app.validateExistingFolder(folderPath, mode, game);
    let finalPath = source.folderPath;
    let rootOverride;

    // The game's folder is only created here, once the move is confirmed and validated.
    if (mode === "move" && !source.alreadyInPlace) {
      this.app.assertGameIdle(game.id);
      const installRoot = this.app.db.getSettings().installRoot;
      const gameRoot = await this.app.ensureGameRootForGame(game);
      const destination = path.join(gameRoot, source.folderName);
      if (!isWithin(installRoot, destination)) throw new Error("Move is only allowed inside the configured install root.");
      await assertNoLinks(destination);
      if (await this.app.assetExists(destination)) {
        throw new Error(`"${source.folderName}" already exists in the game's install folder.`);
      }
      await this.app.logger.info("Moving existing game folder into the install root.", { gameId: game.id, source: source.folderPath, destination });
      try {
        await this.app.movePath(source.folderPath, destination);
      } catch (error) {
        // A cross-drive move copies first; remove the partial copy so nothing half-finished is left behind.
        if (await this.app.assetExists(source.folderPath)) await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
        const reason = ["EBUSY", "EPERM", "EACCES"].includes(error.code)
          ? "Files are in use or protected. Close the game and any open windows for that folder, then try again."
          : error.message;
        throw new Error(`Could not move the folder: ${reason}`);
      }
      finalPath = destination;
      rootOverride = gameRoot;
    }

    const version = extractVersionFromFilename(source.folderName, {
      currentVersion: game.currentVersion,
      installedVersion: game.installedVersion
    });
    await this.app.db.upsertGameFolder(game.id, {
      folderName: source.folderName, folderPath: finalPath, version, versionSource: "inferred"
    });
    await this.app.syncGameFolders(game.id, { game: this.app.db.getGameById(game.id), rootOverride });
    this.app.emitChange();
    await this.app.logger.info("Added existing game folder.", { gameId: game.id, folderPath: finalPath, mode });
    return this.app.db.getGameById(game.id);
  }

  async movePath(sourcePath, destinationPath) {
    try {
      await fs.rename(sourcePath, destinationPath);
    } catch (error) {
      if (error.code !== "EXDEV") {
        throw error;
      }
      await fs.cp(sourcePath, destinationPath, { recursive: true, errorOnExist: true, force: false });
      await assertNoLinks(sourcePath);
      await fs.rm(sourcePath, { recursive: true, force: true });
    }
  }

  async syncAllManagedFolders() {
    const settings = this.app.db.getSettings();
    if (!settings.installRoot) {
      return false;
    }

    let changed = false;
    const games = this.app.db.getGames();
    for (const game of games) {
      changed = (await this.app.syncGameFolders(game.id, { game })) || changed;
    }
    return changed;
  }

  async syncGameFolders(gameId, options = {}) {
    const game = options.game || this.app.db.getGameById(Number(gameId));
    if (!game) {
      return false;
    }

    const settings = this.app.db.getSettings();
    if (!settings.installRoot) {
      return false;
    }

    const rootCandidates = [
      ...(options.rootOverride ? [path.resolve(options.rootOverride)] : []),
      ...buildGameRootCandidates(settings.installRoot, game.title).map((root) => path.resolve(root))
    ].filter((root, index, roots) => roots.findIndex((candidate) => pathKey(candidate) === pathKey(root)) === index);
    const existingFolders = this.app.db.listGameFolders(game.id);
    const discovered = new Map();
    for (const candidate of rootCandidates) {
      try {
        for (const entry of await this.app.listDirectSubdirectories(candidate)) discovered.set(pathKey(entry.folderPath), entry);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    // Preserve explicitly registered installations outside the managed roots; never scan their parent directories.
    for (const folder of existingFolders) {
      if (!rootCandidates.some((root) => isWithin(root, folder.folderPath))) discovered.set(pathKey(folder.folderPath), folder);
    }
    const directSubdirectories = [...discovered.values()];

    const existingByPath = new Map(existingFolders.map((folder) => [pathKey(folder.folderPath), folder]));
    const nextFolders = directSubdirectories.map((entry) => {
      const existing = existingByPath.get(pathKey(entry.folderPath));
      const resolvedPath = existing?.folderPath || path.resolve(entry.folderPath);
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
    const beforeGame = this.app.db.getGameById(game.id);

    await this.app.db.replaceGameFolders(game.id, nextFolders);
    const syncedFolders = this.app.db.listGameFolders(game.id);
    const missingRanks = syncedFolders.some((folder) => !Number.isFinite(Number(folder.sortRank)));
    const changedMembership =
      beforeFolders.length !== syncedFolders.length ||
      beforeFolders.some((folder) => !syncedFolders.some((entry) => entry.folderPath === folder.folderPath));
    const rankedFolders = missingRanks || changedMembership
      ? await this.app.db.recalculateGameFolderRanks(game.id, {
          game: this.app.db.getGameById(game.id),
          folders: syncedFolders
        })
      : syncedFolders;
    const updatedGame = await this.app.db.applyDerivedInstallState(game.id, rankedFolders, {
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
    const settings = this.app.db.getSettings();
    if (!settings.installRoot || !game?.title) {
      return null;
    }

    const gameRoot = buildInstallDirectory(settings.installRoot, game.title);
    await assertNoLinks(gameRoot);
    await fs.mkdir(gameRoot, { recursive: true });
    return gameRoot;
  }

  async ensureAllGameRoots() {
    const settings = this.app.db.getSettings();
    if (!settings.installRoot) {
      return;
    }

    const games = this.app.db.getGames();
    for (const game of games) {
      await this.app.ensureGameRootForGame(game);
    }
  }

  async listDirectSubdirectories(rootPath) {
    await assertNoLinks(rootPath);
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== ".f95-staging")
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
    const actualRoot = this.app.resolveGameRootPath(game, installRoot);
    if (actualRoot) {
      const resolvedRoot = path.resolve(actualRoot);
      if (!candidates.includes(resolvedRoot)) {
        candidates.unshift(resolvedRoot);
      }
    }
    return candidates;
  }


}
module.exports = { InstallationService };
