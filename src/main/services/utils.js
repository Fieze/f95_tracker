const path = require("path");

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80) || "game";
}

function normalizeThreadUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error("Thread URL is required.");
  }

  let url;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    throw new Error("Thread URL is invalid.");
  }

  if (!url.hostname.includes("f95zone.to")) {
    throw new Error("Only f95zone.to thread URLs are supported.");
  }

  const match = url.pathname.match(/\/threads\/([^./]+(?:\.[0-9]+)?)/i);
  if (!match) {
    throw new Error("The URL does not look like a thread URL.");
  }

  return `https://f95zone.to/threads/${match[1]}/`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeVersion(value) {
  if (!value) {
    return null;
  }
  return String(value).trim().replace(/\s+/g, " ");
}

function compareVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  const tokenize = (version) =>
    sanitizeVersion(version)
      .replace(/^[vV]\s*/, "")
      .split(/[^0-9a-z]+/i)
      .filter(Boolean)
      .map((token) => (/^\d+$/.test(token) ? Number(token) : token.toLowerCase()));

  const left = tokenize(a);
  const right = tokenize(b);
  const max = Math.max(left.length, right.length);

  for (let index = 0; index < max; index += 1) {
    const leftToken = left[index];
    const rightToken = right[index];

    if (leftToken === undefined) return -1;
    if (rightToken === undefined) return 1;
    if (leftToken === rightToken) continue;

    const leftIsNumber = typeof leftToken === "number";
    const rightIsNumber = typeof rightToken === "number";
    if (leftIsNumber && rightIsNumber) {
      return leftToken > rightToken ? 1 : -1;
    }

    return String(leftToken).localeCompare(String(rightToken), undefined, {
      numeric: true,
      sensitivity: "base"
    });
  }

  return 0;
}

function versionLabel(currentVersion, installedVersion) {
  if (!currentVersion) return "unknown";
  if (!installedVersion) return "not-installed";
  return compareVersions(currentVersion, installedVersion) > 0 ? "update-available" : "up-to-date";
}

function safeJsonParse(value, fallback) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildInstallDirectory(installRoot, gameTitle) {
  return path.join(installRoot, sanitizePathSegment(gameTitle));
}

function sanitizePathSegment(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim()
    .replace(/[. ]+$/g, "") || "game";
}

function buildVersionedInstallDirectory(installRoot, gameTitle, version) {
  return path.join(installRoot, sanitizePathSegment(`${gameTitle}-${version}`));
}

function buildLegacyInstallDirectory(installRoot, gameTitle) {
  return path.join(installRoot, slugify(gameTitle));
}

function buildGameRootCandidates(installRoot, gameTitle) {
  if (!installRoot || !gameTitle) {
    return [];
  }

  const candidates = [buildInstallDirectory(installRoot, gameTitle)];
  const legacy = buildLegacyInstallDirectory(installRoot, gameTitle);
  if (!candidates.includes(legacy)) {
    candidates.push(legacy);
  }
  return candidates;
}

function isSubPath(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isExpectedGameInstallPath(installRoot, gameTitle, installPath) {
  if (!installRoot || !installPath) {
    return false;
  }
  return buildGameRootCandidates(installRoot, gameTitle).some((gameRoot) => {
    const resolvedGameRoot = path.resolve(gameRoot);
    const resolvedInstallPath = path.resolve(installPath);
    return resolvedGameRoot === resolvedInstallPath || isSubPath(gameRoot, installPath);
  });
}

function buildSuggestedInstallPath(installRoot, gameTitle, installPath, version) {
  const gameRoot = buildInstallDirectory(installRoot, gameTitle);
  const currentBaseName = installPath ? path.basename(path.resolve(installPath)) : "";
  const gameRootBaseName = path.basename(gameRoot);
  const leafName =
    currentBaseName && currentBaseName.toLowerCase() !== gameRootBaseName.toLowerCase()
      ? sanitizePathSegment(currentBaseName)
      : sanitizePathSegment(`${gameTitle}-${version || "files"}`);
  return path.join(gameRoot, leafName);
}

function pickPrimaryGameFolder(folders, compareVersionsFn = compareVersions) {
  const normalizedFolders = Array.isArray(folders) ? folders.filter(Boolean) : [];
  if (normalizedFolders.length === 0) {
    return null;
  }

  const versionedFolders = normalizedFolders.filter((folder) => folder.version);
  const candidateSet = versionedFolders.length > 0 ? versionedFolders : normalizedFolders;

  return [...candidateSet].sort((left, right) => {
    const versionSort = compareVersionsFn(right.version, left.version);
    if (versionSort !== 0) {
      return versionSort;
    }

    const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
    const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }

    return String(left.folderName || "").localeCompare(String(right.folderName || ""), undefined, {
      sensitivity: "base"
    });
  })[0];
}

function deriveInstalledStateFromFolders(folders, fallback = {}) {
  const primaryFolder = pickPrimaryGameFolder(folders);
  return {
    installedVersion: primaryFolder?.version || null,
    installPath: primaryFolder?.folderPath || fallback.installPath || null,
    primaryFolderId: primaryFolder?.id || null
  };
}

module.exports = {
  buildInstallDirectory,
  buildGameRootCandidates,
  buildLegacyInstallDirectory,
  buildSuggestedInstallPath,
  buildVersionedInstallDirectory,
  compareVersions,
  deriveInstalledStateFromFolders,
  delay,
  isExpectedGameInstallPath,
  isSubPath,
  normalizeThreadUrl,
  pickPrimaryGameFolder,
  safeJsonParse,
  sanitizePathSegment,
  sanitizeVersion,
  slugify,
  versionLabel
};
