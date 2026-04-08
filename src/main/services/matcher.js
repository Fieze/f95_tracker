const path = require("path");
const { compareVersions, safeJsonParse, sanitizeVersion, slugify } = require("./utils");

function normalizeVersionCandidate(value) {
  return sanitizeVersion(String(value || "").replace(/\s+/g, " ").trim())
    ?.replace(/^[vV]\s*/, "")
    .replace(/\b(?:final|fixed|hotfix|patch)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function canonicalVersionKey(value) {
  return normalizeVersionCandidate(value)?.toLowerCase().replace(/[^a-z0-9]+/g, "") || "";
}

function tokenizeVersionSimilarity(value) {
  const normalized = normalizeVersionCandidate(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .toLowerCase()
    .replace(/\b(?:version|episode|ep|chapter|ch|season|build|wip)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function stripArchiveExtension(value) {
  const extension = path.extname(value);
  if (!/^\.(zip|rar|7z)$/i.test(extension)) {
    return value;
  }
  return path.basename(value, extension);
}

function getKnownVersionForms(gameOrOptions = {}) {
  const values = [
    gameOrOptions.currentVersion,
    gameOrOptions.current_version,
    gameOrOptions.installedVersion,
    gameOrOptions.installed_version,
    ...(Array.isArray(gameOrOptions.knownVersions) ? gameOrOptions.knownVersions : [])
  ]
    .map((value) => normalizeVersionCandidate(value))
    .filter(Boolean);

  const unique = [...new Set(values)];
  const forms = new Set();
  unique.forEach((value) => {
    forms.add(canonicalVersionKey(value));
    forms.add(canonicalVersionKey(value.replace(/\b(?:wip|build)\b.*$/i, "").trim()));
    const numericPrefix = value.match(/^\d+(?:\.\d+)*(?:[a-z])?/i)?.[0];
    if (numericPrefix) {
      forms.add(canonicalVersionKey(numericPrefix));
    }
  });

  return forms;
}

function getKnownVersions(gameOrOptions = {}) {
  const values = [
    gameOrOptions.currentVersion,
    gameOrOptions.current_version,
    gameOrOptions.installedVersion,
    gameOrOptions.installed_version,
    ...(Array.isArray(gameOrOptions.knownVersions) ? gameOrOptions.knownVersions : [])
  ]
    .map((value) => normalizeVersionCandidate(value))
    .filter(Boolean);

  return [...new Set(values)].map((value, index) => ({
    value,
    priority: index,
    canonical: canonicalVersionKey(value),
    tokens: tokenizeVersionSimilarity(value)
  }));
}

function makeCandidate(source, rawMatch, value, index, extraScore = 0) {
  const normalized = normalizeVersionCandidate(value);
  if (!normalized) {
    return null;
  }

  return {
    source,
    raw: rawMatch,
    version: normalized,
    index,
    score: extraScore
  };
}

function collectRegexCandidates(baseName) {
  const candidates = [];
  const patterns = [
    {
      source: "explicit-version",
      score: 110,
      regex: /\b(?:v(?:ersion)?\.?\s*)([0-9]+(?:[._-][0-9a-z]+)*(?:\s+wip[._-]?\d+)?)\b/gi
    },
    {
      source: "episode",
      score: 108,
      regex: /\b(ep(?:isode)?\.?\s*\d+(?:[._-]\d+)*(?:\s*(?:part|pt)\s*\d+)?)\b/gi
    },
    {
      source: "chapter",
      score: 106,
      regex: /\b(ch(?:apter)?\.?\s*\d+(?:[._-]\d+)*(?:\s*(?:part|pt)\s*\d+)?)\b/gi
    },
    {
      source: "season",
      score: 104,
      regex: /\b(season\s*\d+(?:[._-]\d+)*)\b/gi
    },
    {
      source: "build",
      score: 100,
      regex: /\b(build\s*\d+)\b/gi
    },
    {
      source: "wip",
      score: 98,
      regex: /\b(wip[._-]?\d+)\b/gi
    },
    {
      source: "semantic",
      score: 92,
      regex: /\b(\d+\.\d+(?:\.\d+)*(?:[a-z])?(?:\s+wip[._-]?\d+)?)\b/gi
    },
    {
      source: "numeric-range",
      score: 58,
      regex: /\b(\d+(?:-\d+)+)\b/gi
    },
    {
      source: "bare-number",
      score: 48,
      regex: /\b(\d{2,4}[a-z]?)\b/gi
    }
  ];

  for (const { source, score, regex } of patterns) {
    for (const match of baseName.matchAll(regex)) {
      const candidate = makeCandidate(source, match[0], match[1], match.index ?? -1, score);
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function scoreVersionCandidate(candidate, baseName, knownVersionForms) {
  let score = candidate.score;
  const raw = candidate.raw.toLowerCase();
  const baseLower = baseName.toLowerCase();
  const canonical = canonicalVersionKey(candidate.version);

  if (/(?:^|[\s\[(._-])(win|windows|linux|mac|android|pc)(?:$|[\s\]) ._-])/i.test(candidate.raw)) {
    score -= 80;
  }
  if (/\b(?:x64|x86|64bit|32bit|1080p|720p|2160p)\b/i.test(raw)) {
    score -= 70;
  }
  if (/^(19|20)\d{2}[a-z]?$/i.test(candidate.version) && !/(ep|episode|chapter|season|build|wip|v|version)/i.test(raw)) {
    score -= 45;
  }
  if (candidate.index >= Math.max(0, baseName.length - candidate.raw.length - 10)) {
    score += 16;
  }
  if (/[\[(._ -](?:v|ver|version|ep|episode|ch|chapter|season|build|wip)/i.test(baseLower.slice(Math.max(0, candidate.index - 2), candidate.index + candidate.raw.length + 2))) {
    score += 8;
  }
  if (candidate.source !== "bare-number") {
    score += Math.min(20, candidate.version.length);
  }
  if (canonical && knownVersionForms.has(canonical)) {
    score += 34;
  }
  if (candidate.source === "bare-number" && /^\d{4}$/.test(candidate.version)) {
    score -= 20;
  }

  return score;
}

function rankVersionCandidates(baseName, options = {}) {
  const knownVersionForms = getKnownVersionForms(options);
  const rawCandidates = collectRegexCandidates(baseName)
    .map((candidate) => ({
      ...candidate,
      score: scoreVersionCandidate(candidate, baseName, knownVersionForms)
    }))
    .filter((candidate) => candidate.score > 0);

  const deduped = new Map();
  for (const candidate of rawCandidates) {
    const key = canonicalVersionKey(candidate.version);
    const existing = deduped.get(key);
    if (!existing || compareCandidateOrder(candidate, existing) < 0) {
      deduped.set(key, candidate);
    }
  }

  return [...deduped.values()].sort(compareCandidateOrder);
}

function compareCandidateOrder(left, right) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (right.version.length !== left.version.length) {
    return right.version.length - left.version.length;
  }
  return left.index - right.index;
}

function tokensMatchByPrefix(leftTokens, rightTokens) {
  if (!leftTokens.length || !rightTokens.length) {
    return false;
  }

  const minLength = Math.min(leftTokens.length, rightTokens.length);
  for (let index = 0; index < minLength; index += 1) {
    if (leftTokens[index] !== rightTokens[index]) {
      return false;
    }
  }

  return true;
}

function chooseKnownVersionLabel(candidate, options = {}) {
  const knownVersions = getKnownVersions(options);
  if (knownVersions.length === 0) {
    return candidate.version;
  }

  const candidateCanonical = canonicalVersionKey(candidate.version);
  const candidateTokens = tokenizeVersionSimilarity(candidate.version);
  const exactMatch = knownVersions.find((known) => known.canonical === candidateCanonical);
  if (exactMatch) {
    return exactMatch.value;
  }

  const preferredKnown = knownVersions.find((known) => {
    if (candidate.source === "bare-number" && candidateTokens.length < 2) {
      return false;
    }

    if (!tokensMatchByPrefix(candidateTokens, known.tokens)) {
      return false;
    }

    return (
      known.tokens.length > candidateTokens.length ||
      known.value.length > candidate.version.length
    );
  });

  return preferredKnown?.value || candidate.version;
}

function extractVersionFromFilename(filename, options = {}) {
  const base = stripArchiveExtension(path.basename(filename));
  const ranked = rankVersionCandidates(base, options);
  if (!ranked[0]) {
    return null;
  }

  return chooseKnownVersionLabel(ranked[0], options);
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

  const version = extractVersionFromFilename(filename, game);
  if (version && currentVersion && canonicalVersionKey(version) === canonicalVersionKey(currentVersion)) {
    score += 18;
  }
  if (version && installedVersion && canonicalVersionKey(version) === canonicalVersionKey(installedVersion)) {
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
  findBestGameMatch,
  rankVersionCandidates
};
