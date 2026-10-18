const fs = require("fs/promises");
const path = require("path");
const { resolveSevenZipBinary } = require("./sevenZip");
const { runSevenZip } = require("./sevenZipRunner");

function getBinary() {
  let isPackaged = false;
  try { isPackaged = Boolean(require("electron").app?.isPackaged); } catch {}
  return resolveSevenZipBinary({ appRoot: path.resolve(__dirname, "..", "..", ".."), resourcesPath: process.resourcesPath, isPackaged });
}

const MIN_STALL_TIMEOUT_MS = 120000;
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
const LISTING_CACHE_LIMIT = 3;
const listingCache = new Map();

// Solid archives on slow disks can stay silent for a long time; give big archives more patience.
function stallTimeoutFor(archiveSizeBytes) {
  return MIN_STALL_TIMEOUT_MS + Math.min(Math.round((archiveSizeBytes || 0) / (1024 * 1024 * 1024)) * 60000, 20 * 60000);
}

function passwordArgs(password) {
  return password ? ["-p" + password] : [];
}

// Free bytes on the volume holding the path (or its nearest existing parent); null when it cannot be determined.
async function freeBytesFor(targetPath) {
  if (typeof fs.statfs !== "function") return null;
  let current = path.resolve(targetPath);
  for (;;) {
    try {
      const stats = await fs.statfs(current);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      const parent = path.dirname(current);
      if (error.code !== "ENOENT" || parent === current) return null;
      current = parent;
    }
  }
}

async function assertEnoughFreeSpace(targetPath, requiredBytes) {
  if (!requiredBytes) return;
  const free = await freeBytesFor(targetPath);
  const needed = requiredBytes + FREE_SPACE_MARGIN_BYTES;
  if (free != null && free < needed) {
    const toMb = (bytes) => Math.ceil(bytes / (1024 * 1024)).toLocaleString("en-US");
    throw Object.assign(new Error("Not enough free disk space: " + toMb(needed) + " MB needed, " + toMb(free) + " MB available."), { code: "ARCHIVE_DISK_SPACE" });
  }
}

function validateArchiveEntry(entry) {
  const value = String(entry.path || "").replace(/\\/g, "/");
  if (!value || value.startsWith("/") || value.includes(":") || value.split("/").includes("..") ||
      entry.symbolicLink || entry.hardLink || /[Ll]/.test(entry.attributes || "") || /Symbolic Link|Reparse/i.test(entry.characteristics || "")) {
    throw new Error("Unsafe archive entry: " + value);
  }
}

async function listArchiveEntries(binary, archivePath, options = {}) {
  const entries = [];
  let current = null;
  let inEntries = false;
  const push = () => { if (current?.path) { validateArchiveEntry(current); entries.push(current); } current = null; };
  const { password, ...runnerOptions } = options;
  const handle = runSevenZip(binary, ["l", "-slt", ...passwordArgs(password), "--", archivePath], {
    ...runnerOptions,
    onLine(line, stream) {
      if (stream !== "stdout") return;
      const trimmed = line.trim();
      if (/^-{5,}$/.test(trimmed)) { push(); inEntries = true; return; }
      if (!inEntries) return;
      if (!trimmed) { push(); return; }
      const separator = trimmed.indexOf(" = ");
      if (separator === -1) return;
      const key = trimmed.slice(0, separator);
      const value = trimmed.slice(separator + 3);
      if (key === "Path") { push(); current = { path: value, isDirectory: false }; }
      else if (current) {
        if (key === "Folder") current.isDirectory = value === "+";
        if (key === "Size") current.size = Number(value) || 0;
        if (key === "Symbolic Link") current.symbolicLink = value;
        if (key === "Hard Link") current.hardLink = value;
        if (key === "Attributes") current.attributes = value;
        if (key === "Characteristics") current.characteristics = value;
      }
    }
  });
  await handle.completion;
  push();
  return entries;
}

function hasSingleRootDirectory(entries) {
  if (!Array.isArray(entries) || !entries.length) return false;
  const roots = new Set();
  for (const entry of entries) {
    const segments = String(entry.path || "").replace(/\\/g, "/").split("/").filter(Boolean);
    if (!segments.length || (!entry.isDirectory && segments.length === 1)) return false;
    roots.add(segments[0]);
  }
  return roots.size === 1;
}

