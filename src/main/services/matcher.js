const path = require("path");
const { safeJsonParse, sanitizeVersion, slugify } = require("./utils");

function extractVersionFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  const patterns = [
    /\b(?:v(?:ersion)?\.?\s*)([0-9][0-9a-z._-]*)\b/i,
    /\b([0-9]+\.[0-9][0-9a-z._-]*)\b/i,
    /\b([0-9]{2,}[a-z]?)\b/i
  ];

  for (const pattern of patterns) {
    const match = base.match(pattern);
    if (match) {
      return sanitizeVersion(match[1]).replace(/^[vV]\s*/, "");
    }
  }

  return null;
}

function tokenizeTitle(value) {
  return slugify(value)
    .split("-")
    .filter((token) => token.length > 1);
}

function scoreGameMatch(filename, game) {
  const haystack = slugify(path.basename(filename, path.extname(filename)));
  const aliases = Array.isArray(game.aliases) ? game.aliases : safeJsonParse(game.aliases, []);
  const currentVersion = game.currentVersion || game.current_version || null;
  const installedVersion = game.installedVersion || game.installed_version || null;
  const tokens = new Set([
    ...tokenizeTitle(game.title),
    ...aliases.flatMap(tokenizeTitle)
  ]);

  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token.length >= 5 ? 16 : 8;
    }
  }

  const version = extractVersionFromFilename(filename);
  if (version && currentVersion && version === sanitizeVersion(currentVersion).replace(/^[vV]\s*/, "")) {
    score += 18;
  }
  if (version && installedVersion && version === sanitizeVersion(installedVersion).replace(/^[vV]\s*/, "")) {
    score += 8;
  }

  if (haystack.includes(slugify(game.title))) {
    score += 30;
  }

  return {
    score,
    version
  };
}

function findBestGameMatch(filename, games) {
  const ranked = games
    .map((game) => ({ game, ...scoreGameMatch(filename, game) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  const best = ranked[0];
  const second = ranked[1];

  if (!best) {
    return {
      kind: "unmatched",
      confidence: "low",
      candidates: []
    };
  }

  const hasStrongLead = !second || best.score - second.score >= 18;
  const hasAmbiguousRunnerUp = second && second.score >= 20 && !best.version;
  const confidence = best.score >= 42 && hasStrongLead && !hasAmbiguousRunnerUp ? "high" : "medium";

  return {
    kind: confidence === "high" ? "matched" : "needs-review",
    confidence,
    bestMatch: {
      gameId: best.game.id,
      gameTitle: best.game.title,
      version: best.version,
      score: best.score
    },
    candidates: ranked.slice(0, 5).map((entry) => ({
      gameId: entry.game.id,
      gameTitle: entry.game.title,
      version: entry.version,
      score: entry.score
    }))
  };
}

module.exports = {
  extractVersionFromFilename,
  findBestGameMatch
};
