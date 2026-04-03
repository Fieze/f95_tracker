const path = require("path");
const { fork, spawn } = require("child_process");
const { resolveSevenZipBinary } = require("./sevenZip");

function getIsPackaged() {
  try {
    const electron = require("electron");
    if (electron && typeof electron !== "string" && electron.app) {
      return electron.app.isPackaged;
    }
  } catch {
    // Ignore: this module can also be required from plain Node contexts.
  }

  return false;
}

function extractArchiveWithProgress(archivePath, targetPath, onProgress) {
  const workerPath = path.join(__dirname, "extractionWorker.js");
  const sevenZipPath = resolveSevenZipBinary({
    appRoot: path.resolve(__dirname, "..", "..", ".."),
    resourcesPath: process.resourcesPath,
    isPackaged: getIsPackaged()
  });
  const child = fork(workerPath, [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });

  let settled = false;
  let lastPayload = null;
  let watchdog = null;
  const STALL_TIMEOUT_MS = 120000;

  const completion = new Promise((resolve, reject) => {
    const cleanup = () => {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
    };

    const bumpWatchdog = () => {
      if (watchdog) {
        clearTimeout(watchdog);
      }
      watchdog = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        const stuckFile = lastPayload?.currentFile ? ` bei ${lastPayload.currentFile}` : "";
        cleanup();
        if (!child.killed) {
          child.kill();
        }
        reject(new Error(`Archive extraction timed out${stuckFile}.`));
      }, STALL_TIMEOUT_MS);
    };

    child.on("message", (message) => {
      if (!message || typeof message !== "object") {
        return;
      }

      if (message.type === "progress") {
        lastPayload = message.payload || null;
        bumpWatchdog();
        onProgress?.(message.payload);
        return;
      }

      if (message.type === "done" && !settled) {
        settled = true;
        cleanup();
        resolve();
        return;
      }

      if (message.type === "error" && !settled) {
        settled = true;
        cleanup();
        reject(new Error(message.payload?.message || "Archive extraction failed."));
      }
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`Extraction worker exited unexpectedly (${signal || code}).`));
    });

    bumpWatchdog();
  });

  child.send({
    archivePath,
    targetPath,
    sevenZipPath
  });
  return {
    completion,
    terminate: () => {
      if (!child.killed) {
        child.kill();
      }
    }
  };
}

function collectOutput(stream, onLine) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer) {
      onLine(buffer);
    }
  });
}

function runSevenZip(sevenZipPath, args, { onStdoutLine, onStderrLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZipPath, args, {
      windowsHide: true
    });
    let stderr = "";

    collectOutput(child.stdout, (line) => {
      onStdoutLine?.(line);
    });
    collectOutput(child.stderr, (line) => {
      stderr += `${line}\n`;
      onStderrLine?.(line);
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `7z exited with code ${code}.`));
    });
  });
}

async function listArchiveEntries(sevenZipPath, archivePath) {
  const entries = [];
  let currentEntry = null;
  let inEntries = false;

  await runSevenZip(sevenZipPath, ["l", "-slt", archivePath], {
    onStdoutLine: (line) => {
      const trimmed = line.trim();
      if (/^-+$/.test(trimmed)) {
        if (currentEntry?.path) {
          entries.push(currentEntry);
        }
        currentEntry = null;
        inEntries = !inEntries;
        return;
      }

      if (!inEntries) {
        return;
      }

      if (!trimmed) {
        if (currentEntry?.path) {
          entries.push(currentEntry);
        }
        currentEntry = null;
        return;
      }

      const separator = trimmed.indexOf(" = ");
      if (separator === -1) {
        return;
      }

      const key = trimmed.slice(0, separator);
      const value = trimmed.slice(separator + 3);
      if (key === "Path") {
        currentEntry = {
          path: value,
          isDirectory: false
        };
        return;
      }

      if (key === "Folder" && currentEntry) {
        currentEntry.isDirectory = value === "+";
      }
    }
  });

  if (currentEntry?.path) {
    entries.push(currentEntry);
  }

  return entries;
}

function hasSingleRootDirectory(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return false;
  }

  const rootSegments = new Set();
  for (const entry of entries) {
    const normalizedPath = String(entry.path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!normalizedPath) {
      continue;
    }

    const segments = normalizedPath.split("/").filter(Boolean);
    if (segments.length === 0) {
      continue;
    }

    if (!entry.isDirectory && segments.length === 1) {
      return false;
    }

    rootSegments.add(segments[0]);
    if (rootSegments.size > 1) {
      return false;
    }
  }

  return rootSegments.size === 1;
}

async function archiveHasSingleRootDirectory(archivePath) {
  const sevenZipPath = resolveSevenZipBinary({
    appRoot: path.resolve(__dirname, "..", "..", ".."),
    resourcesPath: process.resourcesPath,
    isPackaged: getIsPackaged()
  });

  if (!sevenZipPath) {
    throw new Error("7z binary path is missing.");
  }

  const entries = await listArchiveEntries(sevenZipPath, archivePath);
  return hasSingleRootDirectory(entries);
}

module.exports = {
  archiveHasSingleRootDirectory,
  extractArchiveWithProgress,
  hasSingleRootDirectory
};
