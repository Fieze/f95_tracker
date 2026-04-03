const test = require("node:test");
const assert = require("node:assert/strict");
const { extractVersionFromFilename, findBestGameMatch } = require("../src/main/services/matcher");
const { hasSingleRootDirectory } = require("../src/main/services/extractor");

test("extractVersionFromFilename recognizes version tokens", () => {
  assert.equal(extractVersionFromFilename("Example-Quest-v0.7.2.zip"), "0.7.2");
  assert.equal(extractVersionFromFilename("Another Game 12.rar"), "12");
  assert.equal(extractVersionFromFilename("Example Quest v0.7.2 Build"), "0.7");
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
  assert.equal(result.bestMatch.version, "21.0.0");
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
