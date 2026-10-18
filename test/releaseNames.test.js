const test = require("node:test");
const assert = require("node:assert/strict");
const {
  branchLabelOfWholeName, expandBranches, extractChangelogVersions, matchVersionOption, parseBranch, parseReleaseName, parseVariant
} = require("../src/main/services/releaseNames");

test("chapters, seasons and specials are recognised as branches", () => {
  assert.equal(parseBranch("Dating My Daughter Ch. 2 v0.5").label, "Chapter 2");
  assert.equal(parseBranch("Dating-My-Daughter-Chapter3-v1.0").label, "Chapter 3");
  assert.equal(parseBranch("Lust Academy S4 v4.10.2a").label, "Season 4");
  assert.equal(parseBranch("Lust Academy Season 2").label, "Season 2");
  assert.equal(parseBranch("Heart Problems Christmas Special").label, "Christmas Special");
  assert.equal(parseBranch("Heart Problems - Special").label, "Special");
  assert.equal(parseBranch("Some Game v0.5"), null);
  assert.equal(parseBranch("Mass Effect s2.5"), null, "a version after an s is not a season");
});

test("a chapter range expands to every chapter", () => {
  assert.deepEqual(expandBranches("Dating My Daughter Ch.1-4 v1.01"), ["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4"]);
  assert.deepEqual(expandBranches("Game S4"), ["Season 4"]);
  assert.deepEqual(expandBranches("Plain Game v1.0"), []);
});

test("only a name that is nothing but a branch counts as a branch folder", () => {
  assert.equal(branchLabelOfWholeName("Chapter 2"), "Chapter 2");
  assert.equal(branchLabelOfWholeName("S4"), "Season 4");
  assert.equal(branchLabelOfWholeName("Christmas Special"), "Christmas Special");
  assert.equal(branchLabelOfWholeName("Game Chapter 2 v0.5"), null);
  assert.equal(branchLabelOfWholeName("v0.5"), null);
});

test("variants and split archives are detected", () => {
  assert.equal(parseVariant("Win/Linux (HQ)").variant, "HQ");
  assert.equal(parseVariant("Win/Linux - LQ").variant, "LQ");
  assert.equal(parseVariant("Win/Linux Compressed").variant, "Compressed");
  assert.deepEqual(parseVariant("Game-v1.0.part1.rar"), { variant: "Split", split: true });
  assert.deepEqual(parseVariant("Win/Linux Split"), { variant: "Split", split: true });
  assert.deepEqual(parseVariant("Win/Linux"), { variant: "", split: false });
});

test("changelog headings become a version list", () => {
  const changelog = [
    "v1.01", "- fixed typos", "",
    "Version 1.0", "- new scenes", "",
    "Chapter 3 v0.9b - Added gallery",
    "[v0.8.1] hotfix",
    "1. fixed a bug",
    "2 new scenes added",
    "Ep. 5",
    "v1.01 again"
  ].join("\n");
  assert.deepEqual(extractChangelogVersions(changelog), [
    { version: "1.01", branch: null },
    { version: "1.0", branch: null },
    { version: "0.9b", branch: "Chapter 3" },
    { version: "0.8.1", branch: null },
    { version: "Ep. 5", branch: null }
  ]);
});

test("a guessed version snaps to the closest changelog entry", () => {
  const options = ["1.01", "1.0", "0.9b"];
  assert.deepEqual(matchVersionOption("v1.01", options), { version: "1.01", exact: true });
  assert.deepEqual(matchVersionOption("0.9", options), { version: "0.9b", exact: false });
  assert.deepEqual(matchVersionOption("2.0", options), { version: "2.0", exact: false });
  assert.deepEqual(matchVersionOption("", options), { version: "", exact: false });
});

test("release names are split into title, branch, version and variant", () => {
  assert.deepEqual(parseReleaseName("Dating_My_Daughter_Ch2_v0.5_Win_HQ"), {
    title: "Dating My Daughter", branch: "Chapter 2", branchType: "chapter", variant: "HQ", split: false, platform: "Windows", version: "0.5"
  });
  const season = parseReleaseName("Lust Academy S4 v4.10.2a [Win-Linux].zip");
  assert.equal(season.title, "Lust Academy");
  assert.equal(season.branch, "Season 4");
  assert.equal(season.version, "4.10.2a");
  const plain = parseReleaseName("Example Game v0.1.4.0");
  assert.equal(plain.title, "Example Game");
  assert.equal(plain.branch, null);
  assert.equal(plain.version, "0.1.4.0");
  assert.equal(parseReleaseName("Heart Problems Christmas Special v1.0").branch, "Christmas Special");
});

test("branch states report updates per branch and skip final branches", () => {
  const { buildBranchInfo } = require("../src/main/services/releaseNames");
  const info = buildBranchInfo({
    titleBranches: ["Chapter 1", "Chapter 2"],
    currentVersion: "1.0",
    changelog: "Chapter 1 v1.2 - done\nv1.0",
    folders: [{ branch: "Chapter 1", version: "1.0" }, { branch: "Chapter 2", version: "0.5" }],
    groups: [],
    overrides: { final: ["Chapter 2"], added: ["Special"] }
  });
  assert.deepEqual(info.branches, ["Chapter 1", "Chapter 2", "Special"]);
  const state = (label) => info.branchStates.find((entry) => entry.branch === label);
  assert.equal(state("Chapter 1").hasUpdate, true);
  assert.equal(state("Chapter 1").latestVersion, "1.2");
  assert.equal(state("Chapter 2").hasUpdate, false, "a final branch is never reported as outdated");
});
