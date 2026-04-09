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
  currentExtraction: null,
  selectedGameId: null,
  editingFolderId: null,
  openOverlay: null
};

const GAME_TILE_MIN_COLUMNS = 3;
const GAME_TILE_MAX_COLUMNS = 7;
const GAME_TILE_PREFERRED_WIDTH = 290;
const GAME_TILE_BASE_WIDTH = 267;
const GAME_TILE_GAP = 18;
let gamesGridResizeObserver = null;
let reloadStatePromise = null;
let reloadStateQueued = false;
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

function formatDurationMs(value) {
  const totalSeconds = Math.max(0, Math.round(Number(value || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function filePathToUrl(filePath) {
  if (!filePath) return "";
  const normalized = String(filePath).replace(/\\/g, "/");
  return encodeURI(`file:///${normalized.replace(/^\/+/, "")}`);
}

function setImageSource(node, filePath, alt) {
  if (!node) return;
  if (!filePath) {
    node.removeAttribute("src");
    node.alt = "";
    return;
  }
  node.src = filePathToUrl(filePath);
  node.alt = alt || "";
}

function getLaunchCacheKey(folder) {
  return `${folder.id}:${folder.folderPath}`;
}

function getLaunchState(folder) {
  const key = getLaunchCacheKey(folder);
  let launchState = launchExecutableCache.get(key);
  if (!launchState) {
    launchState = {
      status: "idle",
      executables: [],
      selectedPath: "",
      errorMessage: "",
      loadPromise: null
    };
    launchExecutableCache.set(key, launchState);
  }
  return launchState;
}

function pruneLaunchExecutableCache(games) {
  const validKeys = new Set();
  (games || []).forEach((game) => {
    (game.folders || []).forEach((folder) => {
      validKeys.add(getLaunchCacheKey(folder));
    });
  });

  [...launchExecutableCache.keys()].forEach((key) => {
    if (!validKeys.has(key)) {
      launchExecutableCache.delete(key);
    }
  });
}

function ensureFolderLaunchState(game, folder, onChange) {
  const launchState = getLaunchState(folder);
  if (launchState.status === "loading" || launchState.status === "ready") {
    return launchState;
  }

  launchState.status = "loading";
  launchState.errorMessage = "";
  launchState.loadPromise = window.f95App
    .listLaunchExecutables({
      gameId: game.id,
      folderId: folder.id,
      folderPath: folder.folderPath
    })
    .then((result) => {
      launchState.status = "ready";
      launchState.executables = result?.executables || [];
      launchState.selectedPath =
        launchState.selectedPath &&
        launchState.executables.some((entry) => entry.fullPath === launchState.selectedPath)
          ? launchState.selectedPath
          : launchState.executables.find((entry) => entry.isRecommended)?.fullPath ||
            launchState.executables[0]?.fullPath ||
            "";
      launchState.errorMessage = "";
    })
    .catch((error) => {
      launchState.status = "error";
      launchState.executables = [];
      launchState.selectedPath = "";
      launchState.errorMessage = error.message || "Executables could not be scanned.";
    })
    .finally(() => {
      launchState.loadPromise = null;
      onChange();
    });

  return launchState;
}

function closeLightbox() {
  const overlay = $("#image-lightbox");
  const image = $("#lightbox-image");
  overlay.classList.add("hidden");
  image.removeAttribute("src");
}

function openLightbox(filePath, title) {
  const overlay = $("#image-lightbox");
  const image = $("#lightbox-image");
  setImageSource(image, filePath, title);
  overlay.classList.remove("hidden");
}

function setSettingsForm(settings) {
  const form = $("#settings-form");
  form.watchFolder.value = settings.watchFolder || "";
  form.installRoot.value = settings.installRoot || "";
  form.syncIntervalMinutes.value = settings.syncIntervalMinutes || 30;
}

function renderAuth() {
  const statusNode = $("#auth-status");
  const resultNode = $("#auth-check-result");
  const loginBtn = $("#open-login-panel");
  if (loginBtn) {
    loginBtn.dataset.authState = state.auth.loggedIn ? "logged-in" : "logged-out";
  }
  if (!statusNode) return;

  if (state.auth.loggedIn) {
    statusNode.textContent = "Logged in. The app is now using its own F95Zone session.";
  } else {
    statusNode.textContent = "Not logged in. Open the login window and sign in to F95Zone there.";
  }

  if (resultNode) {
    resultNode.textContent = state.authCheckResult || "";
  }
}

function renderOverlays() {
  const settingsOpen = state.openOverlay === "settings";
  const loginOpen = state.openOverlay === "login";
  const addThreadOpen = state.openOverlay === "add-thread";
  const editFolderOpen = state.openOverlay === "edit-folder";

  $("#open-settings-panel")?.setAttribute("aria-pressed", settingsOpen ? "true" : "false");
  $("#open-login-panel")?.setAttribute("aria-pressed", loginOpen ? "true" : "false");
  $("#open-add-thread-panel")?.setAttribute("aria-pressed", addThreadOpen ? "true" : "false");
  $("#settings-panel")?.classList.toggle("hidden", !settingsOpen);
  $("#login-panel")?.classList.toggle("hidden", !loginOpen);
  $("#add-thread-panel")?.classList.toggle("hidden", !addThreadOpen);
  $("#edit-folder-panel")?.classList.toggle("hidden", !editFolderOpen);
  $("#overlay-backdrop")?.classList.toggle("hidden", !state.openOverlay);
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

function getGamesGridMetrics(containerWidth) {
  const safeWidth = Math.max(0, Math.floor(containerWidth || 0));
  if (!safeWidth) {
    return { columns: GAME_TILE_MIN_COLUMNS, trackWidth: GAME_TILE_BASE_WIDTH, scale: 1 };
  }

  const preferredColumns = Math.floor((safeWidth + GAME_TILE_GAP) / (GAME_TILE_PREFERRED_WIDTH + GAME_TILE_GAP));
  const columns = Math.max(
    GAME_TILE_MIN_COLUMNS,
    Math.min(GAME_TILE_MAX_COLUMNS, preferredColumns || GAME_TILE_MIN_COLUMNS)
  );
  const availableWidth = safeWidth - GAME_TILE_GAP * Math.max(0, columns - 1);
  const trackWidth = Math.max(0, Math.floor(availableWidth / columns));
  const scale = Math.max(0.72, trackWidth / GAME_TILE_BASE_WIDTH);

  return { columns, trackWidth, scale };
}

function layoutGamesGrid() {
  const container = $("#games-list");
  if (!container || container.classList.contains("empty-state")) {
    return;
  }

  const { columns, trackWidth, scale } = getGamesGridMetrics(container.clientWidth);
  container.style.gridTemplateColumns = `repeat(${columns}, minmax(0, ${trackWidth}px))`;
  container.querySelectorAll(".game-tile").forEach((tile) => {
    tile.style.setProperty("--game-tile-scale", scale.toFixed(3));
  });
  fitGameTileTitles(container);
}

function fitGameTileTitles(container = $("#games-list")) {
  if (!container) {
    return;
  }

  container.querySelectorAll(".game-tile-title").forEach((titleNode) => {
    titleNode.style.fontSize = "16px";
    const computed = window.getComputedStyle(titleNode);
    const lineHeight = parseFloat(computed.lineHeight) || 18.4;
    const maxHeight = lineHeight * 2 + 1;

    let fontSize = 16;
    while (titleNode.scrollHeight > maxHeight && fontSize > 12) {
      fontSize -= 1;
      titleNode.style.fontSize = `${fontSize}px`;
    }
  });
}

function buildGameDetailsCard(selectedGame) {
  const detailFragment = $("#game-details-template").content.cloneNode(true);
  const card = detailFragment.querySelector(".game-card");
  const title = detailFragment.querySelector(".game-title");
  const status = detailFragment.querySelector(".game-status");
  const engineValue = detailFragment.querySelector(".engine-value");
  const currentVersion = detailFragment.querySelector(".current-version");
  const developerValue = detailFragment.querySelector(".developer-value");
  const installFolders = detailFragment.querySelector(".install-folders");
  const releaseDate = detailFragment.querySelector(".release-date");
  const lastSync = detailFragment.querySelector(".last-sync");
  const overview = detailFragment.querySelector(".overview");
  const tags = detailFragment.querySelector(".tags");
  const screenshots = detailFragment.querySelector(".screenshots");
  const warnings = detailFragment.querySelector(".warnings");
  const groups = detailFragment.querySelector(".download-groups");
  const debugOutput = detailFragment.querySelector(".debug-output");
  const refreshButton = detailFragment.querySelector(".refresh-button");
  const deleteButton = detailFragment.querySelector(".delete-button");
  const threadLink = detailFragment.querySelector(".thread-link");

  title.textContent = selectedGame.title;
  status.textContent = formatStatusLabel(selectedGame.status);
  status.classList.add(selectedGame.status || "unknown");
  engineValue.textContent = selectedGame.engine || "Unknown";
  currentVersion.textContent = selectedGame.currentVersion || "Unknown";
  developerValue.textContent = selectedGame.developer || "Unknown";
  releaseDate.textContent = formatReleaseDate(selectedGame.releaseDate);
  lastSync.textContent = formatDate(selectedGame.lastSyncAt);
  overview.textContent = selectedGame.overview || "No overview detected.";
  threadLink.href = selectedGame.threadUrl;
  threadLink.textContent = "Open Thread";

  const renderInstallFolders = () => {
    installFolders.innerHTML = "";
    const folders = selectedGame.folders || [];
    if (folders.length === 0) {
      installFolders.classList.add("empty-state");
      installFolders.textContent = "No managed installation folders found.";
      return;
    }

    installFolders.classList.remove("empty-state");
    folders.forEach((folder) => {
      const row = createNode("div", "install-folder-row");
      if (selectedGame.primaryFolderId === folder.id) {
        row.classList.add("is-primary");
      }

      const info = createNode("div", "install-folder-info");
      info.appendChild(createNode("strong", "install-folder-name", folder.folderName));
      info.appendChild(createNode("span", "install-folder-path", folder.folderPath));
      const controls = createNode("div", "install-folder-controls");
      const summary = createNode("div", "install-folder-summary");
      if (selectedGame.hasSeasons) {
        const seasonMeta = createNode("div", "install-folder-meta");
        seasonMeta.appendChild(createNode("span", "install-folder-meta-heading", "Season"));
        seasonMeta.appendChild(createNode("span", "install-folder-season-label-display", formatFolderSeasonLabel(folder)));
        summary.appendChild(seasonMeta);
      }

      const versionMeta = createNode("div", "install-folder-meta");
      versionMeta.appendChild(createNode("span", "install-folder-meta-heading", "Version"));
      const versionLabel = createNode("span", "install-folder-version-label", formatFolderDisplayVersion(selectedGame, folder));
      const versionTone = getFolderVersionTone(selectedGame, folder);
      if (versionTone) {
        versionLabel.classList.add(versionTone);
      }
      versionMeta.appendChild(versionLabel);
      summary.appendChild(versionMeta);
      controls.appendChild(summary);

      const actions = createNode("div", "install-folder-actions");

      const playButton = createPlayButton();
      playButton.title = "Launch the configured executable for this folder";
      playButton.addEventListener("click", async () => {
        try {
          await window.f95App.launchExecutable({
            gameId: selectedGame.id,
            folderId: folder.id
          });
        } catch (error) {
          alert(error.message);
        }
      });
      actions.appendChild(playButton);

      const editButton = createNode("button", "secondary install-folder-edit", "Edit");
      editButton.type = "button";
      editButton.title = "Open folder settings";
      editButton.addEventListener("click", () => {
        state.editingFolderId = folder.id;
        state.openOverlay = "edit-folder";
        render();
      });
      actions.appendChild(editButton);
      controls.appendChild(actions);

      row.appendChild(info);
      row.appendChild(controls);
      installFolders.appendChild(row);
    });
  };

  renderInstallFolders();

  refreshButton.addEventListener("click", async () => {
    try {
      await window.f95App.refreshGame(selectedGame.id);
      await reloadState();
    } catch (error) {
      alert(error.message);
    }
  });

  deleteButton.addEventListener("click", async () => {
    if (!window.confirm(`Are you sure you want to remove "${selectedGame.title}"?`)) {
      return;
    }
    try {
      await window.f95App.deleteGame(selectedGame.id);
      if (state.selectedGameId === selectedGame.id) {
        state.selectedGameId = null;
      }
      await reloadState();
    } catch (error) {
      alert(error.message);
    }
  });

  (selectedGame.tags || []).forEach((tag) => {
    tags.appendChild(createNode("span", "tag", tag));
  });
  if (!selectedGame.tags?.length) {
    tags.appendChild(createNode("span", "tag", "No tags"));
  }

  const screenshotImages = selectedGame.screenshotImages || [];
  if (screenshotImages.length > 0) {
    screenshotImages.forEach((image, index) => {
      const thumb = createNode("button", "screenshot-thumb");
      thumb.type = "button";
      const img = createNode("img", "screenshot-image");
      setImageSource(img, image.localPath, `${selectedGame.title} Screenshot ${index + 1}`);
      thumb.appendChild(img);
      thumb.addEventListener("click", () => {
        openLightbox(image.localPath, `${selectedGame.title} Screenshot ${index + 1}`);
      });
      screenshots.appendChild(thumb);
    });
  } else {
    screenshots.classList.add("empty-state");
    screenshots.textContent = "No screenshots detected.";
  }

  (selectedGame.parserWarnings || []).forEach((warning) => {
    warnings.appendChild(createNode("span", "warning-pill", warning));
  });

  (selectedGame.downloadGroups || []).forEach((group) => {
    const wrapper = createNode("div", "download-group");
    wrapper.appendChild(createNode("strong", "", group.label));
    (group.links || []).forEach((link) => {
      const button = createNode("button", "download-button", "Open Link");
      const row = createNode("div", "download-row");
      button.type = "button";
      button.addEventListener("click", () => window.f95App.openLink(link.url));
      row.appendChild(createNode("span", "", link.label));
      row.appendChild(button);
      wrapper.appendChild(row);
    });
    groups.appendChild(wrapper);
  });

  if (debugOutput) {
    debugOutput.textContent = JSON.stringify(selectedGame.parserDebug || {}, null, 2);
  }

  return card;
}

function getSelectedGame() {
  return state.games.find((game) => game.id === state.selectedGameId) || null;
}

function getEditingFolderContext() {
  const game = getSelectedGame();
  if (!game || !state.editingFolderId) {
    return { game: null, folder: null };
  }
  const folder = (game.folders || []).find((entry) => entry.id === state.editingFolderId) || null;
  return { game, folder };
}

function renderEditFolderPanel() {
  const panel = $("#edit-folder-panel");
  const form = $("#edit-folder-form");
  if (!panel || !form) {
    return;
  }

  const { game, folder } = getEditingFolderContext();
  if (!game || !folder || state.openOverlay !== "edit-folder") {
    return;
  }

  $("#edit-folder-panel-title").textContent = `${game.title} - ${folder.folderName}`;
  $("#edit-folder-panel-subtitle").textContent = `Choose what Play launches, set version details, and manage season metadata for ${folder.folderName}.`;
  $("#edit-folder-name").textContent = folder.folderName;
  $("#edit-folder-path").textContent = folder.folderPath;

  const executableSelect = $("#edit-folder-executable");
  const versionInput = $("#edit-folder-version");
  const useCurrentButton = $("#edit-folder-use-current");
  const seasonsCheckbox = $("#edit-folder-seasons-checkbox");
  const seasonFields = $("#edit-folder-season-fields");
  const seasonSelect = $("#edit-folder-season");
  const seasonFinalCheckbox = $("#edit-folder-season-final");
  const deleteButton = $("#edit-folder-delete");

  versionInput.value = folder.version || "";
  seasonsCheckbox.checked = Boolean(game.hasSeasons);
  seasonFields.classList.toggle("hidden", !game.hasSeasons);
  seasonSelect.innerHTML = "";
  const emptyOption = createNode("option", "", "No season");
  emptyOption.value = "";
  seasonSelect.appendChild(emptyOption);
  for (let season = 1; season <= 10; season += 1) {
    const option = createNode("option", "", String(season));
    option.value = String(season);
    option.selected = Number(folder.seasonNumber) === season;
    seasonSelect.appendChild(option);
  }
  seasonFinalCheckbox.checked = Boolean(folder.seasonFinal);

  const launchState = ensureFolderLaunchState(game, folder, renderEditFolderPanel);
  executableSelect.innerHTML = "";
  executableSelect.disabled = launchState.status === "loading" || launchState.executables.length === 0;
  if (launchState.status === "loading") {
    const option = createNode("option", "", "Scanning...");
    option.value = "";
    executableSelect.appendChild(option);
  } else if (launchState.executables.length === 0) {
    const option = createNode("option", "", "No executable found");
    option.value = "";
    executableSelect.appendChild(option);
  } else {
    const selectedPath =
      launchState.executables.find((entry) => entry.isSelected)?.fullPath ||
      folder.preferredExePath ||
      launchState.executables.find((entry) => entry.isRecommended)?.fullPath ||
      launchState.executables[0].fullPath;
    launchState.selectedPath = selectedPath;
    launchState.executables.forEach((entry) => {
      const suffix = entry.isSelected ? " - selected" : entry.isRecommended ? " - recommended" : "";
      const option = createNode("option", "", `${entry.fileName}${suffix}`);
      option.value = entry.fullPath;
      option.selected = entry.fullPath === selectedPath;
      executableSelect.appendChild(option);
    });
  }

  seasonsCheckbox.onchange = () => {
    seasonFields.classList.toggle("hidden", !seasonsCheckbox.checked);
  };

  useCurrentButton.onclick = () => {
    versionInput.value = game.currentVersion || "";
  };

  deleteButton.onclick = async () => {
    const confirmed = window.confirm(`Delete the folder "${folder.folderName}" permanently?\n\n${folder.folderPath}`);
    if (!confirmed) {
      return;
    }
    try {
      await window.f95App.deleteGameFolder({
        folderId: folder.id,
        gameId: game.id,
        folderPath: folder.folderPath
      });
      state.editingFolderId = null;
      state.openOverlay = null;
      await reloadState();
    } catch (error) {
      alert(error.message);
    }
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    try {
      if (Boolean(game.hasSeasons) !== Boolean(seasonsCheckbox.checked)) {
        await window.f95App.updateGameSeasons({
          gameId: game.id,
          hasSeasons: seasonsCheckbox.checked
        });
      }
      await window.f95App.updateGameFolderMetadata({
        folderId: folder.id,
        gameId: game.id,
        folderPath: folder.folderPath,
        version: versionInput.value.trim(),
        seasonNumber: seasonsCheckbox.checked && seasonSelect.value ? Number(seasonSelect.value) : null,
        seasonFinal: seasonsCheckbox.checked ? seasonFinalCheckbox.checked : false,
        preferredExePath: executableSelect.value || null
      });
      state.editingFolderId = null;
      state.openOverlay = null;
      await reloadState();
    } catch (error) {
      alert(error.message);
    }
  };
}

function renderGames() {
  const container = $("#games-list");
  container.innerHTML = "";

  if (state.games.length === 0) {
    container.className = "games-list empty-state";
    container.textContent = "No threads added yet.";
    container.style.removeProperty("grid-template-columns");
    return;
  }

  container.className = "games-list";
  const template = $("#game-card-template");
  const selectedIndex = state.games.findIndex((game) => game.id === state.selectedGameId);
  const selectedGame = selectedIndex >= 0 ? state.games[selectedIndex] : null;
  const gridMetrics = getGamesGridMetrics(container.clientWidth);
  const selectedRowEndIndex =
    selectedIndex >= 0
      ? Math.min(
          state.games.length - 1,
          Math.floor(selectedIndex / gridMetrics.columns) * gridMetrics.columns + gridMetrics.columns - 1
        )
      : -1;

  state.games.forEach((game, index) => {
    const fragment = template.content.cloneNode(true);
    const tile = fragment.querySelector(".game-tile");
    const button = fragment.querySelector(".game-tile-button");
    const title = fragment.querySelector(".game-tile-title");
    const banner = fragment.querySelector(".game-tile-banner");
    const fallback = fragment.querySelector(".game-tile-fallback");
    const badge = fragment.querySelector(".game-update-badge");
    const threadStatusBadge = fragment.querySelector(".game-thread-status-badge");

    title.textContent = game.title;
    fallback.textContent = game.title;
    if (game.bannerImage?.localPath) {
      setImageSource(banner, game.bannerImage.localPath, `${game.title} Banner`);
      button.classList.add("has-image");
    } else {
      setImageSource(banner, null, "");
      button.classList.remove("has-image");
    }
    badge.classList.toggle("hidden", game.status !== "update-available");
    threadStatusBadge.textContent = game.threadStatus || "";
    threadStatusBadge.classList.remove("status-complete", "status-on-hold", "status-abandoned");
    const statusClass = threadStatusClass(game.threadStatus);
    if (statusClass) {
      threadStatusBadge.classList.add(statusClass);
    }
    threadStatusBadge.classList.toggle("hidden", !game.threadStatus);
    button.classList.toggle("is-selected", game.id === state.selectedGameId);
    button.addEventListener("click", () => {
      state.selectedGameId = state.selectedGameId === game.id ? null : game.id;
      renderGames();
    });

    container.appendChild(tile);

    if (selectedGame && index === selectedRowEndIndex) {
      const detailsRow = createNode("div", "game-details-row");
      detailsRow.appendChild(buildGameDetailsCard(selectedGame));
      container.appendChild(detailsRow);
    }
  });

  layoutGamesGrid();
}

function renderJobs() {
  renderExtractionStatus();
  const container = $("#jobs-list");
  container.innerHTML = "";

  if (state.archiveJobs.length === 0) {
    container.className = "jobs-list empty-state";
    container.textContent = "No archives detected yet.";
    return;
  }

  container.className = "jobs-list";
  const template = $("#job-card-template");

  state.archiveJobs.forEach((job) => {
    const fragment = template.content.cloneNode(true);
    const title = fragment.querySelector(".job-title");
    const pathNode = fragment.querySelector(".job-path");
    const status = fragment.querySelector(".job-status");
    const details = fragment.querySelector(".job-details");
    const gameSelect = fragment.querySelector(".job-game-select");
    const assignWrap = fragment.querySelector(".job-assign");
    const actions = fragment.querySelector(".job-actions");

    title.textContent = job.archiveName;
    pathNode.textContent = job.archivePath;
    status.textContent = formatStatusLabel(job.status);
    status.classList.add(job.status || "unknown");

    const candidate = job.matchCandidates[0];
    const candidateText = candidate
      ? `Suggested match: ${candidate.gameTitle}${candidate.version ? ` (${candidate.version})` : ""}`
      : "No match detected.";
    details.textContent =
      job.errorText || job.extractedTo || `${candidateText} | detected ${formatDate(job.createdAt)}`;

    const placeholder = createNode("option", "", "Select game");
    placeholder.value = "";
    gameSelect.appendChild(placeholder);
    state.games.forEach((game) => {
      const option = createNode("option", "", game.title);
      option.value = String(game.id);
      if (job.gameId === game.id || (!job.gameId && candidate && candidate.gameId === game.id)) {
        option.selected = true;
      }
      gameSelect.appendChild(option);
    });

    const isActionable = !["processed", "processing", "skipped"].includes(job.status);
    if (isActionable) {
      const extractButton = createNode("button", "choice-button", "Extract");
      extractButton.type = "button";
      extractButton.addEventListener("click", async () => {
        const selectedGameId = Number(gameSelect.value);
        if (!selectedGameId) {
          alert("Please select a game first.");
          return;
        }
        await window.f95App.resolveArchiveMatch({
          jobId: job.id,
          action: "accept",
          gameId: selectedGameId
        });
        await reloadState();
      });
      actions.appendChild(extractButton);

      const skip = createNode("button", "choice-button", "Skip");
      skip.type = "button";
      skip.addEventListener("click", async () => {
        await window.f95App.resolveArchiveMatch({
          jobId: job.id,
          action: "skip"
        });
        await reloadState();
      });
      actions.appendChild(skip);
    } else {
      gameSelect.disabled = true;
      if (job.status === "processed") {
        const done = createNode("span", "job-finished-note", "Archive was extracted and removed.");
        actions.appendChild(done);
      }
    }

    container.appendChild(fragment);
  });
}

function renderExtractionStatus() {
  const node = $("#extraction-status");
  const extraction = state.currentExtraction;
  if (!extraction) {
    node.classList.add("hidden");
    node.textContent = "";
    return;
  }

  const elapsedMs = Date.now() - new Date(extraction.startedAt).getTime();
  const remainingMs = Math.max(
    0,
    Number((extraction.estimatedRemainingMs ?? extraction.estimatedTotalMs) || 0)
  );
  node.classList.remove("hidden");
  node.innerHTML = "";
  node.appendChild(createNode("strong", "extraction-title", "Extraction in progress"));
  node.appendChild(
    createNode(
      "p",
      "extraction-text",
      `${extraction.archiveName} is being extracted. Current file: ${extraction.currentFile || "Preparing..."} | Files: ${extraction.processedFiles || 0}${extraction.totalFiles ? ` / ${extraction.totalFiles}` : ""} | Elapsed: ${formatDurationMs(elapsedMs)} | Estimated remaining: ${formatDurationMs(remainingMs)}`
    )
  );
}

function render() {
  setSettingsForm(state.settings);
  renderAuth();
  renderOverlays();
  renderStats();
  renderGames();
  renderEditFolderPanel();
  renderJobs();
}

async function reloadState() {
  if (reloadStatePromise) {
    reloadStateQueued = true;
    return reloadStatePromise;
  }

  reloadStatePromise = (async () => {
    do {
      reloadStateQueued = false;
      const nextState = await window.f95App.bootstrap();
      Object.assign(state, nextState);
      pruneLaunchExecutableCache(state.games);
      if (!state.games.some((game) => game.id === state.selectedGameId)) {
        state.selectedGameId = null;
      }
      if (!state.games.some((game) => (game.folders || []).some((folder) => folder.id === state.editingFolderId))) {
        state.editingFolderId = null;
        if (state.openOverlay === "edit-folder") {
          state.openOverlay = null;
        }
      }
      render();
    } while (reloadStateQueued);
  })();

  try {
    await reloadStatePromise;
  } finally {
    reloadStatePromise = null;
  }
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  $("#settings-status").textContent = "saving";
  try {
    await window.f95App.updateSettings({
      watchFolder: form.watchFolder.value.trim(),
      installRoot: form.installRoot.value.trim(),
      syncIntervalMinutes: Number(form.syncIntervalMinutes.value || 30)
    });
    $("#settings-status").textContent = "saved";
    await reloadState();
  } catch (error) {
    $("#settings-status").textContent = "error";
    alert(error.message);
  }
}

async function handleBrowseFolderClick(event) {
  const button = event.currentTarget;
  const form = $("#settings-form");
  const inputName = button.dataset.targetInput;
  const input = form?.elements?.[inputName];
  if (!input) {
    return;
  }

  try {
    const result = await window.f95App.selectFolder({
      title: inputName === "installRoot" ? "Select install root" : "Select watch folder",
      defaultPath: input.value.trim() || undefined
    });

    if (!result?.canceled && result.path) {
      input.value = result.path;
    }
  } catch (error) {
    alert(error.message);
  }
}

async function handleAddThread(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await window.f95App.addThread(form.threadUrl.value.trim());
    form.reset();
    state.openOverlay = null;
    await reloadState();
  } catch (error) {
    alert(error.message);
  }
}

async function handleExportData() {
  $("#settings-status").textContent = "exporting";
  try {
    const result = await window.f95App.exportData();
    $("#settings-status").textContent = result?.canceled ? "ready" : "exported";
  } catch (error) {
    $("#settings-status").textContent = "error";
    alert(error.message);
  }
}

async function handleImportData() {
  const confirmed = window.confirm("Importing replaces the current local app data. Continue?");
  if (!confirmed) {
    return;
  }

  $("#settings-status").textContent = "importing";
  try {
    const result = await window.f95App.importData();
    if (result?.canceled) {
      $("#settings-status").textContent = "ready";
      return;
    }
    $("#settings-status").textContent = "imported";
    await reloadState();
  } catch (error) {
    $("#settings-status").textContent = "error";
    alert(error.message);
  }
}

async function initialize() {
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
  $("#overlay-backdrop").addEventListener("click", () => {
    state.openOverlay = null;
    state.editingFolderId = null;
    renderOverlays();
  });
  document.querySelectorAll("[data-close-overlay]").forEach((button) => {
    button.addEventListener("click", () => {
      state.openOverlay = null;
      state.editingFolderId = null;
      renderOverlays();
    });
  });
  $("#lightbox-close").addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (state.openOverlay) {
        state.openOverlay = null;
        state.editingFolderId = null;
        renderOverlays();
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

  window.f95App.onStateChanged(async () => {
    await reloadState();
  });

  await reloadState();
}

initialize().catch((error) => {
  alert(error.message);
});