// 7z is asked for the listing once per archive: the single-root check and the extraction share this result.
async function listArchiveEntriesCached(binary, archivePath, options = {}) {
  const stats = await fs.stat(archivePath);
  const key = [archivePath, stats.size, stats.mtimeMs, options.password ? "pw" : ""].join("|");
  if (listingCache.has(key)) return listingCache.get(key);
  const entries = await listArchiveEntries(binary, archivePath, { ...options, stallTimeoutMs: stallTimeoutFor(stats.size) });
  listingCache.set(key, entries);
  while (listingCache.size > LISTING_CACHE_LIMIT) listingCache.delete(listingCache.keys().next().value);
  return entries;
}

function forgetListing(archivePath) {
  for (const key of [...listingCache.keys()]) {
    if (key.startsWith(archivePath + "|")) listingCache.delete(key);
  }
}

async function archiveHasSingleRootDirectory(archivePath, options) {
  return hasSingleRootDirectory(await listArchiveEntriesCached(getBinary(), archivePath, options));
}

// Integrity check ("7z t"). A password-protected archive counts as intact: it merely cannot be read without the password.
async function testArchive(archivePath, options = {}) {
  const stats = await fs.stat(archivePath);
  const handle = runSevenZip(getBinary(), ["t", "-y", ...passwordArgs(options.password), "--", archivePath], {
    signal: options.signal,
    stallTimeoutMs: stallTimeoutFor(stats.size)
  });
  try {
    await handle.completion;
  } catch (error) {
    if (error.code !== "ARCHIVE_PASSWORD") throw error;
  }
}

function extractArchiveWithProgress(archivePath, targetPath, onProgress, options = {}) {
  const binary = getBinary();
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let active;
  const completion = (async () => {
    const entries = await listArchiveEntriesCached(binary, archivePath, { signal: controller.signal, password: options.password });
    const fileEntries = entries.filter((entry) => !entry.isDirectory);
    const sizes = new Map(fileEntries.map((entry) => [entry.path.replace(/\\/g, "/"), entry.size || 0]));
    const totalFiles = fileEntries.length;
    const totalBytes = fileEntries.reduce((sum, entry) => sum + (entry.size || 0), 0);
    await assertEnoughFreeSpace(targetPath, totalBytes);
    const archiveStats = await fs.stat(archivePath);
    let processedFiles = 0;
    let processedBytes = 0;
    const startedAt = new Date().toISOString();
    onProgress?.({ processedFiles, totalFiles, processedBytes, totalBytes, currentFile: "", startedAt });
    // -aou renames instead of overwriting, so names that differ only in letter case cannot silently replace each other.
    active = runSevenZip(binary, ["x", "-y", "-aou", "-bb1", "-bsp1", "-bso1", "-bse2", ...passwordArgs(options.password), "-o" + targetPath, "--", archivePath], {
      signal: controller.signal,
      stallTimeoutMs: stallTimeoutFor(archiveStats.size),
      onLine(line, stream) {
        if (stream !== "stdout") return;
        const file = line.trim().match(/^(?:Extracting|Inflating)\s+(.+)$|^- (.+)$/i);
        const percent = file ? null : line.match(/^\s*(\d+)%/);
        const currentFile = file?.[1] || file?.[2] || "";
        if (file) {
          processedFiles++;
          processedBytes += sizes.get(currentFile.replace(/\\/g, "/")) || 0;
        }
        if (file || percent) onProgress?.({ processedFiles, totalFiles, processedBytes, totalBytes, currentFile, percent: percent ? Number(percent[1]) : undefined, startedAt });
      }
    });
    try {
      await active.completion;
    } finally {
      forgetListing(archivePath);
    }
  })().finally(() => options.signal?.removeEventListener("abort", abort));
  return { completion, async terminate() { controller.abort(); await completion.catch(() => {}); } };
}

module.exports = { archiveHasSingleRootDirectory, assertEnoughFreeSpace, extractArchiveWithProgress, hasSingleRootDirectory, listArchiveEntries, stallTimeoutFor, testArchive, validateArchiveEntry };
