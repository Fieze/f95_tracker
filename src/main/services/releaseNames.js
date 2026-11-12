// Reads the structure out of release names (folder names, archive names, thread titles, download labels):
// the game title, the branch (chapter / season / special), the variant (HQ, LQ, Split, ...) and the version.
// Pure functions without I/O, so they can be tested with plain strings.
const { compareVersions, sanitizeVersion } = require("./utils");

const SPECIAL_WORDS = "christmas|xmas|halloween|summer|winter|spring|autumn|valentine(?:'?s)?|easter|new[ -]?year'?s?|anniversary|holiday|birthday|bonus";
const SPECIAL_PATTERN = new RegExp(`\\b(${SPECIAL_WORDS})[ _.-]+(?:special|episode|story|edition|event)\\b`, "i");
const PLAIN_SPECIAL_PATTERN = /\bspecial\b(?!\s+thanks)/i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ROMAN_NUMERALS = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
const NUMBER = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|[ivx]{1,4})";
const RANGE_JOIN = "\\s*(?:-|–|—|&|\\+|\\bto\\b|\\band\\b)\\s*";

// The kinds of branch a release can be split into. "core" kinds are also read from loose text (changelog lines, the
// game's name); the others only from places that are written as a release label (title bracket, download headings,
// archive and folder names), because "act 2" or "part 3" are too common in ordinary sentences.
const BRANCH_KINDS = [
  { type: "season", label: "Season", words: "seasons?", core: true, shorthand: true },
  { type: "chapter", label: "Chapter", words: "chapters?|chap|ch", core: true },
  { type: "book", label: "Book", words: "books?" },
  { type: "volume", label: "Volume", words: "volumes?|vol" },
  { type: "act", label: "Act", words: "acts?" },
  { type: "part", label: "Part", words: "parts?|pt", notSplit: true }
].map((kind) => {
  const lead = (kind.notSplit ? "(?<!\\.)" : "") + "\\b(?:" + kind.words + ")\\.?\\s*";
  const single = lead + "0*" + NUMBER + "(?![a-z0-9])" + (kind.notSplit ? "(?!\\s*(?:of|\\/)\\s*\\d)" : "");
  const range = lead + "0*" + NUMBER + RANGE_JOIN + "(?:(?:" + kind.words + ")\\.?\\s*)?0*" + NUMBER + "(?![a-z0-9])(?!\\.\\d)";
  return { ...kind, single: new RegExp(single, "gi"), range: new RegExp(range, "gi") };
});
// "S2", "S02E05", "S1+S2": only digits, directly after the letter, and never a version such as "s2.5".
const SEASON_SHORT_PATTERN = /(?<!['’\w])s0*(\d{1,2})(?!\.?\d)(?=$|[^a-z0-9]|e(?:p|\d))/gi;
const SEASON_SHORT_RANGE_PATTERN = /(?<!['’\w])s0*(\d{1,2})(?:\s*(?:&|\+)\s*s?|\s*(?:-|–)\s*s)0*(\d{1,2})(?![a-z0-9])(?!\.\d)/gi;

function capitalize(value) {
  return String(value || "").replace(/(^|[\s'-])([a-z])/g, (_, lead, letter) => lead + letter.toUpperCase());
}

function normalizeSpecialName(word) {
  const lower = String(word).toLowerCase().replace(/[ -]/g, "");
  if (lower === "xmas") return "Christmas";
  if (lower.startsWith("valentine")) return "Valentine's";
  if (lower.startsWith("newyear")) return "New Year";
  return capitalize(lower);
}

// Digits, number words ("Two") and upper-case roman numerals ("IV"); lower-case "v" or "i" is ordinary text.
function toNumber(token) {
  const raw = String(token || "");
  if (/^\d+$/.test(raw)) return Number(raw);
  return NUMBER_WORDS[raw.toLowerCase()] || ROMAN_NUMERALS[raw] || null;
}

function firstValidMatch(value, pattern, build) {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    const result = build(match);
    if (result) return result;
  }
  return null;
}

function findBranchOfKind(value, kind) {
  const asRange = (match) => {
    const from = toNumber(match[1]);
    const to = toNumber(match[2]);
    if (!from || !to || to <= from || to - from >= 30) return null;
    return { type: kind.type, label: kind.label + " " + to, number: to, range: [from, to], index: match.index, raw: match[0] };
  };
  const asSingle = (match) => {
    const number = toNumber(match[1]);
    if (number === null) return null;
    return { type: kind.type, label: kind.label + " " + number, number, index: match.index, raw: match[0] };
  };
  return firstValidMatch(value, kind.range, asRange) ||
    (kind.shorthand && firstValidMatch(value, SEASON_SHORT_RANGE_PATTERN, asRange)) ||
    firstValidMatch(value, kind.single, asSingle) ||
    (kind.shorthand && firstValidMatch(value, SEASON_SHORT_PATTERN, asSingle)) ||
    null;
}

// First branch mentioned in the text, or null. A season wins over a chapter ("S2 Ch.10" is season 2).
// "range" is set for "Ch. 1-4" or "Season 1 & 2" (the release covers several of them); the label names the last one.
// With extended: false only seasons, chapters and specials are recognised (see BRANCH_KINDS).
function parseBranch(text, { extended = true } = {}) {
  const value = String(text || "");
  let match = value.match(SPECIAL_PATTERN);
  if (match) return { type: "special", label: normalizeSpecialName(match[1]) + " Special", number: null, index: match.index, raw: match[0] };
  for (const kind of BRANCH_KINDS) {
    if (!extended && !kind.core) continue;
    const found = findBranchOfKind(value, kind);
    if (found) return found;
  }
  match = value.match(PLAIN_SPECIAL_PATTERN);
  if (match) return { type: "special", label: "Special", number: null, index: match.index, raw: match[0] };
  return null;
}

function kindLabel(type) {
  return BRANCH_KINDS.find((kind) => kind.type === type)?.label || "";
}

// "Season 1-2" for a range, the plain label otherwise. Used where several branches ship as one download.
function branchDisplayLabel(branch) {
  if (!branch) return null;
  return branch.range ? kindLabel(branch.type) + " " + branch.range[0] + "-" + branch.range[1] : branch.label;
}

// Every branch label the text implies: a range expands to all of its members.
function expandBranches(text, options) {
  const branch = parseBranch(text, options);
  if (!branch) return [];
  if (branch.range) {
    const labels = [];
    for (let number = branch.range[0]; number <= branch.range[1]; number += 1) labels.push(kindLabel(branch.type) + " " + number);
    return labels;
  }
  return [branch.label];
}

// The label when the whole text is nothing but a branch ("Chapter 2", "S4", "Season 1-2", "Christmas Special"),
// else null. Used to tell branch sub-folders from version folders.
function branchLabelOfWholeName(name) {
  const text = String(name || "").trim();
  const branch = parseBranch(text);
  if (!branch) return null;
  const rest = text.replace(branch.raw, " ").replace(/[\s._\-()[\]]+/g, "");
  return rest ? null : branchDisplayLabel(branch);
}

// Variant keywords found in a release name or a download label.
function parseVariant(text) {
  const value = String(text || "");
  const split = /\bsplit\b|\.part0*\d+\b|\.0{1,2}1\b|\bpart[ _-]?\d+\s*(?:of|\/)\s*\d+\b/i.test(value);
  let variant = "";
  if (split) variant = "Split";
  else if (/\bhq\b|high[ -]?quality/i.test(value)) variant = "HQ";
  else if (/\blq\b|low[ -]?quality/i.test(value)) variant = "LQ";
  else if (/\bcompressed\b/i.test(value)) variant = "Compressed";
  else if (/\buncompressed\b/i.test(value)) variant = "Uncompressed";
  return { variant, split };
}

function parsePlatform(text) {
  const value = String(text || "");
  if (/win\/linux\/mac/i.test(value)) return "Win/Linux/Mac";
  if (/win\/linux/i.test(value)) return "Win/Linux";
  if (/\bandroid\b|\.apk\b/i.test(value)) return "Android";
  if (/\bmac(?:os)?\b/i.test(value)) return "Mac";
  if (/\blinux\b/i.test(value)) return "Linux";
  if (/\bwin(?:dows)?\b|\bpc\b/i.test(value)) return "Windows";
  return "";
}

const VERSION_LINE_PATTERN = new RegExp(
  "^[\\s\\W]{0,4}(?:(?:chapter|chap|ch|season|s)\\.?\\s*\\d{1,2}\\b[\\s:,.\\-–—]*)?" +
  "(?:v(?:ersion)?\\.?\\s*)?" +
  "(\\d+(?:\\.\\d+){1,4}[a-z]?(?:[ _-]?(?:wip|beta|alpha|hotfix|rc|fix)[ _.-]?\\d*)?|(?:ep(?:isode)?|part)\\.?\\s*\\d+(?:\\.\\d+)?)",
  "i"
);
const VERSION_WORD_PATTERN = /^[\s\W]{0,4}(?:(?:chapter|chap|ch|season|s)\.?\s*\d{1,2}\b[\s:,.\-–—]*)?v(?:ersion)?\.?\s*(\d+[0-9a-z._-]*)/i;

// Version headings of a changelog, newest first as written: "v0.5 - ...", "Version 0.4.2", "Chapter 2 v0.9".
// Each entry also carries the branch named on the same line, when there is one.
function extractChangelogVersions(text) {
  const seen = new Set();
  const found = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.length > 120) continue;
    const match = line.match(VERSION_LINE_PATTERN) || line.match(VERSION_WORD_PATTERN);
    if (!match) continue;
    const version = sanitizeVersion(match[1]);
    if (!version) continue;
    const branch = parseBranch(line, { extended: false })?.label || null;
    const key = `${branch || ""}|${version.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ version, branch });
  }
  return found;
}

function versionKey(value) {
  return String(value || "").toLowerCase().replace(/^v(?:ersion)?\s*/, "").replace(/[^a-z0-9]+/g, "");
}

// Picks the entry of `options` (strings) that best fits a guessed version; the guess is kept when nothing fits.
function matchVersionOption(guess, options) {
  const list = (options || []).filter(Boolean);
  const key = versionKey(guess);
  if (!key) return { version: "", exact: false };
  const exact = list.find((option) => versionKey(option) === key);
  if (exact) return { version: exact, exact: true };
  const prefix = list.find((option) => versionKey(option).startsWith(key) || key.startsWith(versionKey(option)));
  if (prefix) return { version: prefix, exact: false };
  return { version: String(guess), exact: false };
}

const NOISE_PATTERN = /\b(?:win(?:dows)?|linux|mac(?:os)?|pc|android|x64|x86|64bit|32bit|compressed|uncompressed|uncensored|patreon|public|release|final|hq|lq|split|win\/linux)\b/gi;

// Splits a release name into its parts. `title` is what remains in front of the first recognised part.
function parseReleaseName(name) {
  const base = String(name || "").replace(/\.(zip|rar|7z)$/i, "");
  const spaced = base.replace(/[_]+/g, " ").replace(/(?<=[A-Za-z0-9])\.(?=[A-Za-z]{2,})/g, " ").replace(/\s+/g, " ").trim();
  const branch = parseBranch(spaced);
  const { variant, split } = parseVariant(base.replace(/_/g, " "));
  const versionMatch = spaced.match(/(?:^|[\s\[(._-])v(?:ersion)?\.?\s*(\d[0-9a-z._-]*)/i) || spaced.match(/(?:^|[\s\[(])(\d+\.\d+(?:\.\d+)*[a-z]?)(?=$|[\s\])_-])/i);
  const cuts = [branch?.index, versionMatch ? versionMatch.index : undefined, spaced.search(NOISE_PATTERN)]
    .filter((index) => Number.isInteger(index) && index > 0);
  const cut = cuts.length ? Math.min(...cuts) : spaced.length;
  const title = spaced.slice(0, cut).replace(/[\[(\-–—:,\s]+$/g, "").replace(/^\s*\[[^\]]*\]\s*/, "").trim();
  return {
    title: title || spaced,
    branch: branch ? branch.label : null,
    branchType: branch ? branch.type : null,
    variant,
    split,
    platform: parsePlatform(spaced),
    version: versionMatch ? sanitizeVersion(versionMatch[1]) : null
  };
}

const BRANCH_SORT_ORDER = ["Chapter", "Season", "Book", "Volume", "Act", "Part"];

function branchSortKey(label) {
  const match = /^(Chapter|Season|Book|Volume|Act|Part) (\d+)(?:-\d+)?$/.exec(label);
  if (match) return [BRANCH_SORT_ORDER.indexOf(match[1]), Number(match[2]), label];
  return [BRANCH_SORT_ORDER.length, 0, label];
}

function compareBranches(left, right) {
  const a = branchSortKey(left);
  const b = branchSortKey(right);
  return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
}

// Everything a game knows about its branches and versions, drawn from the thread title, the changelog, the download
// rows, the version history and the installed folders: the branch list, the newest version per branch and the
// version suggestions for the dropdowns.
function buildBranchInfo({ titleBranches = [], currentVersion = null, changelog = "", historyVersions = [], groups = [], folders = [], overrides = {} } = {}) {
  const changelogVersions = extractChangelogVersions(changelog);
  const branchSet = new Set(titleBranches);
  groups.forEach((group) => group.branch && branchSet.add(group.branch));
  folders.forEach((folder) => folder.branch && branchSet.add(folder.branch));
  changelogVersions.forEach((entry) => entry.branch && branchSet.add(entry.branch));
  // Branches the user added by hand, and derived ones the user removed (a branch with installed folders always stays).
  (overrides.added || []).forEach((label) => branchSet.add(label));
  const installedBranches = new Set(folders.map((folder) => folder.branch).filter(Boolean));
  (overrides.removed || []).forEach((label) => { if (!installedBranches.has(label)) branchSet.delete(label); });
  const branches = [...branchSet].sort(compareBranches);

  const branchLatest = {};
  changelogVersions.forEach((entry) => {
    if (entry.branch && !branchLatest[entry.branch]) branchLatest[entry.branch] = entry.version;
  });
  groups.forEach((group) => {
    if (group.branch && group.branchVersion) branchLatest[group.branch] = group.branchVersion;
  });
  // The title's version belongs to the newest branch it names.
  const titleBranch = titleBranches[titleBranches.length - 1];
  if (titleBranch && currentVersion) branchLatest[titleBranch] = currentVersion;

  const options = [];
  const seen = new Set();
  const add = (version, branch) => {
    const text = String(version || "").trim();
    const key = `${branch || ""}|${versionKey(text)}`;
    if (!text || seen.has(key)) return;
    seen.add(key);
    options.push({ version: text, branch: branch || null });
  };
  if (currentVersion) add(currentVersion, titleBranch);
  changelogVersions.forEach((entry) => add(entry.version, entry.branch));
  historyVersions.forEach((version) => add(version, null));
  folders.forEach((folder) => add(folder.version, folder.branch));
  const finalBranches = new Set(overrides.final || []);
  const branchStates = branches.map((branch) => {
    const installed = folders
      .filter((folder) => folder.branch === branch && folder.version)
      .map((folder) => folder.version)
      .sort(compareVersions)
      .pop() || null;
    const latest = branchLatest[branch] || null;
    const isFinal = finalBranches.has(branch);
    return {
      branch,
      installedVersion: installed,
      latestVersion: latest,
      folderCount: folders.filter((folder) => folder.branch === branch).length,
      final: isFinal,
      hasUpdate: Boolean(!isFinal && installed && latest && compareVersions(latest, installed) > 0)
    };
  });
  return { branches, branchLatest, branchStates, versionOptions: options };
}

module.exports = {
  branchDisplayLabel,
  buildBranchInfo,
  compareBranches,
  branchLabelOfWholeName,
  expandBranches,
  extractChangelogVersions,
  matchVersionOption,
  parseBranch,
  parsePlatform,
  parseReleaseName,
  parseVariant
};
