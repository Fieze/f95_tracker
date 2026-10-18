// Uses the shared state and helpers declared in renderer-app.js.
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

// Titles keep one size and are clamped to two lines in CSS; the full title is available as a tooltip.
function fitGameTileTitles(container = $("#games-list")) {
  if (!container) {
    return;
  }

  container.querySelectorAll(".game-tile-title").forEach((titleNode) => {
    titleNode.title = titleNode.textContent;
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
  const addFolderButton = detailFragment.querySelector(".add-folder-button");
  addFolderButton.addEventListener("click", () => openAddFolderPanel(selectedGame.id));
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
  const changelog = detailFragment.querySelector(".changelog");
  changelog.textContent = selectedGame.changelog || "";
  detailFragment.querySelector(".changelog-section").classList.toggle("hidden", !selectedGame.changelog);
  const setOptionalField = (itemSelector, valueSelector, text) => {
    const item = detailFragment.querySelector(itemSelector);
    detailFragment.querySelector(valueSelector).textContent = text || "";
    item.classList.toggle("hidden", !text);
  };
  setOptionalField(
    ".rating-item", ".rating-value",
    selectedGame.rating == null
      ? ""
      : `${selectedGame.rating.toFixed(1)} / 5${selectedGame.ratingCount ? ` (${selectedGame.ratingCount.toLocaleString("en-US")} votes)` : ""}`
  );
  setOptionalField(".os-item", ".os-value", selectedGame.os);
  setOptionalField(".language-item", ".language-value", selectedGame.language);
  setOptionalField(".censored-item", ".censored-value", selectedGame.censored);
  const developerLinks = detailFragment.querySelector(".developer-links");
  (selectedGame.developerLinks || []).forEach((link) => {
    const anchor = createNode("a", "developer-link", link.label || link.url);
    anchor.href = link.url;
    anchor.rel = "noopener noreferrer";
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      window.f95App.openLink(link.url);
    });
    developerLinks.appendChild(anchor);
  });
  developerLinks.classList.toggle("hidden", !(selectedGame.developerLinks || []).length);
  const historyList = detailFragment.querySelector(".history-list");
  (selectedGame.history || []).forEach((entry) => {
    const item = createNode("li", "history-entry");
    const heading = createNode(
      "strong",
      "",
      entry.previousVersion ? `${entry.previousVersion} → ${entry.version}` : `${entry.version} (first seen)`
    );
    item.append(heading, createNode("span", "history-date", formatDate(entry.detectedAt)));
    if (entry.changelog) item.appendChild(createNode("p", "history-changelog", entry.changelog));
    historyList.appendChild(item);
  });
  detailFragment.querySelector(".history-section").classList.toggle("hidden", !(selectedGame.history || []).length);
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
      if (folder.branch) {
        const branchMeta = createNode("div", "install-folder-meta");
        branchMeta.appendChild(createNode("span", "install-folder-meta-heading", "Branch"));
        branchMeta.appendChild(createNode("span", "install-folder-season-label-display", folder.branch));
        summary.appendChild(branchMeta);
      }
      if (selectedGame.hasSeasons && !folder.branch) {
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

  renderBranchSection(detailFragment.querySelector("[data-section='branches']"), selectedGame);

  (selectedGame.downloadGroups || []).forEach((group) => {
    const wrapper = createNode("div", "download-group");
    const isSplit = group.variant === "Split";
    // The newest version of this chapter / season, falling back to the thread's current version.
    const groupVersion = group.branchVersion || selectedGame.branchLatest?.[group.branch] || selectedGame.currentVersion || "";
    wrapper.appendChild(createNode("strong", "", group.label));
    if (groupVersion && group.branch) wrapper.appendChild(createNode("small", "download-status", `Latest: ${groupVersion}`));
    if (isSplit) {
      wrapper.appendChild(
        createNode("small", "download-status status-failed", "Split archives are not supported by this app. Open the download page and download the parts yourself.")
      );
    }
    (group.links || []).forEach((link) => {
      const row = createNode("div", "download-row");
      const job = getDownloadJobForLink(selectedGame.id, link);
      const status = job?.status || "";
      const busy = ["queued", "opening_host", "awaiting_download", "resolving", "downloading"].includes(status);
      const supportsDirectDownload = !isSplit && isSupportedDirectDownload(link.url, link.label);
      const labelWrap = createNode("div", "download-meta");
      const actions = createNode("div", "download-actions");
      const primaryButton = createNode(
        "button",
        "download-button",
        supportsDirectDownload ? (busy ? "Downloading..." : "Download") : "Open Link"
      );
      const secondaryButton = supportsDirectDownload
        ? createNode("button", "download-button secondary", "Open Host")
        : null;
      labelWrap.appendChild(createNode("span", "", link.label));
      if (!supportsDirectDownload && !isSplit) {
        labelWrap.appendChild(
          createNode("small", "download-status", "Direct download is currently only available for Vikingfile and Pixeldrain.")
        );
      }
      if (job) {
        const statusText = job.errorMessage
          ? `${formatDownloadStatusLabel(job.status)} - ${job.errorMessage}`
          : formatDownloadStatusLabel(job.status);
        labelWrap.appendChild(createNode("small", `download-status status-${job.status}`, statusText));
        if (job.status === "downloading") {
          const progress = document.createElement("progress");
          progress.className = "download-progress";
          progress.max = 100;
          progress.value = getDownloadProgressPercent(job);
          labelWrap.appendChild(progress);
          labelWrap.appendChild(
            createNode("small", "download-progress-text", buildDownloadProgressSummary(job))
          );
        }
      }

      primaryButton.type = "button";
      primaryButton.disabled = supportsDirectDownload && busy;
      primaryButton.addEventListener("click", async () => {
        if (!supportsDirectDownload) {
          window.f95App.openLink(link.url);
          return;
        }

        try {
          await window.f95App.startDownload({
            gameId: selectedGame.id,
            linkId: link.id,
            url: link.url,
            label: link.label,
            detectedVersion: groupVersion,
            branch: group.branch || "",
            variant: group.variant || ""
          });
        } catch (error) {
          alert(error.message);
        }
      });

      if (secondaryButton) {
        secondaryButton.type = "button";
        secondaryButton.addEventListener("click", () => window.f95App.openLink(link.url));
      }

      row.appendChild(labelWrap);
      actions.appendChild(primaryButton);
      if (job && isCancelableDownloadJob(job)) {
        const cancelButton = createCancelDownloadButton();
        cancelButton.addEventListener("click", async () => {
          try {
            await window.f95App.cancelDownload(job.id);
            await reloadState();
          } catch (error) {
            alert(error.message);
          }
        });
        actions.appendChild(cancelButton);
      }
      if (secondaryButton) {
        actions.appendChild(secondaryButton);
      }
      row.appendChild(actions);
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

function renderGameDetailsPanel() {
  const panel = $("#game-details-panel");
  const body = $("#game-details-panel-body");
  if (!panel || !body) {
    return;
  }

  const game = getSelectedGame();
  body.innerHTML = "";
  if (!game || state.openOverlay !== "game-details") {
    return;
  }

  $("#game-details-panel-title").textContent = game.title;
  body.appendChild(buildGameDetailsCard(game));
  renderGameDetailsNav(panel, body);
}

const DETAIL_SECTIONS = [
  ["branches", "Chapters"],
  ["installations", "Installations"],
  ["overview", "Overview"],
  ["genre", "Genre"],
  ["screenshots", "Screenshots"],
  ["downloads", "Downloads"]
];

// Jump links in the sticky panel header: a long details view stays navigable without hunting through scrolling.
function renderGameDetailsNav(panel, body) {
  const nav = $("#game-details-nav");
  nav.innerHTML = "";
  for (const [key, label] of DETAIL_SECTIONS) {
    const section = body.querySelector(`[data-section="${key}"]`);
    if (!section || section.classList.contains("hidden") || section.children.length === 0) continue;
    const button = createNode("button", "details-nav-link", label);
    button.type = "button";
    button.addEventListener("click", () => {
      section.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    });
    nav.appendChild(button);
  }
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
  fillVersionOptions(game, folder.branch);
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
      state.openOverlay = state.selectedGameId ? "game-details" : null;
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
      state.openOverlay = state.selectedGameId ? "game-details" : null;
      await reloadState();
    } catch (error) {
      alert(error.message);
    }
  };
}

function renderGames() {
  const container = $("#games-list");
  container.innerHTML = "";

  const visibleGames = selectVisibleGames(state.games, state.libraryView);
  $("#library-count").textContent =
    state.games.length > 0 && visibleGames.length !== state.games.length
      ? `${visibleGames.length} of ${state.games.length}`
      : "";

  renderSetupHint();
  if (visibleGames.length === 0) {
    container.className = "games-list empty-state";
    container.textContent = "";
    container.style.removeProperty("grid-template-columns");
    container.appendChild(buildLibraryEmptyState(state.games.length === 0));
    return;
  }

  container.className = "games-list";
  const template = $("#game-card-template");

  visibleGames.forEach((game) => {
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
    threadStatusBadge.setAttribute("aria-label", game.threadStatus || "");
    threadStatusBadge.setAttribute("title", game.threadStatus || "");
    threadStatusBadge.classList.remove("status-complete", "status-on-hold", "status-abandoned");
    const statusClass = threadStatusClass(game.threadStatus);
    if (statusClass) {
      threadStatusBadge.classList.add(statusClass);
    }
    const statusLabel = threadStatusBadge.querySelector(".game-thread-status-label");
    if (statusClass === "status-complete" || statusClass === "status-abandoned" || statusClass === "status-on-hold") {
      if (statusLabel) {
        statusLabel.textContent = "";
      }
    } else if (statusLabel) {
      statusLabel.textContent = game.threadStatus || "";
    }
    threadStatusBadge.classList.toggle("hidden", !game.threadStatus);
    threadStatusBadge.classList.toggle(
      "is-icon-badge",
      statusClass === "status-complete" || statusClass === "status-abandoned" || statusClass === "status-on-hold"
    );
    button.classList.toggle("is-selected", game.id === state.selectedGameId && state.openOverlay === "game-details");
    button.dataset.gameId = String(game.id);
    button.addEventListener("click", () => {
      if (state.selectedGameId === game.id && state.openOverlay === "game-details") {
        state.selectedGameId = null;
        state.editingFolderId = null;
        state.openOverlay = null;
      } else {
        state.selectedGameId = game.id;
        state.editingFolderId = null;
        state.openOverlay = "game-details";
      }
      render();
    });

    container.appendChild(tile);
  });

  layoutGamesGrid();
}

// Empty library: explain what to do and offer the two ways in. Filtered to nothing: offer to clear the filters.
function buildLibraryEmptyState(libraryIsEmpty) {
  const card = createNode("div", "empty-card");
  if (libraryIsEmpty) {
    card.appendChild(createNode("h4", "empty-card-title", "Your library is empty"));
    card.appendChild(createNode("p", "empty-card-text", "Add a thread from F95Zone to start tracking it, or register a game you already have on disk."));
    const actions = createNode("div", "empty-card-actions");
    const addThread = createNode("button", "primary", "Add thread");
    addThread.type = "button";
    addThread.addEventListener("click", () => { state.openOverlay = "add-thread"; render(); });
    const addFolder = createNode("button", "secondary", "Add existing folder");
    addFolder.type = "button";
    addFolder.addEventListener("click", () => openAddFolderPanel());
    actions.append(addThread, addFolder);
    card.appendChild(actions);
  } else {
    card.appendChild(createNode("h4", "empty-card-title", "No games match"));
    card.appendChild(createNode("p", "empty-card-text", "Nothing in your library fits the current search and filter."));
    const clear = createNode("button", "secondary", "Clear search and filter");
    clear.type = "button";
    clear.addEventListener("click", () => {
      state.libraryView.query = "";
      state.libraryView.filter = "all";
      $("#library-search").value = "";
      $("#library-filter").value = "all";
      saveLibraryView();
      renderGames();
    });
    card.appendChild(clear);
  }
  return card;
}

// A one-line hint while the folders needed for downloads and installs are not configured yet.
function renderSetupHint() {
  const missing = [];
  if (!(state.settings.installRoot || "").trim()) missing.push("an install root");
  if (!(state.settings.watchFolder || "").trim()) missing.push("a watch folder");
  const hint = $("#setup-hint");
  hint.classList.toggle("hidden", missing.length === 0);
  if (missing.length) {
    $("#setup-hint-text").textContent = `Set ${missing.join(" and ")} in Settings to download, extract and install games.`;
  }
}

async function handleAddThread(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    // The address is validated right away; the import itself runs in the background and reports in the status line.
    const result = await window.f95App.addThread(form.threadUrl.value.trim());
    form.reset();
    state.openOverlay = null;
    if (result?.duplicate) alert("This thread is already being imported.");
    await reloadState();
  } catch (error) {
    alert(error.message);
  }
}

const LIBRARY_VIEW_STORAGE_KEY = "f95.libraryView";

function loadLibraryView() {
  try {
    const saved = JSON.parse(localStorage.getItem(LIBRARY_VIEW_STORAGE_KEY) || "{}");
    if (saved.filter in LIBRARY_FILTERS) state.libraryView.filter = saved.filter;
    if (saved.sort in LIBRARY_SORTS) state.libraryView.sort = saved.sort;
  } catch { /* storage unavailable: keep defaults */ }
}

function saveLibraryView() {
  try {
    const { filter, sort } = state.libraryView;
    localStorage.setItem(LIBRARY_VIEW_STORAGE_KEY, JSON.stringify({ filter, sort }));
  } catch { /* storage unavailable: view just is not remembered */ }
}

function initLibraryToolbar() {
  loadLibraryView();
  $("#library-filter").value = state.libraryView.filter;
  $("#library-sort").value = state.libraryView.sort;
  $("#library-search").addEventListener("input", (event) => {
    state.libraryView.query = event.target.value;
    renderGames();
  });
  $("#library-filter").addEventListener("change", (event) => {
    state.libraryView.filter = event.target.value;
    saveLibraryView();
    renderGames();
  });
  $("#library-sort").addEventListener("change", (event) => {
    state.libraryView.sort = event.target.value;
    saveLibraryView();
    renderGames();
  });
}
