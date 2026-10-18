const fs = require("fs/promises");
const { atomicWrite } = require("./safeFiles");
const path = require("path");
const crypto = require("crypto");
const DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS = 250;
const ACTIVE_STATUSES = ["queued", "opening_host", "awaiting_download", "resolving", "downloading"];
const JOB_HISTORY_LIMIT = 50;
const JOB_HISTORY_FILE = "download-jobs.json";
const MAX_RESUME_ATTEMPTS = 3;
const RESUME_BACKOFF_MS = 1000;
const DOWNLOADABLE_FILE_EXTENSIONS = new Set([".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".tgz", ".exe", ".apk"]);
const VERIFIABLE_ARCHIVE_EXTENSIONS = new Set([".zip", ".rar", ".7z"]);
const STALE_PARTIAL_MS = 7 * 24 * 60 * 60 * 1000;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Shared application state and facade calls are supplied by AppService.
class DownloadService {
  constructor(app) {
    this.app = app;
    this.reservedPaths = new Set();
    this.reservationQueue = Promise.resolve();
    // Jobs are kept by id so progress updates (several per second) do not copy a whole list.
    this.jobs = new Map();
    this.nextJobId = 1;
    this.controllers = new Map();
    this.persistQueue = Promise.resolve();
  }

  listDownloadJobs() {
    return [...this.jobs.values()].sort((left, right) => {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime() || right.id - left.id;
    });
  }

  replaceJobs(jobs) {
    this.jobs = new Map((jobs || []).map((job) => [job.id, job]));
  }

  hasActiveJobs(gameId = null) {
    return [...this.jobs.values()].some((job) => ACTIVE_STATUSES.includes(job.status) && (gameId == null || job.gameId === Number(gameId)));
  }

  // The finished-download list survives restarts; anything that was still running is reported as interrupted.
  async loadPersistedJobs() {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.app.userDataPath, JOB_HISTORY_FILE), "utf8"));
      if (!Array.isArray(saved)) return;
      for (const job of saved.slice(-JOB_HISTORY_LIMIT)) {
        if (!Number.isInteger(job?.id) || this.jobs.has(job.id)) continue;
        const interrupted = ACTIVE_STATUSES.includes(job.status);
        this.jobs.set(job.id, interrupted
          ? { ...job, status: "canceled", speedBytesPerSecond: 0, errorMessage: "Download was interrupted when the app closed." }
          : job);
        this.nextJobId = Math.max(this.nextJobId, job.id + 1);
      }
    } catch (error) {
      if (error.code !== "ENOENT") await this.app.downloadLogger?.warn("Download history could not be read.", { message: error.message });
    }
  }

  // Marks running jobs as interrupted and writes the history; called when the app shuts down.
  async interruptAndPersist() {
    for (const [id, job] of this.jobs) {
      if (ACTIVE_STATUSES.includes(job.status)) {
        this.jobs.set(id, { ...job, status: "canceled", speedBytesPerSecond: 0, errorMessage: "Download was interrupted when the app closed.", updatedAt: new Date().toISOString() });
      }
    }
    await this.persistJobs();
  }

  persistJobs() {
    const snapshot = this.listDownloadJobs().slice(0, JOB_HISTORY_LIMIT).reverse();
    this.persistQueue = this.persistQueue
      .then(() => atomicWrite(path.join(this.app.userDataPath, JOB_HISTORY_FILE), JSON.stringify(snapshot)))
      .catch(() => {});
    return this.persistQueue;
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

  createDownloadJob({ gameId, linkId = null, url, label = "", detectedVersion = "", branch = "", variant = "" }) {
    const sourceUrl = String(url || "").trim();
    if (!/^https?:/i.test(sourceUrl)) {
      throw new Error("Download url must be absolute.");
    }

    const job = {
      id: this.nextJobId++,
      gameId: Number(gameId) || null,
      linkId: linkId == null ? null : Number(linkId),
      sourceUrl,
      resolvedUrl: "",
      host: this.getDownloadHost(sourceUrl),
      label: String(label || "").trim(),
      detectedVersion: String(detectedVersion || "").trim() || null,
      branch: String(branch || "").trim() || null,
      variant: String(variant || "").trim() || null,
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

    this.jobs.set(job.id, job);
    this.app.emitChange();
    return job;
  }

  updateDownloadJob(jobId, updates = {}) {
    const entry = this.jobs.get(Number(jobId));
    if (!entry) return null;
    const nextJob = { ...entry, ...updates, updatedAt: new Date().toISOString() };
    this.jobs.set(entry.id, nextJob);
    this.app.emitChange();
    // Only status changes are written out; byte counters would hit the disk several times a second.
    if (updates.status && updates.status !== entry.status && !ACTIVE_STATUSES.includes(updates.status)) void this.persistJobs();
    return nextJob;
  }

  getDownloadJob(jobId) {
    return this.jobs.get(Number(jobId)) || null;
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

    const controller = this.controllers.get(job.id);
    if (controller) {
      controller.abort();
      this.controllers.delete(job.id);
    }

    return this.updateDownloadJob(jobId, {
      status: "canceled",
      speedBytesPerSecond: 0,
      errorMessage
    });
  }

  failDownloadJob(jobId, error) {
    const message = error?.message || String(error || "Download failed.");
    this.controllers.delete(Number(jobId));
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
    this.controllers.set(job.id, controller);
    let reservedPath;

    try {
      const readyFolder = await this.ensureDownloadReady();
      void this.pruneStalePartials(readyFolder);
      this.updateDownloadJob(job.id, {
        status: "resolving",
        resolvedUrl: String(options.url || job.sourceUrl || "").trim(),
        errorMessage: ""
      });

      const response = await this.app.downloadFetch(String(options.url || job.sourceUrl || "").trim(), {
        headers: this.buildResolvedDownloadHeaders(options),
        redirect: "follow",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Download request failed with status ${response.status}`);
      }

      const requestUrl = String(options.url || job.sourceUrl || "").trim();
      const resolvedUrl = response.url || requestUrl;
      const watchFolder = await this.ensureDownloadReady();
      const fileName = this.resolveDownloadFileName({
        preferredFileName: options.fileName,
        resolvedUrl,
        contentDisposition: response.headers.get("content-disposition") || ""
      });
      const headers = this.buildResolvedDownloadHeaders(options);
      let bytesTotal = Number(response.headers.get("content-length") || 0);
      const validators = pickValidators(response.headers);

      // A partial file from an earlier attempt (same file, same validators) is continued instead of restarted.
      const partial = await this.findResumablePartial(watchFolder, fileName, { bytesTotal, validators });
      let targetPath;
      let initialOffset = 0;
      let current = response;
      if (partial) {
        const resumed = await this.tryContinuePartial(partial, { requestUrl, resolvedUrl, headers, signal: controller.signal, validators });
        if (resumed) {
          await discardBody(response);
          current = resumed.response;
          initialOffset = partial.size;
          targetPath = partial.targetPath;
          this.reservedPaths.add(targetPath);
        } else {
          await this.discardPartial(partial.targetPath);
        }
      }
      if (!targetPath) {
        targetPath = await this.reserveDownloadTargetPath(watchFolder, fileName);
      }
      reservedPath = targetPath;
      const tempPath = `${targetPath}.part`;
      if (initialOffset > 0) bytesTotal = bytesTotal || partial.bytesTotal;

      this.updateDownloadJob(job.id, {
        status: "downloading",
        resolvedUrl,
        host: this.getDownloadHost(resolvedUrl),
        fileName,
        targetPath,
        bytesReceived: initialOffset,
        bytesTotal: Number.isFinite(bytesTotal) ? bytesTotal : 0,
        speedBytesPerSecond: 0,
        startedAt: new Date().toISOString(),
        completedAt: ""
      });

      const { bytesReceived, sha256 } = await this.downloadWithResume(current, tempPath, {
        jobId: job.id,
        bytesTotal,
        signal: controller.signal,
        url: resolvedUrl,
        fallbackUrl: requestUrl,
        headers,
        validators,
        initialOffset
      });
      if (bytesTotal && bytesReceived !== bytesTotal) {
        await this.discardPartial(targetPath);
        throw new Error(`Download is incomplete: received ${bytesReceived} of ${bytesTotal} bytes.`);
      }
      if (!bytesTotal) {
        // Without an announced length a cut-off transfer looks complete; let 7-Zip vouch for the archive instead.
        await this.verifyUnannouncedDownload(tempPath, fileName, controller.signal).catch(async (error) => {
          await this.discardPartial(targetPath);
          throw error;
        });
      }

      await fs.rename(tempPath, targetPath);
      await fs.unlink(`${tempPath}.json`).catch(() => {});
      this.controllers.delete(job.id);
      this.updateDownloadJob(job.id, {
        status: "completed",
        resolvedUrl,
        fileName,
        targetPath,
        bytesReceived: bytesTotal || this.getDownloadJob(job.id)?.bytesReceived || 0,
        bytesTotal: bytesTotal || this.getDownloadJob(job.id)?.bytesReceived || 0,
        speedBytesPerSecond: this.getDownloadJob(job.id)?.speedBytesPerSecond || 0,
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
          branch: job.branch || null,
          autoExtract: true
        });
      }

      return this.getDownloadJob(job.id);
    } catch (error) {
      this.controllers.delete(job.id);
      if (error?.name === "AbortError") {
        this.cancelDownloadJob(job.id, "Download canceled.");
      } else {
        this.failDownloadJob(job.id, error);
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
  // (up to MAX_RESUME_ATTEMPTS times). The request carries If-Range so a file that changed on the server is
  // never stitched together from two versions, and the 206 answer must start exactly where we stopped.
  // A transfer that cannot continue now but could later (server sends validators) keeps its .part file.
  async downloadWithResume(response, tempPath, { jobId, bytesTotal, signal, url, fallbackUrl = "", headers, validators = {}, initialOffset = 0 }) {
    const hash = crypto.createHash("sha256");
    let received = initialOffset;
    if (initialOffset > 0) await hashFileInto(hash, tempPath, initialOffset);
    const resumeUrl = url || fallbackUrl;
    let current = response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.streamResponseToFile(current, tempPath, {
          jobId, bytesTotal, signal, offset: received, hash, keepPartial: true
        });
        received = result?.bytesReceived ?? received;
        return { bytesReceived: received, sha256: hash.digest("hex") };
      } catch (error) {
        received = error.bytesReceived ?? received;
        const interrupted = received > 0 && bytesTotal > 0 && received < bytesTotal;
        const canResume = error?.name !== "AbortError" && !signal?.aborted && interrupted && attempt < MAX_RESUME_ATTEMPTS;
        if (!canResume) {
          await this.settlePartial(tempPath, { keep: interrupted && hasValidators(validators), url: resumeUrl, bytesTotal, validators });
          throw error;
        }
        await this.app.downloadLogger?.warn("Download interrupted, trying to resume.", {
          jobId, attempt: attempt + 1, bytesReceived: received, message: error.message
        });
        await new Promise((resolve) => setTimeout(resolve, RESUME_BACKOFF_MS * (attempt + 1)));
        const resumeHeaders = { ...headers, range: `bytes=${received}-` };
        const ifRange = validators.etag || validators.lastModified;
        if (ifRange) resumeHeaders["if-range"] = ifRange;
        current = await this.app.downloadFetch(resumeUrl, { headers: resumeHeaders, redirect: "follow", signal });
        if (!isContinuation(current, received)) {
          await discardBody(current);
          await this.settlePartial(tempPath, { keep: false });
          throw error;
        }
      }
    }
  }

  async settlePartial(tempPath, { keep, url, bytesTotal, validators } = {}) {
    if (!keep) {
      await fs.unlink(tempPath).catch(() => {});
      await fs.unlink(tempPath + ".json").catch(() => {});
      return;
    }
    const meta = { url, bytesTotal, etag: validators?.etag || "", lastModified: validators?.lastModified || "", savedAt: new Date().toISOString() };
    await fs.writeFile(tempPath + ".json", JSON.stringify(meta)).catch(() => {});
  }

  async discardPartial(targetPath) {
    await fs.unlink(targetPath + ".part").catch(() => {});
    await fs.unlink(targetPath + ".part.json").catch(() => {});
  }

  // Looks for "<name>.part" plus its metadata next to the final path; only trusted when it describes the same file.
  async findResumablePartial(folderPath, fileName, { bytesTotal, validators }) {
    if (!bytesTotal || !hasValidators(validators)) return null;
    const targetPath = path.join(folderPath, fileName);
    if (this.reservedPaths.has(targetPath) || await this.app.assetExists(targetPath)) return null;
    try {
      const meta = JSON.parse(await fs.readFile(targetPath + ".part.json", "utf8"));
      const stats = await fs.stat(targetPath + ".part");
      const sameFile = meta.bytesTotal === bytesTotal &&
        (validators.etag ? meta.etag === validators.etag : meta.lastModified === validators.lastModified);
      const fresh = Date.now() - new Date(meta.savedAt).getTime() < STALE_PARTIAL_MS;
      if (!sameFile || !fresh || stats.size <= 0 || stats.size >= bytesTotal) return null;
      return { targetPath, size: stats.size, bytesTotal };
    } catch {
      return null;
    }
  }

  async tryContinuePartial(partial, { requestUrl, resolvedUrl, headers, signal, validators }) {
    const resumeHeaders = { ...headers, range: "bytes=" + partial.size + "-" };
    resumeHeaders["if-range"] = validators.etag || validators.lastModified;
    try {
      const response = await this.app.downloadFetch(resolvedUrl || requestUrl, { headers: resumeHeaders, redirect: "follow", signal });
      if (isContinuation(response, partial.size)) return { response };
      await discardBody(response);
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
    }
    return null;
  }

  async verifyUnannouncedDownload(filePath, fileName, signal) {
    if (!VERIFIABLE_ARCHIVE_EXTENSIONS.has(path.extname(fileName).toLowerCase()) || !this.app.testArchive) return;
    try {
      await this.app.testArchive(filePath, { signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new Error("Downloaded archive is damaged or incomplete: " + error.message);
    }
  }

  // Removes partial downloads that were never continued so they cannot pile up in the watch folder.
  async pruneStalePartials(folderPath) {
    const entries = await fs.readdir(folderPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".part")) continue;
      const fullPath = path.join(folderPath, entry.name);
      const stats = await fs.stat(fullPath).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > STALE_PARTIAL_MS) {
        await fs.unlink(fullPath).catch(() => {});
        await fs.unlink(fullPath + ".json").catch(() => {});
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
        this.updateDownloadJob(jobId, {
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
          this.updateDownloadJob(jobId, {
            bytesReceived,
            bytesTotal: bytesTotal || 0,
            speedBytesPerSecond: (bytesReceived - offset) / elapsedSeconds
          });
        }
      }

      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      this.updateDownloadJob(jobId, {
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
      const fromPath = this.sanitizeDownloadFileName(safeDecode(path.basename(parsed.pathname || "")));
      if (fromPath) {
        return fromPath;
      }
    } catch {
      // Ignore invalid urls and fall through to default file name.
    }

    return "download.bin";
  }

  sanitizeDownloadFileName(fileName) {
    let normalized = String(fileName || "").trim().split(/[\\/]/).pop().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
    // Windows silently drops trailing dots and spaces and refuses device names such as CON or NUL.
    normalized = normalized.replace(/[. ]+$/, "");
    if (!normalized) return "";
    if (RESERVED_WINDOWS_NAMES.test(path.parse(normalized).name)) normalized = "_" + normalized;
    return normalized.slice(0, 200);
  }

  extractFileNameFromContentDisposition(contentDisposition) {
    const header = String(contentDisposition || "");
    const starMatch = header.match(/filename\*=(?:UTF-8)?'[^']*'([^;]+)/i);
    if (starMatch?.[1]) {
      return safeDecode(starMatch[1].trim());
    }

    const plainMatch = header.match(/filename="?([^";]+)"?/i);
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
function pickValidators(headers) {
  const etag = String(headers.get("etag") || "").trim();
  return {
    // If-Range only accepts strong validators.
    etag: etag && !etag.startsWith("W/") ? etag : "",
    lastModified: String(headers.get("last-modified") || "").trim()
  };
}

function hasValidators(validators) {
  return Boolean(validators?.etag || validators?.lastModified);
}

// A usable continuation is a 206 whose Content-Range starts exactly at the first missing byte.
function isContinuation(response, offset) {
  if (response.status !== 206) return false;
  const match = String(response.headers.get("content-range") || "").match(/^bytes\s+(\d+)-/i);
  return !match || Number(match[1]) === offset;
}

async function discardBody(response) {
  try { await response.body?.cancel(); } catch { /* body already consumed or locked */ }
}

function hashFileInto(hash, filePath, length) {
  return new Promise((resolve, reject) => {
    const stream = require("fs").createReadStream(filePath, { end: length - 1 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return String(value); }
}

module.exports = { DownloadService };
