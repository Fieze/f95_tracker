const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

async function ensureDirectory(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

function send(type, payload) {
  if (process.send) {
    process.send({ type, payload });
  }
}

function progressPayload({ currentFile, processedFiles, totalFiles, startedAt }) {
  return {
    currentFile,
    processedFiles,
    totalFiles,
    startedAt
  };
}

function spawnSevenZip(sevenZipPath, args) {
  return spawn(sevenZipPath, args, {
    windowsHide: true
  });
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
    const child = spawnSevenZip(sevenZipPath, args);
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
        if (currentEntry?.path && !currentEntry.isDirectory) {
          entries.push(currentEntry.path);
        }
        currentEntry = null;
        inEntries = !inEntries;
        return;
      }

      if (!inEntries) {
        return;
      }

      if (!trimmed) {
        if (currentEntry?.path && !currentEntry.isDirectory) {
          entries.push(currentEntry.path);
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

  if (currentEntry?.path && !currentEntry.isDirectory) {
    entries.push(currentEntry.path);
  }

  return entries;
}

async function extractArchive(sevenZipPath, archivePath, targetPath, startedAt) {
  await ensureDirectory(targetPath);
  const entries = await listArchiveEntries(sevenZipPath, archivePath);
  const totalFiles = entries.length;
  let processedFiles = 0;

  send("progress", progressPayload({ currentFile: "", processedFiles, totalFiles, startedAt }));

  await runSevenZip(sevenZipPath, ["x", archivePath, "-y", "-bb1", `-o${targetPath}`], {
    onStdoutLine: (line) => {
      const trimmed = line.trim();
      const verboseMatch = trimmed.match(/^(Extracting|Inflating)\s+(.+)$/i);
      const compactMatch = trimmed.match(/^- (.+)$/);
      const currentFile = verboseMatch ? verboseMatch[2] : compactMatch ? compactMatch[1] : null;
      if (!currentFile || /^archive\s*:/i.test(currentFile)) {
        return;
      }

      processedFiles += 1;
      send(
        "progress",
        progressPayload({
          currentFile,
          processedFiles,
          totalFiles,
          startedAt
        })
      );
    }
  });
}

async function main({ archivePath, targetPath, sevenZipPath }) {
  const extension = path.extname(archivePath).toLowerCase();
  const startedAt = new Date().toISOString();

  if (![".zip", ".rar", ".7z"].includes(extension)) {
    throw new Error(`Unsupported archive type: ${extension}`);
  }

  if (!sevenZipPath) {
    throw new Error("7z binary path is missing.");
  }

  await extractArchive(sevenZipPath, archivePath, targetPath, startedAt);
}

process.on("message", async (payload) => {
  try {
    await main(payload);
    send("done", {});
    process.exit(0);
  } catch (error) {
    send("error", { message: error.message });
    process.exit(1);
  }
});
