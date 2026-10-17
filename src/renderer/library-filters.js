// Search, filter and sort for the library grid. Pure functions so they can be unit-tested in Node.
const LIBRARY_FILTERS = {
  all: () => true,
  updates: (game) => game.status === "update-available",
  installed: (game) => game.status === "up-to-date" || game.status === "update-available",
  "not-installed": (game) => game.status === "not-installed" || game.status === "unknown"
};

const LIBRARY_SORTS = {
  title: (a, b) => compareText(a.title, b.title),
  "updates-first": (a, b) =>
    Number(b.status === "update-available") - Number(a.status === "update-available") || compareText(a.title, b.title),
  "recently-synced": (a, b) => compareDateDesc(a.lastSyncAt, b.lastSyncAt) || compareText(a.title, b.title),
  "release-date": (a, b) => compareDateDesc(a.releaseDate, b.releaseDate) || compareText(a.title, b.title)
};

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true });
}

function compareDateDesc(a, b) {
  const left = Date.parse(a) || 0;
  const right = Date.parse(b) || 0;
  return right - left;
}

function matchesQuery(game, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  const haystack = [game.title, game.developer, game.engine, ...(game.tags || []), ...(game.aliases || [])]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

function selectVisibleGames(games, view = {}) {
  const filter = LIBRARY_FILTERS[view.filter] || LIBRARY_FILTERS.all;
  const sort = LIBRARY_SORTS[view.sort] || LIBRARY_SORTS.title;
  return games.filter((game) => filter(game) && matchesQuery(game, view.query)).sort(sort);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { selectVisibleGames, LIBRARY_FILTERS, LIBRARY_SORTS };
}
