const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { assertNoLinks, assertManagedInstallPath, assertSafeTree, removeStagingDirectory } = require("./safeFiles");
const { findBestGameMatch } = require("./matcher");
const { parseReleaseName } = require("./releaseNames");
const { buildBranchDirectory, buildInstallDirectory, buildVersionedInstallDirectory, sanitizePathSegment, sanitizeVersion, slugify } = require("./utils");
const EXTRACTION_PROGRESS_EMIT_INTERVAL_MS = 250;
const EXTRACTION_PROGRESS_LOG_INTERVAL_MS = 5000;

// Shared application state and facade calls are supplied by AppService.
class ArchiveService {
  constructor(app) { this.app = app; }
  async pruneMissingArchiveJobs() {
    const jobsWithPaths = this.app.db.listArchiveJobs().filter((job) => job.archivePath);
    let changed = false;

    for (const job of jobsWithPaths) {
      try {
        await fs.access(job.archivePath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (this.app.archiveQueue.hasJob(job.id)) continue;
        await this.app.db.deleteArchiveJob(job.id);
        changed = true;
      }
    }

    if (changed) {
      this.app.emitChange();
    }
  }

  async deleteArchiveFile(jobId) {
    if (this.app.archiveQueue.hasJob(jobId)) throw new Error("Archive is queued or being extracted.");
    const job = this.app.db.listArchiveJobs().find((entry) => entry.id === Number(jobId));
    if (!job) {
      throw new Error("Archive job not found.");
    }

    this.app.cancelProcessedArchiveRemoval(job.id);

    if (job.archivePath) {
      await fs.unlink(job.archivePath).catch((error) => {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      });
    }

    await this.app.db.deleteArchiveJob(job.id);
    this.app.emitChange();
    return this.app.getState();
  }

  scheduleProcessedArchiveRemoval(jobId, delayMs = 10000) {
    this.app.cancelProcessedArchiveRemoval(jobId);
    const timer = setTimeout(async () => {
      try {
        await this.app.gate.run(async () => {
        const job = this.app.db.listArchiveJobs().find((entry) => entry.id === Number(jobId));
        if (!job || job.status !== "processed") {
          return;
        }
        await this.app.db.deleteArchiveJob(job.id);
        this.app.emitChange();
        });
      } catch (error) {
        await this.app.extractionLogger.warn("Failed to prune processed archive job after delay.", {
          jobId: Number(jobId),
          message: error.message
        });
      } finally {
        this.app.processedArchiveRemovalTimers.delete(Number(jobId));
      }
    }, delayMs);
    this.app.processedArchiveRemovalTimers.set(Number(jobId), timer);
  }

  cancelProcessedArchiveRemoval(jobId) {
    const timer = this.app.processedArchiveRemovalTimers.get(Number(jobId));
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.app.processedArchiveRemovalTimers.delete(Number(jobId));
  }

  async processArchive({ archivePath, archiveName, archiveHash, gameId = null, detectedVersion = null, branch = null, autoExtract = false }) {
    await this.app.extractionLogger.info("Processing detected archive.", {
      archiveName,
      archivePath,
      gameId: gameId ? Number(gameId) : null,
      detectedVersion: detectedVersion || null,
      autoExtract: Boolean(autoExtract)
    });
    const existing = this.app.db.findArchiveJobByPath(archivePath, archiveName);
    if (existing && existing.archive_hash === archiveHash && ["queued", "needs-review", "unmatched", "processing", "processed"].includes(existing.status)) {
      return existing;
    }

    const release = parseReleaseName(archiveName);
    const games = this.app.db.getGames();
    const match = findBestGameMatch(archiveName, games);
    const forcedGame = gameId ? games.find((entry) => entry.id === Number(gameId)) : null;
    const payload = {
      archivePath,
      archiveName,
      archiveHash,
      gameId: forcedGame?.id || match.bestMatch?.gameId || null,
      detectedVersion: detectedVersion || match.bestMatch?.version || forcedGame?.currentVersion || null,
      branch: branch || release.branch || this.learnedBranch(forcedGame || games.find((entry) => entry.id === match.bestMatch?.gameId), release),
      status:
        release.split ? "failed" : forcedGame
          ? "queued"
          : match.kind === "matched"
          ? "queued"
          : match.kind === "needs-review"
            ? "needs-review"
            : "unmatched",
      confidence: match.confidence || "low",
      matchCandidates: match.candidates || [],
      errorText: release.split ? "Split archives (multi-part downloads) are not supported by this app." : null
    };

    let job;
    if (existing) {
      this.app.cancelProcessedArchiveRemoval(existing.id);
      job = await this.app.db.updateArchiveJob(existing.id, {
        archiveHash,
        gameId: payload.gameId,
        detectedVersion: payload.detectedVersion,
        branch: payload.branch,
        status: payload.status,
        confidence: payload.confidence,
        matchCandidates: payload.matchCandidates,
        errorText: payload.errorText
      });
    } else {
      job = await this.app.db.createArchiveJob(payload);
    }

    if (!job) {
      throw new Error("Archive job could not be persisted.");
    }

    this.app.emitChange();
    await this.app.extractionLogger.info("Archive job updated.", {
      archiveName,
      status: job.status,
      jobId: job.id
    });

    if (autoExtract && payload.gameId && job.status === "queued") {
      await this.app.extractJob(job.id, payload.gameId, payload.detectedVersion);
      return this.app.db.findArchiveJobByPath(archivePath, archiveName) || job;
    }

    return job;
  }

  // The chapter a title was last confirmed for ("Dating My Daughter.zip" without a chapter tag).
  learnedBranch(game, release) {
    if (!game || !release.title) return null;
    return this.app.db.getBranchOverrides(game.id).aliasBranches?.[slugify(release.title)] || null;
  }

  async resolveArchiveMatch({ jobId, action, gameId, version, branch }) {
    await this.app.extractionLogger.info("Resolving archive job.", {
      jobId: Number(jobId),
      action,
      gameId: gameId ? Number(gameId) : null
    });
    const job = this.app.db.listArchiveJobs().find((entry) => entry.id === Number(jobId));
    if (!job) {
      throw new Error("Archive job not found.");
    }

    if (!gameId) {
      throw new Error("A game selection is required.");
    }

    if (action === "accept") {
      // Confirming a match teaches the game this release name: the full file name and the bare title in front of the
      // version / chapter tags, plus the chapter the title usually stands for.
      const release = parseReleaseName(job.archiveName);
      await this.app.db.appendAlias(gameId, job.archiveName);
      if (release.title) await this.app.db.appendAlias(gameId, release.title);
      const nextBranch = branch !== undefined ? String(branch || "").trim() || null : job.branch;
      if (nextBranch !== job.branch) await this.app.db.updateArchiveJob(job.id, { branch: nextBranch });
      if (nextBranch && release.title && !release.branch) {
        const overrides = this.app.db.getBranchOverrides(gameId);
        overrides.aliasBranches = { ...overrides.aliasBranches, [slugify(release.title)]: nextBranch };
        await this.app.db.saveBranchOverrides(gameId, overrides);
      }
      const nextVersion = version !== undefined ? sanitizeVersion(version) || null : job.detectedVersion;
      await this.app.extractJob(job.id, gameId, nextVersion);
      this.app.emitChange();
      return this.app.getState();
    }

    throw new Error("Unsupported archive action.");
  }

  async extractJob(jobId, gameId, detectedVersion) {
    return this.app.archiveQueue.enqueue({ jobId: Number(jobId), gameId: Number(gameId), detectedVersion });
  }

  async runExtractJob(jobId, gameId, detectedVersion) {
    await this.app.extractionLogger.info("Starting archive extraction.", {
      jobId: Number(jobId),
      gameId: Number(gameId),
      detectedVersion: detectedVersion || null
    });
    const state = await this.app.getState();
    const job = state.archiveJobs.find((entry) => entry.id === Number(jobId));
    const game = state.games.find((entry) => entry.id === Number(gameId));
    if (!job || !game) {
      throw new Error("Could not prepare extraction.");
    }
    if (this.app.gate.closed) return;

    if (!state.settings.installRoot) {
      await this.app.db.updateArchiveJob(job.id, {
        status: "failed",
        errorText: "Install root is not configured."
      });
      return;
    }

    let stagingDirectory;
    let publishedDirectory;
    let registered = false;
    this.app.extractionAbort = new AbortController();
    try {
      const installDirectory = buildInstallDirectory(state.settings.installRoot, game.title);
      await assertNoLinks(installDirectory);
      await fs.mkdir(installDirectory, { recursive: true });
      const password = this.app.archivePasswords.get(job.id) || "";
      const archiveHasSingleRootFolder = await this.app.archiveHasSingleRootDirectory(job.archivePath, { signal: this.app.extractionAbort.signal, password });
      const versionForFolder = sanitizePathSegment(detectedVersion || game.currentVersion || "files");
      stagingDirectory = path.join(state.settings.installRoot, ".f95-staging", "job-" + job.id + "-" + crypto.randomUUID());
      await assertNoLinks(stagingDirectory);
      const targetDirectory = path.join(stagingDirectory, "payload");
      const archiveStats = await fs.stat(job.archivePath);
      const startedAt = new Date().toISOString();
      this.app.lastExtractionProgressLogAt = 0;
      this.app.currentExtraction = {
        jobId: job.id,
        archiveName: job.archiveName,
        archivePath: job.archivePath,
        startedAt,
        estimatedTotalMs: this.app.estimateExtractionDurationMs(job.archivePath, archiveStats.size),
        archiveSizeBytes: archiveStats.size,
        currentFile: "",
        processedFiles: 0,
        totalFiles: 0
      };
      await this.app.db.updateArchiveJob(job.id, {
        status: "processing",
        gameId,
        detectedVersion
      });
      this.app.emitChange();

      await fs.mkdir(targetDirectory, { recursive: true });
      await fs.writeFile(path.join(stagingDirectory, ".f95-owner"), `f95-tracker-staging-v1\n${path.resolve(this.app.userDataPath)}`, { flag: "wx" });
      await this.app.extractionLogger.info("Archive extraction prepared.", {
        jobId: job.id,
        gameId,
        archivePath: job.archivePath,
        archiveSizeBytes: archiveStats.size,
        archiveHasSingleRootFolder,
        installDirectory,
        targetDirectory,
        detectedVersion: detectedVersion || null
      });
      this.app.activeExtractionHandle = this.app.extractArchiveWithProgress(job.archivePath, targetDirectory, (progress) => {
        this.app.updateExtractionProgress(progress);
      }, { signal: this.app.extractionAbort.signal, password });
      await this.app.activeExtractionHandle.completion;
      if (this.app.extractionAbort.signal.aborted) throw Object.assign(new Error("Extraction interrupted."), { name: "AbortError" });
      await assertSafeTree(targetDirectory);
      const children = await fs.readdir(targetDirectory, { withFileTypes: true });
      if (!children.length) throw new Error("Archive contains no installable files.");
      const sourceDirectory = archiveHasSingleRootFolder && children.length === 1 && children[0].isDirectory()
        ? path.join(targetDirectory, children[0].name) : targetDirectory;
      const branchDirectory = buildBranchDirectory(installDirectory, job.branch);
      const baseDirectory = buildVersionedInstallDirectory(branchDirectory, game.title, versionForFolder);
      let finalDirectory = baseDirectory;
      let suffix = 2;
      while (await this.app.assetExists(finalDirectory)) finalDirectory = baseDirectory + " (" + suffix++ + ")";
      await assertManagedInstallPath(state.settings.installRoot, [installDirectory], finalDirectory);
      await fs.mkdir(branchDirectory, { recursive: true });
      // Windows scanners can hold freshly extracted files briefly after 7-Zip closes.
      // Retry only the same rename; never copy over or delete an existing target.
      for (let attempt = 0; ; attempt++) {
        if (this.app.extractionAbort.signal.aborted) throw Object.assign(new Error("Extraction interrupted."), { name: "AbortError" });
        await assertNoLinks(sourceDirectory);
        await assertManagedInstallPath(state.settings.installRoot, [installDirectory], finalDirectory);
        if (await this.app.assetExists(finalDirectory)) throw new Error("Installation target appeared before publication.");
        try { await fs.rename(sourceDirectory, finalDirectory); break; }
        catch (error) {
          if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 7) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
      publishedDirectory = finalDirectory;
      await this.app.db.upsertGameFolder(gameId, {
        folderPath: finalDirectory, folderName: path.basename(finalDirectory),
        version: detectedVersion || game.currentVersion || null, versionSource: "manual", branch: job.branch || null
      });
      await this.app.syncGameFolders(gameId, { game, rootOverride: installDirectory });
      registered = true;
      const finishedAt = Date.now();
      const startedAtMs = new Date(startedAt).getTime();
      await this.app.db.updateArchiveJob(job.id, {
        status: "processed",
        gameId,
        detectedVersion,
        extractedTo: publishedDirectory,
        errorText: null
      });
      this.app.archivePasswords.delete(job.id);
      this.app.scheduleProcessedArchiveRemoval(job.id);
      const sourceKey = process.platform === "win32" ? job.archivePath.toLowerCase() : job.archivePath;
      if (!this.app.keepSourceArchives.delete(sourceKey)) await this.retireArchive(job.archivePath, state.settings.keepArchives);
      await this.app.extractionLogger.info("Archive extraction completed.", {
        jobId: job.id,
        gameId,
        archivePath: job.archivePath,
        targetDirectory,
        elapsedMs: Number.isFinite(startedAtMs) ? Math.max(0, finishedAt - startedAtMs) : null,
        processedFiles: this.app.currentExtraction?.processedFiles || 0,
        totalFiles: this.app.currentExtraction?.totalFiles || 0
      });
    } catch (error) {
      this.app.cancelProcessedArchiveRemoval(job.id);
      let errorText = error.message;
      if (error.code === "ARCHIVE_PASSWORD") {
        // A stored password that 7-Zip rejected is dropped so the prompt can ask again.
        if (this.app.archivePasswords.delete(job.id)) errorText = "The password was not accepted. Enter the password to extract this archive.";
      } else {
        this.app.archivePasswords.delete(job.id);
      }
      await this.app.db.updateArchiveJob(job.id, {
        status: error.name === "AbortError" || this.app.gate.closed ? "queued" : "failed",
        gameId,
        detectedVersion,
        errorText
      });
      await this.app.extractionLogger.error("Archive extraction failed.", {
        jobId: job.id,
        gameId,
        message: error.message
      });
    } finally {
      if (publishedDirectory && !registered) {
        // Publication succeeded but registration failed: retain files and source archive for recovery.
        await this.app.extractionLogger.warn("Installation retained after registration failure.", { publishedDirectory });
      }
      if (stagingDirectory) await removeStagingDirectory(state.settings.installRoot, stagingDirectory, this.app.userDataPath).catch((error) => this.app.extractionLogger.warn("Staging cleanup failed.", error));
      this.app.extractionAbort = null;
      this.app.activeExtractionHandle = null;
      this.app.currentExtraction = null;
      this.app.emitChange();
    }
  }

  // After a successful install the source archive is either deleted or, if the user wants to keep it, moved to an
  // "Extracted" subfolder. The folder watcher does not look into subfolders, so the archive is not picked up again.
  async retireArchive(archivePath, keep) {
    if (!keep) {
      await fs.unlink(archivePath).catch(() => {});
      return;
    }
    try {
      const keepDirectory = path.join(path.dirname(archivePath), "Extracted");
      await fs.mkdir(keepDirectory, { recursive: true });
      const parsed = path.parse(archivePath);
      let candidate = path.join(keepDirectory, parsed.base);
      for (let counter = 1; await this.app.assetExists(candidate); counter++) {
        candidate = path.join(keepDirectory, parsed.name + " (" + counter + ")" + parsed.ext);
      }
      await fs.rename(archivePath, candidate);
    } catch (error) {
      await this.app.extractionLogger.warn("Could not move the extracted archive; leaving it in place.", { archivePath, message: error.message });
    }
  }

  // The password is kept in memory only, for this job, and sent to 7-Zip for the next extraction attempt.
  async setArchivePassword({ jobId, password }) {
    const job = this.app.db.listArchiveJobs().find((entry) => entry.id === Number(jobId));
    if (!job) throw new Error("Archive job not found.");
    if (!job.gameId) throw new Error("Choose a game for this archive first.");
    if (!String(password || "")) throw new Error("A password is required.");
    this.app.archivePasswords.set(job.id, String(password));
    await this.app.extractJob(job.id, job.gameId, job.detectedVersion);
    this.app.emitChange();
    return this.app.getState();
  }

  estimateExtractionDurationMs(archivePath, sizeBytes) {
    const extension = path.extname(archivePath).toLowerCase();
    const sizeMb = Math.max(1, sizeBytes / (1024 * 1024));
    const msPerMb = extension === ".rar" ? 140 : extension === ".7z" ? 125 : 95;
    return Math.round(3500 + sizeMb * msPerMb);
  }

  updateExtractionProgress(progress) {
    if (!this.app.currentExtraction) {
      return;
    }

    const now = Date.now();
    const elapsedMs = Date.now() - new Date(this.app.currentExtraction.startedAt).getTime();
    const processedFiles = Number(progress.processedFiles || 0);
    const totalFiles = Number(progress.totalFiles || 0);
    const processedBytes = Number(progress.processedBytes || 0);
    const totalBytes = Number(progress.totalBytes || 0);
    // 7-Zip's own percentage is the most direct signal; otherwise measure by bytes, then by file count.
    const percent = Number.isFinite(progress.percent) ? progress.percent : this.app.currentExtraction.percent;
    let fraction = 0;
    if (Number.isFinite(percent)) fraction = percent / 100;
    else if (totalBytes > 0) fraction = processedBytes / totalBytes;
    else if (totalFiles > 0) fraction = processedFiles / totalFiles;
    const estimatedRemainingMs =
      fraction > 0.02
        ? Math.max(0, Math.round((elapsedMs / fraction) * (1 - Math.min(fraction, 1))))
        : this.app.currentExtraction.estimatedTotalMs;

    this.app.currentExtraction = {
      ...this.app.currentExtraction,
      currentFile: progress.currentFile || this.app.currentExtraction.currentFile,
      processedFiles,
      totalFiles,
      processedBytes,
      totalBytes,
      percent,
      estimatedRemainingMs
    };
    const shouldEmit =
      processedFiles >= totalFiles ||
      now - this.app.lastExtractionProgressEmitAt >= EXTRACTION_PROGRESS_EMIT_INTERVAL_MS;
    const shouldLogProgress =
      processedFiles > 0 &&
      (processedFiles >= totalFiles ||
        now - this.app.lastExtractionProgressLogAt >= EXTRACTION_PROGRESS_LOG_INTERVAL_MS);

    if (shouldEmit) {
      this.app.lastExtractionProgressEmitAt = now;
      this.app.emitChange();
    }

    if (shouldLogProgress) {
      this.app.lastExtractionProgressLogAt = now;
      this.app.extractionLogger.info("Archive extraction progress.", {
        jobId: this.app.currentExtraction.jobId,
        archiveName: this.app.currentExtraction.archiveName,
        currentFile: this.app.currentExtraction.currentFile || "",
        processedFiles,
        totalFiles,
        estimatedRemainingMs
      }).catch(() => {});
    }
  }

  async cleanupStagingDirectories() {
    const installRoot = this.app.db.getSettings().installRoot;
    if (!installRoot) return;
    const root = path.join(installRoot, ".f95-staging");
    await assertNoLinks(root);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isDirectory() && /^job-\d+-[0-9a-f-]{36}$/.test(entry.name)) {
        await removeStagingDirectory(installRoot, path.join(root, entry.name), this.app.userDataPath)
          .catch((error) => this.app.extractionLogger.warn("Staging directory retained.", error));
      }
    }
  }


}
module.exports = { ArchiveService };
