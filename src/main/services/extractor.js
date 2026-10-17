const path = require("path");
const { resolveSevenZipBinary } = require("./sevenZip");
const { runSevenZip } = require("./sevenZipRunner");

function getBinary() {
  let isPackaged = false;
  try { isPackaged = Boolean(require("electron").app?.isPackaged); } catch {}
  return resolveSevenZipBinary({ appRoot: path.resolve(__dirname, "..", "..", ".."), resourcesPath: process.resourcesPath, isPackaged });
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
  const handle = runSevenZip(binary, ["l", "-slt", "--", archivePath], {
    ...options,
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

async function archiveHasSingleRootDirectory(archivePath, options) {
  return hasSingleRootDirectory(await listArchiveEntries(getBinary(), archivePath, options));
}

function extractArchiveWithProgress(archivePath, targetPath, onProgress, options = {}) {
  const binary = getBinary();
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let active;
  const completion = (async () => {
    const entries = await listArchiveEntries(binary, archivePath, { signal: controller.signal });
    let processedFiles = 0;
    const totalFiles = entries.filter((entry) => !entry.isDirectory).length;
    const startedAt = new Date().toISOString();
    onProgress?.({ processedFiles, totalFiles, currentFile: "", startedAt });
    active = runSevenZip(binary, ["x", "-y", "-bb1", "-bsp1", "-bso1", "-bse2", "-o" + targetPath, "--", archivePath], {
      signal: controller.signal,
      onLine(line, stream) {
        if (stream !== "stdout") return;
        const file = line.trim().match(/^(?:Extracting|Inflating)\s+(.+)$|^- (.+)$/i);
        const percent = line.match(/(\d+)%/);
        if (file) processedFiles++;
        if (file || percent) onProgress?.({ processedFiles, totalFiles, currentFile: file?.[1] || file?.[2] || "", percent: percent ? Number(percent[1]) : undefined, startedAt });
      }
    });
    await active.completion;
  })().finally(() => options.signal?.removeEventListener("abort", abort));
  return { completion, async terminate() { controller.abort(); await completion.catch(() => {}); } };
}

module.exports = { archiveHasSingleRootDirectory, extractArchiveWithProgress, hasSingleRootDirectory, listArchiveEntries, validateArchiveEntry };
