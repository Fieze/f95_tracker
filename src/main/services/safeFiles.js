const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

// Antivirus scanners and indexers can briefly lock the destination on Windows; retry the rename a few times.
async function renameWithRetry(from, to, attempts = 6) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fs.rename(from, to);
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

async function atomicWrite(filePath, data) {
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Check every existing component, including the configured root's ancestors.
async function assertNoLinks(candidate) {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink()) throw new Error(`Symbolic links and junctions are not allowed: ${current}`);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertManagedInstallPath(installRoot, gameRoots, candidate) {
  if (!installRoot || !candidate || !isWithin(installRoot, candidate) ||
      !gameRoots.some((root) => isWithin(installRoot, root) && isWithin(root, candidate))) {
    throw new Error("Folder must be an installation inside the configured game directory.");
  }
  await assertNoLinks(candidate);
  return path.resolve(candidate);
}

async function assertSafeTree(root) {
  await assertNoLinks(root);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (!isWithin(root, child) || entry.isSymbolicLink()) throw new Error("Unsafe archive output path.");
    if (entry.isDirectory()) await assertSafeTree(child);
  }
}

async function removeStagingDirectory(installRoot, candidate, owner) {
  const stagingRoot = path.join(installRoot, ".f95-staging");
  if (!isWithin(stagingRoot, candidate) || path.dirname(path.resolve(candidate)) !== path.resolve(stagingRoot) ||
      !/^job-\d+-[0-9a-f-]{36}$/.test(path.basename(candidate))) {
    throw new Error("Invalid staging directory.");
  }
  await assertNoLinks(candidate);
  const stats = await fs.lstat(candidate).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats) return;
  const marker = path.join(candidate, ".f95-owner");
  await assertNoLinks(marker);
  if ((await fs.readFile(marker, "utf8")) !== `f95-tracker-staging-v1\n${path.resolve(owner)}`) {
    throw new Error("Staging directory belongs to another application data directory.");
  }
  await fs.rm(candidate, { recursive: true, force: true });
}

module.exports = { atomicWrite, isWithin, assertNoLinks, assertManagedInstallPath, assertSafeTree, removeStagingDirectory };
