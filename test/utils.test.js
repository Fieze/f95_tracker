const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildGameRootCandidates,
  buildInstallDirectory,
  buildSuggestedInstallPath,
  buildVersionedInstallDirectory,
  compareVersions,
  deriveInstalledStateFromFolders,
  isExpectedGameInstallPath,
  normalizeThreadUrl,
  rankGameFolders,
  rankLaunchExecutables,
  versionLabel
} = require("../src/main/services/utils");

test("normalizeThreadUrl strips extra path fragments", () => {
  assert.equal(
    normalizeThreadUrl("https://f95zone.to/threads/example-game.12345/page-2"),
    "https://f95zone.to/threads/example-game.12345/"
  );
});

test("compareVersions sorts dotted values correctly", () => {
  assert.equal(compareVersions("0.15.1", "0.9"), 1);
  assert.equal(compareVersions("v1.0", "1.0"), 0);
  assert.equal(compareVersions("1.0a", "1.0"), 1);
});

test("versionLabel reports update state", () => {
  assert.equal(versionLabel("0.5", "0.4"), "update-available");
  assert.equal(versionLabel("0.5", "0.5"), "up-to-date");
  assert.equal(versionLabel("0.5", null), "not-installed");
});

test("buildVersionedInstallDirectory creates a safe title-version folder", () => {
  assert.equal(
    buildVersionedInstallDirectory("D:\\Games", "Away from Home", "Ep.1-29"),
    "D:\\Games\\Away from Home-Ep.1-29"
  );
});

test("buildInstallDirectory keeps the visible title while sanitizing filesystem-invalid characters", () => {
  assert.equal(buildInstallDirectory("D:\\Games", "Away: from <Home>?"), "D:\\Games\\Away- from -Home-");
});

test("isExpectedGameInstallPath accepts the game root and nested managed folders", () => {
  const gameRoot = buildInstallDirectory("D:\\Games", "Away from Home");
  assert.equal(isExpectedGameInstallPath("D:\\Games", "Away from Home", `${gameRoot}\\Episode-1-29`), true);
  assert.equal(isExpectedGameInstallPath("D:\\Games", "Away from Home", gameRoot), true);
});

test("buildGameRootCandidates keeps both visible-title and legacy slug roots", () => {
  assert.deepEqual(buildGameRootCandidates("D:\\Games", "Away from Home"), [
    "D:\\Games\\Away from Home",
    "D:\\Games\\away-from-home"
  ]);
});

test("buildSuggestedInstallPath keeps a distinct folder name or falls back to title-version", () => {
  assert.equal(
    buildSuggestedInstallPath("D:\\Games", "Away from Home", "E:\\Installs\\AFH-Ep1", "Ep.1-29"),
    "D:\\Games\\Away from Home\\AFH-Ep1"
  );
  assert.equal(
    buildSuggestedInstallPath("D:\\Games", "Away from Home", "D:\\Games\\Away from Home", "Ep.1-29"),
    "D:\\Games\\Away from Home\\Away from Home-Ep.1-29"
  );
});

test("deriveInstalledStateFromFolders uses the highest versioned folder as the installed state", () => {
  const derived = deriveInstalledStateFromFolders([
    {
      id: 1,
      folderName: "Away from Home-0.8",
      folderPath: "D:\\Games\\Away from Home\\Away from Home-0.8",
      version: "0.8",
      updatedAt: "2026-04-01T10:00:00.000Z"
    },
    {
      id: 2,
      folderName: "Away from Home-0.10",
      folderPath: "D:\\Games\\Away from Home\\Away from Home-0.10",
      version: "0.10",
      updatedAt: "2026-04-02T10:00:00.000Z"
    }
  ]);

  assert.equal(derived.primaryFolderId, 2);
  assert.equal(derived.installedVersion, "0.10");
  assert.equal(derived.installPath, "D:\\Games\\Away from Home\\Away from Home-0.10");
});

test("rankLaunchExecutables prefers the most game-like executable over helpers", () => {
  const ranked = rankLaunchExecutables(
    [
      { fileName: "UnityCrashHandler64.exe", fullPath: "D:\\Games\\Game\\UnityCrashHandler64.exe" },
      { fileName: "Away From Home.exe", fullPath: "D:\\Games\\Game\\Away From Home.exe" },
      { fileName: "unins000.exe", fullPath: "D:\\Games\\Game\\unins000.exe" }
    ],
    {
      title: "Away From Home",
      aliases: ["AFH"]
    }
  );

  assert.equal(ranked[0].fileName, "Away From Home.exe");
  assert.equal(ranked[0].isRecommended, true);
});

test("rankLaunchExecutables can fall back to aliases when the title is absent", () => {
  const ranked = rankLaunchExecutables(
    [
      { fileName: "AFH.exe", fullPath: "D:\\Games\\Game\\AFH.exe" },
      { fileName: "support-tool.exe", fullPath: "D:\\Games\\Game\\support-tool.exe" }
    ],
    {
      title: "Away From Home",
      aliases: ["AFH"]
    }
  );

  assert.equal(ranked[0].fileName, "AFH.exe");
  assert.equal(ranked[0].isRecommended, true);
});

test("rankGameFolders orders versions descending without seasons", () => {
  const ranked = rankGameFolders(
    [
      { id: 1, folderName: "Game-0.8", version: "0.8", sortRank: 2 },
      { id: 2, folderName: "Game-1.0", version: "1.0", sortRank: 3 },
      { id: 3, folderName: "Game-0.9", version: "0.9", sortRank: 1 }
    ],
    { hasSeasons: false }
  );

  assert.deepEqual(ranked.map((folder) => folder.id), [2, 3, 1]);
  assert.deepEqual(ranked.map((folder) => folder.sortRank), [1, 2, 3]);
});

test("rankGameFolders orders seasons as highest then ascending from the first", () => {
  const ranked = rankGameFolders(
    [
      { id: 1, folderName: "S1-1.0", version: "1.0", seasonNumber: 1, sortRank: 1 },
      { id: 2, folderName: "S4-1.0", version: "1.0", seasonNumber: 4, sortRank: 2 },
      { id: 3, folderName: "S2-1.0", version: "1.0", seasonNumber: 2, sortRank: 3 },
      { id: 4, folderName: "S3-1.0", version: "1.0", seasonNumber: 3, sortRank: 4 }
    ],
    { hasSeasons: true }
  );

  assert.deepEqual(ranked.map((folder) => folder.seasonNumber), [4, 1, 2, 3]);
});

test("rankGameFolders keeps stable order for equal or missing versions", () => {
  const ranked = rankGameFolders(
    [
      { id: 1, folderName: "Game-A", version: null, sortRank: 2 },
      { id: 2, folderName: "Game-B", version: null, sortRank: 1 }
    ],
    { hasSeasons: false }
  );

  assert.deepEqual(ranked.map((folder) => folder.id), [2, 1]);
});
