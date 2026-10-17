const test = require("node:test");
const assert = require("node:assert/strict");
const { selectVisibleGames } = require("../src/renderer/library-filters");

const games = [
  { title: "Beta", status: "up-to-date", developer: "Zed", tags: ["adventure"], lastSyncAt: "2026-01-02", releaseDate: "2025-05-01" },
  { title: "alpha", status: "update-available", developer: "Amy", tags: ["rpg", "fantasy"], lastSyncAt: "2026-03-01", releaseDate: "2024-01-01" },
  { title: "Gamma 10", status: "not-installed", tags: [], lastSyncAt: null, releaseDate: "2026-02-01" },
  { title: "Gamma 2", status: "unknown", tags: [] }
];
const titles = (view) => selectVisibleGames(games, view).map((game) => game.title);

test("default view sorts by title case-insensitively with natural numbers", () => {
  assert.deepEqual(titles({}), ["alpha", "Beta", "Gamma 2", "Gamma 10"]);
});

test("filters by status group", () => {
  assert.deepEqual(titles({ filter: "updates" }), ["alpha"]);
  assert.deepEqual(titles({ filter: "installed" }), ["alpha", "Beta"]);
  assert.deepEqual(titles({ filter: "not-installed" }), ["Gamma 2", "Gamma 10"]);
});

test("search matches title, developer and tags with all words required", () => {
  assert.deepEqual(titles({ query: "amy" }), ["alpha"]);
  assert.deepEqual(titles({ query: "rpg fantasy" }), ["alpha"]);
  assert.deepEqual(titles({ query: "rpg adventure" }), []);
});

test("sort modes order updates, sync date and release date", () => {
  assert.equal(titles({ sort: "updates-first" })[0], "alpha");
  assert.deepEqual(titles({ sort: "recently-synced" }).slice(0, 2), ["alpha", "Beta"]);
  assert.deepEqual(titles({ sort: "release-date" }).slice(0, 2), ["Gamma 10", "Beta"]);
});

test("unknown filter and sort fall back to defaults and input is not mutated", () => {
  const copy = JSON.stringify(games);
  assert.equal(titles({ filter: "nope", sort: "nope" }).length, 4);
  assert.equal(JSON.stringify(games), copy);
});
