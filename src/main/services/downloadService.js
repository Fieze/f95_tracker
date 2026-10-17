const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS = 250;
const MAX_RESUME_ATTEMPTS = 3;
const RESUME_BACKOFF_MS = 1000;
const DOWNLOADABLE_FILE_EXTENSIONS = new Set([".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".tgz", ".exe", ".apk"]);

// Shared application state and facade calls are supplied by AppService.
class DownloadService {
  constructor(app) {
    this.app = app;
    this.reservedPaths = new Set();
    this.reservationQueue = Promise.resolve();
  }
  listDownloadJobs() {
    return [...this.app.downloadJobs].sort((left, right) => {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });
  }

  async ensureDownloadReady() {
    const settings = this.app.db.getSettings();
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
      id: this.app.nextDownloadJobId++,
      gameId: Number(gameId) || null,
      linkId: linkId == null ? null : Number(linkId),
      sourceUrl,
      resolvedUrl: "",
      host: this.app.getDownloadHost(sourceUrl),
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

    this.app.downloadJobs = [...this.app.downloadJobs, job];
    this.app.emitChange();
    return job;
  }

  updateDownloadJob(jobId, updates = {}) {
    let nextJob = null;
    this.app.downloadJobs = this.app.downloadJobs.map((entry) => {
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
      this.app.emitChange();
    }

    return nextJob;
  }

  getDownloadJob(jobId) {
    return this.app.downloadJobs.find((entry) => entry.id === Number(jobId)) || null;
  }

  markDownloadAwaiting(jobId) {
    return this.app.updateDownloadJob(jobId, {
      status: "awaiting_download",
      speedBytesPerSecond: 0,
      errorMessage: ""
    });
  }

  cancelDownloadJob(jobId, errorMessage = "Download window was closed before a file download started.") {
    const job = this.app.getDownloadJob(jobId);
    if (!job) {
      return null;
    }

    if (["completed", "failed", "canceled"].includes(job.status)) {
      return job;
    }

    const controller = this.app.activeDownloadControllers.get(job.id);
    if (controller) {
      controller.abort();
      this.app.activeDownloadControllers.delete(job.id);
    }

    return this.app.updateDownloadJob(jobId, {
      status: "canceled",
      speedBytesPerSecond: 0,
      errorMessage
    });
  }

  failDownloadJob(jobId, error) {
    const message = error?.message || String(error || "Download failed.");
    this.app.activeDownloadControllers.delete(Number(jobId));
    return this.app.updateDownloadJob(jobId, {
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
    const job = this.app.getDownloadJob(jobId);
    if (!job) {
      throw new Error("Download job not found.");
    }

    const controller = new AbortController();
    this.app.activeDownloadControllers.set(job.id, controller);
    let reservedPath;

    try {
      await this.app.ensureDownloadReady();
      this.app.updateDownloadJob(job.id, {
        status: "resolving",
        resolvedUrl: String(options.url || job.sourceUrl || "").trim(),
        errorMessage: ""
      });

      const response = await this.app.downloadFetch(String(options.url || job.sourceUrl || "").trim(), {
        headers: this.app.buildResolvedDownloadHeaders(options),
        redirect: "follow",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Download request failed with status ${response.status}`);
      }

      const resolvedUrl = response.url || String(options.url || job.sourceUrl || "").trim();
      const watchFolder = await this.app.ensureDownloadReady();
      const fileName = this.app.resolveDownloadFileName({
        preferredFileName: options.fileName,
        resolvedUrl,
        contentDisposition: response.headers.get("content-disposition") || ""
      });
      const targetPath = await this.app.reserveDownloadTargetPath(watchFolder, fileName);
      reservedPath = targetPath;
      const tempPath = `${targetPath}.part`;
      const bytesTotal = Number(response.headers.get("content-length") || 0);

      this.app.updateDownloadJob(job.id, {
        status: "downloading",
        resolvedUrl,
        host: this.app.getDownloadHost(resolvedUrl),
        fileName,
        targetPath,
        bytesReceived: 0,
        bytesTotal: Number.isFinite(bytesTotal) ? bytesTotal : 0,
        speedBytesPerSecond: 0,
        startedAt: new Date().toISOString(),
        completedAt: ""
      });

      const { bytesReceived, sha256 } = await this.downloadWithResume(response, tempPath, {
        jobId: job.id,
        bytesTotal,
        signal: controller.signal,
        url: String(options.url || job.sourceUrl || "").trim(),
        headers: this.app.buildResolvedDownloadHeaders(options)
      });
      if (bytesTotal && bytesReceived !== bytesTotal) {
        await fs.unlink(tempPath).catch(() => {});
        throw new Error(`Download is incomplete: received ${bytesReceived} of ${bytesTotal} bytes.`);
      }

      await fs.rename(tempPath, targetPath);
      this.app.activeDownloadControllers.delete(job.id);
      this.app.updateDownloadJob(job.id, {
        status: "completed",
        resolvedUrl,
        fileName,
        targetPath,
        bytesReceived: bytesTotal || this.app.getDownloadJob(job.id)?.bytesReceived || 0,
        bytesTotal: bytesTotal || this.app.getDownloadJob(job.id)?.bytesReceived || 0,
        speedBytesPerSecond: this.app.getDownloadJob(job.id)?.speedBytesPerSecond || 0,
        completedAt: new Date().toISOString(),
        sha256,
        errorMessage: ""
      });

      await this.app.downloadLogger.info("Resolved file download completed.", {
        jobId: job.id,
        sourceUrl: job.sourceUrl,
        resolvedUrl,
        targetPath,
        sha256
      });

      if (job.gameId) {
        this.app.folderWatcher.ignoreFile(targetPath, 45000);
        await this.app.processArchive({
          archivePath: targetPath,
          archiveName: fileName,
          archiveHash: null,
          gameId: job.gameId,
          detectedVersion: job.detectedVersion || null,
          autoExtract: true
        });
      }

      return this.app.getDownloadJob(job.id);
    } catch (error) {
      this.app.activeDownloadControllers.delete(job.id);
      if (error?.name === "AbortError") {
        this.app.cancelDownloadJob(job.id, "Download canceled.");
      } else {
        this.app.failDownloadJob(job.id, error);
      }
      throw error;
    } finally {
      if (reservedPath) this.reservedPaths.delete(reservedPath);
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

  // Streams the response and, when the connection drops mid-file, resumes with a Range request
  // (up to MAX_RESUME_ATTEMPTS times) as long as the server honours it with a 206 response.
  async downloadWithResume(response, tempPath, { jobId, bytesTotal, signal, url, headers }) {
    const hash = crypto.createHash("sha256");
    let received = 0;
    let current = response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.app.streamResponseToFile(current, tempPath, {
          jobId, bytesTotal, signal, offset: received, hash, keepPartial: true
        });
        received = result?.bytesReceived ?? received;
        return { bytesReceived: received, sha256: hash.digest("hex") };
      } catch (error) {
        received = error.bytesReceived ?? received;
        const canResume = error?.name !== "AbortError" && !signal?.aborted && bytesTotal > 0 &&
          received > 0 && received < bytesTotal && attempt < MAX_RESUME_ATTEMPTS;
        if (!canResume) {
          await fs.unlink(tempPath).catch(() => {});
          throw error;
        }
        await this.app.downloadLogger?.warn("Download interrupted, trying to resume.", {
          jobId, attempt: attempt + 1, bytesReceived: received, message: error.message
        });
        await new Promise((resolve) => setTimeout(resolve, RESUME_BACKOFF_MS * (attempt + 1)));
        current = await this.app.downloadFetch(url, {
          headers: { ...headers, range: `bytes=${received}-` },
          redirect: "follow",
          signal
        });
        if (current.status !== 206) {
          await fs.unlink(tempPath).catch(() => {});
          throw error;
        }
      }
    }
  }

  async streamResponseToFile(response, filePath, { jobId, bytesTotal = 0, signal, offset = 0, hash, keepPartial = false } = {}) {
    const fileHandle = await fs.open(filePath, offset > 0 ? "a" : "wx");
    let bytesReceived = offset;
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
        hash?.update(buffer);
        bytesReceived = offset + buffer.length;
        this.app.updateDownloadJob(jobId, {
          bytesReceived,
          bytesTotal: bytesTotal || bytesReceived,
          speedBytesPerSecond: bytesReceived
        });
        completed = true;
        return { bytesReceived };
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
        hash?.update(chunk);
        bytesReceived += chunk.length;

        const now = Date.now();
        if (now - lastEmitAt >= DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS) {
          lastEmitAt = now;
          const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
          this.app.updateDownloadJob(jobId, {
            bytesReceived,
            bytesTotal: bytesTotal || 0,
            speedBytesPerSecond: (bytesReceived - offset) / elapsedSeconds
          });
        }
      }

      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      this.app.updateDownloadJob(jobId, {
        bytesReceived,
        bytesTotal: bytesTotal || bytesReceived,
        speedBytesPerSecond: (bytesReceived - offset) / elapsedSeconds
      });
      return { bytesReceived };
    } catch (error) {
      error.bytesReceived = bytesReceived;
      throw error;
    } finally {
      await fileHandle.close();
      if (!completed && !keepPartial) {
        await fs.unlink(filePath).catch(() => {});
      }
    }
  }

  resolveDownloadFileName({ preferredFileName, resolvedUrl, contentDisposition }) {
    const explicit = this.app.sanitizeDownloadFileName(preferredFileName);
    if (explicit) {
      return explicit;
    }

    const fromDisposition = this.app.sanitizeDownloadFileName(this.app.extractFileNameFromContentDisposition(contentDisposition));
    if (fromDisposition) {
      return fromDisposition;
    }

    try {
      const parsed = new URL(resolvedUrl);
      const fromPath = this.app.sanitizeDownloadFileName(decodeURIComponent(path.basename(parsed.pathname || "")));
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
    const reservation = this.reservationQueue.then(async () => {
      const parsed = path.parse(fileName);
      let candidate = path.join(folderPath, fileName);
      let counter = 1;
      while (this.reservedPaths.has(candidate) || await this.app.assetExists(candidate) || await this.app.assetExists(`${candidate}.part`)) {
        candidate = path.join(folderPath, `${parsed.name} (${counter++})${parsed.ext}`);
      }
      this.reservedPaths.add(candidate);
      return candidate;
    });
    this.reservationQueue = reservation.catch(() => {});
    return reservation;
  }


}
module.exports = { DownloadService };
