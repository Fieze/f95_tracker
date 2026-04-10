const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const chokidar = require("chokidar");
const crypto = require("crypto");
const { delay } = require("./utils");

class FolderWatcher {
  constructor({ onArchiveDetected }) {
    this.onArchiveDetected = onArchiveDetected;
    this.watcher = null;
    this.processing = new Set();
    this.ignoredUntilByPath = new Map();
  }

  async start(targetFolder) {
    await this.stop();
    if (!targetFolder) {
      return;
    }

    await fsPromises.mkdir(targetFolder, { recursive: true });
    this.watcher = chokidar.watch(targetFolder, {
      ignoreInitial: false,
      depth: 0,
      awaitWriteFinish: {
        stabilityThreshold: 3500,
        pollInterval: 250
      }
    });

    const handleArchiveEvent = (filePath) => {
      if (!/\.(zip|rar|7z)$/i.test(filePath)) {
        return;
      }
      this.handleFile(filePath).catch((error) => {
        console.error(`Folder watcher failed for ${filePath}:`, error);
      });
    };

    this.watcher.on("add", handleArchiveEvent);
    this.watcher.on("change", handleArchiveEvent);
  }

  async stop() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  async handleFile(filePath) {
    const key = filePath.toLowerCase();
    const ignoredUntil = this.ignoredUntilByPath.get(key) || 0;
    if (ignoredUntil > Date.now()) {
      return;
    }

    if (this.processing.has(key)) {
      return;
    }
    this.processing.add(key);

    try {
      await this.waitUntilStable(filePath);
      const hash = await hashFile(filePath);
      await this.onArchiveDetected({
        archivePath: filePath,
        archiveName: path.basename(filePath),
        archiveHash: hash
      });
    } finally {
      this.processing.delete(key);
    }
  }

  async waitUntilStable(filePath) {
    let previousSize = -1;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const stats = await fsPromises.stat(filePath);
      if (stats.size > 0 && stats.size === previousSize) {
        return;
      }
      previousSize = stats.size;
      await delay(1200);
    }
  }

  ignoreFile(filePath, durationMs = 30000) {
    const key = String(filePath || "").toLowerCase();
    if (!key) {
      return;
    }

    this.ignoredUntilByPath.set(key, Date.now() + Math.max(1000, Number(durationMs) || 0));
  }
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

module.exports = {
  FolderWatcher
};
