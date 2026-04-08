const test = require("node:test");
const assert = require("node:assert/strict");
const { extractVersionFromFilename, findBestGameMatch, rankVersionCandidates } = require("../src/main/services/matcher");
const { hasSingleRootDirectory } = require("../src/main/services/extractor");

test("extractVersionFromFilename recognizes version tokens", () => {
  assert.equal(extractVersionFromFilename("Example-Quest-v0.7.2.zip"), "0.7.2");
  assert.equal(extractVersionFromFilename("Another Game 12.rar"), "12");
  assert.equal(extractVersionFromFilename("Example Quest v0.7.2 Build"), "0.7.2");
});

test("extractVersionFromFilename recognizes episodic and build style folder names", () => {
  assert.equal(extractVersionFromFilename("Game Title Ep.1-29"), "Ep.1-29");
  assert.equal(extractVersionFromFilename("Game Title Episode 3"), "Episode 3");
  assert.equal(extractVersionFromFilename("Game Title Ch.2 Part 1"), "Ch.2 Part 1");
  assert.equal(extractVersionFromFilename("Game Title Season 2"), "Season 2");
  assert.equal(extractVersionFromFilename("Game Title build 42"), "build 42");
  assert.equal(extractVersionFromFilename("Summertime Saga 21.0.0 wip.7164"), "21.0.0 wip.7164");
});

test("extractVersionFromFilename rejects common false positives when stronger candidates are absent", () => {
  assert.equal(extractVersionFromFilename("Game Title 1080p x64 Win"), null);
  assert.equal(extractVersionFromFilename("Game Title 2024"), null);
});

test("rankVersionCandidates prefers fuller matches over partial numeric fragments", () => {
  const ranked = rankVersionCandidates("Example Quest v0.7.2 Build 5");
  assert.equal(ranked[0].version, "0.7.2");
  assert.ok(ranked.some((candidate) => candidate.version === "Build 5"));
});

test("extractVersionFromFilename uses known versions as a ranking signal", () => {
  assert.equal(
    extractVersionFromFilename("Summertime Saga 21.0.0 wip.7164", {
      currentVersion: "v21.0.0 wip.7164",
      installedVersion: "20.16.0"
    }),
    "21.0.0 wip.7164"
  );
  assert.equal(
    extractVersionFromFilename("Game Name 1-29", {
      currentVersion: "Ep.1-29"
    }),
    "Ep.1-29"
  );
  assert.equal(
    extractVersionFromFilename("Game Name 21.0.0", {
      currentVersion: "v21.0.0 wip.7164"
    }),
    "21.0.0 wip.7164"
  );
});

test("findBestGameMatch returns high confidence for direct title matches", () => {
  const games = [
    {
      id: 1,
      title: "Example Quest",
      aliases: JSON.stringify(["Example Quest", "EQ"]),
      current_version: "0.7.2",
      installed_version: null
    },
    {
      id: 2,
      title: "Other Story",
      aliases: JSON.stringify([]),
      current_version: "1.0",
      installed_version: null
    }
  ];

  const result = findBestGameMatch("Example Quest v0.7.2.zip", games);
  assert.equal(result.kind, "matched");
  assert.equal(result.bestMatch.gameId, 1);
  assert.equal(result.bestMatch.version, "0.7.2");
});

test("findBestGameMatch requests review on ambiguous matches", () => {
  const games = [
    {
      id: 1,
      title: "Summer Heat",
      aliases: JSON.stringify(["Summer"]),
      current_version: "0.1",
      installed_version: null
    },
    {
      id: 2,
      title: "Summer Heat 2",
      aliases: JSON.stringify(["Summer"]),
      current_version: "0.1",
      installed_version: null
    }
  ];

  const result = findBestGameMatch("summer heat.zip", games);
  assert.equal(result.kind, "needs-review");
  assert.equal(result.candidates.length, 2);
});

test("findBestGameMatch accepts hydrated game objects", () => {
  const games = [
    {
      id: 1,
      title: "Summertime Saga",
      aliases: ["Summertime Saga", "STS"],
      currentVersion: "v21.0.0 wip.7164",
      installedVersion: null
    }
  ];

  const result = findBestGameMatch("Summertime Saga v21.0.0 wip.7164.zip", games);
  assert.equal(result.kind, "matched");
  assert.equal(result.bestMatch.gameId, 1);
  assert.equal(result.bestMatch.version, "21.0.0 wip.7164");
});

test("hasSingleRootDirectory detects whether an archive unwraps into one folder", () => {
  assert.equal(
    hasSingleRootDirectory([
      { path: "Game Folder", isDirectory: true },
      { path: "Game Folder/file.exe", isDirectory: false },
      { path: "Game Folder/data/data.rpa", isDirectory: false }
    ]),
    true
  );

  assert.equal(
    hasSingleRootDirectory([
      { path: "file.exe", isDirectory: false },
      { path: "data/file.rpa", isDirectory: false }
    ]),
    false
  );
});
