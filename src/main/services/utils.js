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

function extractThreadId(input) {
  const normalizedUrl = normalizeThreadUrl(input);
  const match = normalizedUrl.match(/\.([0-9]+)\/$/);
  if (!match) {
    throw new Error("Could not extract the thread id from the URL.");
  }

  return match[1];
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

  const allHaveSortRank = normalizedFolders.every((folder) => Number.isFinite(Number(folder.sortRank)));
  if (!allHaveSortRank) {
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

  return [...normalizedFolders].sort((left, right) => {
    const leftRank = Number.isFinite(Number(left.sortRank)) ? Number(left.sortRank) : Number.MAX_SAFE_INTEGER;
    const rightRank = Number.isFinite(Number(right.sortRank)) ? Number(right.sortRank) : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return Number(left.id || 0) - Number(right.id || 0);
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

function getSeasonOrderingValues(seasonNumbers) {
  const normalized = [...new Set((seasonNumbers || []).filter((value) => Number.isInteger(value)))].sort((a, b) => a - b);
  if (normalized.length === 0) {
    return [];
  }

  const highest = normalized[normalized.length - 1];
  return [highest, ...normalized.filter((value) => value !== highest)];
}

function compareFoldersForStableRanking(left, right, compareVersionsFn = compareVersions) {
  const versionSort = compareVersionsFn(right.version, left.version);
  if (versionSort !== 0) {
    return versionSort;
  }

  const leftRank = Number.isFinite(Number(left.sortRank)) ? Number(left.sortRank) : Number.MAX_SAFE_INTEGER;
  const rightRank = Number.isFinite(Number(right.sortRank)) ? Number(right.sortRank) : Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  const leftTime = new Date(left.createdAt || left.updatedAt || 0).getTime();
  const rightTime = new Date(right.createdAt || right.updatedAt || 0).getTime();
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return String(left.folderName || "").localeCompare(String(right.folderName || ""), undefined, {
    sensitivity: "base"
  });
}

function rankGameFolders(folders, options = {}) {
  const normalizedFolders = Array.isArray(folders) ? folders.filter(Boolean).map((folder) => ({ ...folder })) : [];
  const hasSeasons = Boolean(options.hasSeasons);
  const compareVersionsFn = options.compareVersionsFn || compareVersions;
  if (normalizedFolders.length === 0) {
    return [];
  }

  const groups = new Map();
  const pushToGroup = (groupKey, folder) => {
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(folder);
  };

  if (!hasSeasons) {
    normalizedFolders.forEach((folder) => pushToGroup("all", folder));
  } else {
    normalizedFolders.forEach((folder) => {
      if (Number.isInteger(folder.seasonNumber)) {
        pushToGroup(`season:${folder.seasonNumber}`, folder);
      } else {
        pushToGroup("season:none", folder);
      }
    });
  }

  const seasonOrder = hasSeasons
    ? getSeasonOrderingValues(
        normalizedFolders.map((folder) => (Number.isInteger(folder.seasonNumber) ? folder.seasonNumber : null))
      ).map((season) => `season:${season}`)
    : ["all"];
  const groupOrder = hasSeasons && groups.has("season:none") ? [...seasonOrder, "season:none"] : seasonOrder;

  const orderedFolders = [];
  for (const groupKey of groupOrder) {
    const groupFolders = groups.get(groupKey) || [];
    orderedFolders.push(...groupFolders.sort((left, right) => compareFoldersForStableRanking(left, right, compareVersionsFn)));
  }

  return orderedFolders.map((folder, index) => ({
    ...folder,
    sortRank: index + 1
  }));
}

function normalizeLaunchCandidate(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.exe$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeLaunchCandidate(value) {
  return normalizeLaunchCandidate(value)
    .split(/\s+/)
    .filter(Boolean);
}

function uniqueLaunchTerms(values) {
  const terms = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeLaunchCandidate(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    terms.push(normalized);
  }

  return terms.sort((left, right) => right.length - left.length);
}

function scoreLaunchExecutable(fileName, game = {}) {
  const candidate = normalizeLaunchCandidate(fileName);
  const candidateTokens = tokenizeLaunchCandidate(fileName);
  const terms = uniqueLaunchTerms([game.title, game.threadTitle, ...(game.aliases || [])]);
  const negativePatterns = [
    "unitycrashhandler",
    "crashhandler",
    "notificationhelper",
    "unins",
    "uninstall",
    "setup",
    "updater",
    "patch",
    "dxwebsetup",
    "vc redist",
    "vc redist x64",
    "vc redist x86",
    "vcredist",
    "redist",
    "support"
  ];

  let score = 0;
  let matchedTerm = false;

  for (const term of terms) {
    const termTokens = tokenizeLaunchCandidate(term);
    if (!termTokens.length) {
      continue;
    }

    if (candidate === term) {
      score += 180;
      matchedTerm = true;
      continue;
    }

    if (candidate.startsWith(term)) {
      score += 120;
      matchedTerm = true;
    } else if (candidate.includes(term)) {
      score += 90;
      matchedTerm = true;
    }

    const tokenMatches = termTokens.filter((token) => candidateTokens.includes(token)).length;
    if (tokenMatches > 0) {
      score += tokenMatches * 16;
      matchedTerm = true;
    }
  }

  for (const pattern of negativePatterns) {
    if (candidate.includes(pattern)) {
      score -= 140;
    }
  }

  if (candidate.includes("launcher")) {
    score -= 20;
  }

  if (!matchedTerm) {
    score += Math.max(6, 40 - candidate.length);
  } else {
    score += Math.max(0, 28 - candidate.length);
  }

  score += Math.max(0, 10 - Math.max(0, candidateTokens.length - 1) * 2);

  return score;
}

function rankLaunchExecutables(executables, game = {}) {
  const ranked = (Array.isArray(executables) ? executables : []).map((entry) => {
    const fileName = typeof entry === "string" ? entry : entry.fileName;
    const fullPath = typeof entry === "string" ? entry : entry.fullPath;
    const score = scoreLaunchExecutable(fileName, game);
    return {
      fileName,
      fullPath,
      score,
      isRecommended: false
    };
  });

  ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    if (left.fileName.length !== right.fileName.length) {
      return left.fileName.length - right.fileName.length;
    }

    return left.fileName.localeCompare(right.fileName, undefined, { sensitivity: "base" });
  });

  if (ranked[0]) {
    ranked[0].isRecommended = true;
  }

  return ranked;
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
  extractThreadId,
  isExpectedGameInstallPath,
  isSubPath,
  normalizeThreadUrl,
  pickPrimaryGameFolder,
  rankGameFolders,
  rankLaunchExecutables,
  safeJsonParse,
  scoreLaunchExecutable,
  sanitizePathSegment,
  sanitizeVersion,
  slugify,
  versionLabel
};
