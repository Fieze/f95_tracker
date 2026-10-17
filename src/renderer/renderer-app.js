const state = {
  settings: {
    watchFolder: "",
    installRoot: "",
    syncIntervalMinutes: 30
  },
  auth: {
    loggedIn: false,
    hasSessionCookie: false,
    hasUserCookie: false
  },
  authCheckResult: "",
  games: [],
  archiveJobs: [],
  downloadJobs: [],
  currentExtraction: null,
  selectedGameId: null,
  editingFolderId: null,
  openOverlay: null,
  archiveQueueReady: false,
  activities: [],
  libraryView: { query: "", filter: "all", sort: "title" }
};

const GAME_TILE_MIN_COLUMNS = 3;
const GAME_TILE_MAX_COLUMNS = 7;
const GAME_TILE_PREFERRED_WIDTH = 290;
const GAME_TILE_BASE_WIDTH = 267;
const GAME_TILE_GAP = 18;
const LIVE_STATE_RELOAD_INTERVAL_MS = 500;
let gamesGridResizeObserver = null;
let reloadStatePromise = null;
let reloadStateQueued = false;
let scheduledReloadStateTimer = null;
let scheduledReloadStatePromise = null;
let lastReloadStateAt = 0;
let archiveQueueInitialized = false;
const launchExecutableCache = new Map();

function $(selector) {
  return document.querySelector(selector);
}

function createNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createSvgNode(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function createPlayButton(label = "Play") {
  const button = createNode("button", "secondary launch-button", label);
  button.type = "button";
  const icon = createSvgNode("svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const path = createSvgNode("path");
  path.setAttribute("d", "M8 6L18 12L8 18V6Z");
  icon.appendChild(path);
  button.prepend(icon);
  return button;
}

function formatStatusLabel(status) {
  return String(status || "unknown").replace(/-/g, " ");
}

function formatDate(value) {
  if (!value) return "Never";
  return new Date(value).toLocaleString("en-US");
}

function formatReleaseDate(value) {
  return value || "Unknown";
}

function threadStatusClass(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "complete") return "status-complete";
  if (normalized === "on hold") return "status-on-hold";
  if (normalized === "abandoned") return "status-abandoned";
  return "";
}

function formatFolderVersionLabel(folder) {
  return folder.version || "No version";
}

function formatFolderDisplayVersion(game, folder) {
  const finalSuffix = folder.seasonFinal ? " (Final)" : "";
  if (folder.version && game.currentVersion && String(folder.version) === String(game.currentVersion)) {
    return `latest${finalSuffix}`;
  }
  const baseVersion = folder.version || "No version";
  return `${baseVersion}${finalSuffix}`;
}

function getFolderVersionTone(game, folder) {
  if (folder.version && game.currentVersion && String(folder.version) === String(game.currentVersion)) {
    return "is-latest";
  }
  if (!folder.version) {
    return "is-empty";
  }
  return "";
}

function formatFolderSeasonLabel(folder) {
  if (!folder.seasonNumber) {
    return "No season";
  }
  return String(folder.seasonNumber);
}

function renderOverlays() {
  const settingsOpen = state.openOverlay === "settings";
  const loginOpen = state.openOverlay === "login";
  const addThreadOpen = state.openOverlay === "add-thread";
  const addFolderOpen = state.openOverlay === "add-folder";
  const gameDetailsOpen = state.openOverlay === "game-details";
  const editFolderOpen = state.openOverlay === "edit-folder";

  $("#open-settings-panel")?.setAttribute("aria-pressed", settingsOpen ? "true" : "false");
  $("#open-login-panel")?.setAttribute("aria-pressed", loginOpen ? "true" : "false");
  $("#open-add-thread-panel")?.setAttribute("aria-pressed", addThreadOpen ? "true" : "false");
  $("#settings-panel")?.classList.toggle("hidden", !settingsOpen);
  $("#login-panel")?.classList.toggle("hidden", !loginOpen);
  $("#add-thread-panel")?.classList.toggle("hidden", !addThreadOpen);
  $("#add-folder-panel")?.classList.toggle("hidden", !addFolderOpen);
  $("#game-details-panel")?.classList.toggle("hidden", !gameDetailsOpen);
  $("#edit-folder-panel")?.classList.toggle("hidden", !editFolderOpen);
  $("#overlay-backdrop")?.classList.toggle("hidden", !state.openOverlay);
  renderChromeVisibility();
}

function renderChromeVisibility() {
  const hideChrome = state.openOverlay === "game-details" || state.openOverlay === "edit-folder";
  $("#archive-queue-bar")?.classList.toggle("is-hidden-for-overlay", hideChrome);
  $(".topbar")?.classList.toggle("is-hidden-for-overlay", hideChrome);
}

function renderStats() {
  $("#stat-games").textContent = String(state.games.length);
  $("#stat-updates").textContent = String(
    state.games.filter((game) => game.status === "update-available").length
  );
  $("#stat-jobs").textContent = String(
    state.archiveJobs.filter((job) => ["needs-review", "queued", "processing", "unmatched"].includes(job.status)).length
  );
}

function render() {
  setSettingsForm(state.settings);
  renderAuth();
  renderStats();
  renderGames();
  renderGameDetailsPanel();
  renderEditFolderPanel();
  renderJobs();
  renderStatusLine();
  renderOverlays();
}

async function reloadState() {
  if (reloadStatePromise) {
    reloadStateQueued = true;
    return reloadStatePromise;
  }

  reloadStatePromise = (async () => {
    do {
      reloadStateQueued = false;
      const previousJobs = state.archiveJobs || [];
      const previousDownloadJobs = state.downloadJobs || [];
      const nextState = await window.f95App.bootstrap();
      updateArchiveQueueAutoExpand(
        previousJobs,
        nextState.archiveJobs || [],
        previousDownloadJobs,
        nextState.downloadJobs || []
      );
      Object.assign(state, nextState);
      pruneLaunchExecutableCache(state.games);
      if (!state.games.some((game) => game.id === state.selectedGameId)) {
        state.selectedGameId = null;
        if (state.openOverlay === "game-details") {
          state.openOverlay = null;
        }
      }
      if (!state.games.some((game) => (game.folders || []).some((folder) => folder.id === state.editingFolderId))) {
        state.editingFolderId = null;
        if (state.openOverlay === "edit-folder") {
          state.openOverlay = state.selectedGameId ? "game-details" : null;
        }
      }
      render();
      lastReloadStateAt = Date.now();
    } while (reloadStateQueued);
  })();

  try {
    await reloadStatePromise;
  } finally {
    reloadStatePromise = null;
  }
}

function scheduleReloadState(minIntervalMs = LIVE_STATE_RELOAD_INTERVAL_MS) {
  if (scheduledReloadStatePromise) {
    return scheduledReloadStatePromise;
  }

  const elapsedSinceLastReload = Date.now() - lastReloadStateAt;
  const delayMs = Math.max(0, Number(minIntervalMs || 0) - Math.max(0, elapsedSinceLastReload));

  scheduledReloadStatePromise = new Promise((resolve, reject) => {
    scheduledReloadStateTimer = window.setTimeout(() => {
      scheduledReloadStateTimer = null;
      scheduledReloadStatePromise = null;
      reloadState().then(resolve).catch(reject);
    }, delayMs);
  });

  return scheduledReloadStatePromise;
}

async function initialize() {
  initLibraryToolbar();
  initAddFolderPanel();
  $("#settings-form").addEventListener("submit", handleSettingsSubmit);
  document.querySelectorAll(".browse-folder-button").forEach((button) => {
    button.addEventListener("click", handleBrowseFolderClick);
  });
  $("#export-data").addEventListener("click", handleExportData);
  $("#import-data").addEventListener("click", handleImportData);
  $("#add-thread-form").addEventListener("submit", handleAddThread);
  $("#refresh-all").addEventListener("click", async () => {
    try {
      await window.f95App.refreshAllGames();
      await reloadState();
    } catch (error) {
      alert(error.message);
    }
  });

  $("#open-settings-panel").addEventListener("click", () => {
    state.openOverlay = state.openOverlay === "settings" ? null : "settings";
    renderOverlays();
  });

  $("#open-login-panel").addEventListener("click", () => {
    state.openOverlay = state.openOverlay === "login" ? null : "login";
    renderOverlays();
  });

  $("#open-add-thread-panel").addEventListener("click", () => {
    state.openOverlay = state.openOverlay === "add-thread" ? null : "add-thread";
    renderOverlays();
  });

  $("#open-login").addEventListener("click", async () => {
    try {
      await window.f95App.openLogin();
      await reloadState();
    } catch (error) {
      alert(error.message);
    }
  });

  $("#logout").addEventListener("click", async () => {
    try {
      await window.f95App.logout();
      state.authCheckResult = "";
      await reloadState();
    } catch (error) {
      alert(error.message);
    }
  });

  $("#image-lightbox").addEventListener("click", (event) => {
    if (event.target.id === "image-lightbox") {
      closeLightbox();
    }
  });
  function closeCurrentOverlay() {
    if (state.openOverlay === "edit-folder") {
      state.editingFolderId = null;
      state.openOverlay = state.selectedGameId ? "game-details" : null;
    } else if (state.openOverlay === "add-folder") {
      closeAddFolderPanel();
    } else if (state.openOverlay === "game-details") {
      state.selectedGameId = null;
      state.editingFolderId = null;
      state.openOverlay = null;
    } else {
      state.openOverlay = null;
      state.editingFolderId = null;
    }
    render();
  }

  $("#overlay-backdrop").addEventListener("click", closeCurrentOverlay);
  document.querySelectorAll("[data-close-overlay]").forEach((button) => {
    button.addEventListener("click", closeCurrentOverlay);
  });
  $("#close-game-details").addEventListener("click", closeCurrentOverlay);
  $("#edit-folder-cancel").addEventListener("click", closeCurrentOverlay);
  $("#lightbox-close").addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (state.openOverlay) {
        closeCurrentOverlay();
      }
      closeLightbox();
    }
  });
  window.setInterval(() => {
    if (state.currentExtraction) {
      renderExtractionStatus();
    }
  }, 1000);

  if (typeof ResizeObserver !== "undefined") {
    gamesGridResizeObserver = new ResizeObserver(() => {
      layoutGamesGrid();
    });
    const gamesList = $("#games-list");
    if (gamesList) {
      gamesGridResizeObserver.observe(gamesList);
    }
  } else {
    window.addEventListener("resize", layoutGamesGrid);
  }

  window.f95App.onStateChanged(() => {
    void scheduleReloadState();
  });

  await reloadState();
}
