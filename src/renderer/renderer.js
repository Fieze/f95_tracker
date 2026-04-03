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
  games: [],
  archiveJobs: []
};

function $(selector) {
  return document.querySelector(selector);
}

function createNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatStatusLabel(status) {
  return String(status || "unknown").replace(/-/g, " ");
}

function formatDate(value) {
  if (!value) return "Never";
  return new Date(value).toLocaleString("en-US");
}

function setSettingsForm(settings) {
  const form = $("#settings-form");
  form.watchFolder.value = settings.watchFolder || "";
  form.installRoot.value = settings.installRoot || "";
  form.syncIntervalMinutes.value = settings.syncIntervalMinutes || 30;
}

function renderAuth() {
  const statusNode = $("#auth-status");
  if (!statusNode) return;

  if (state.auth.loggedIn) {
    statusNode.textContent = "Logged in. The app is now using its own F95Zone session.";
  } else {
    statusNode.textContent = "Not logged in. Open the login window and sign in to F95Zone there.";
  }
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

function renderGames() {
  const container = $("#games-list");
  container.innerHTML = "";

  if (state.games.length === 0) {
    container.className = "games-list empty-state";
    container.textContent = "No threads added yet.";
    return;
  }

  container.className = "games-list";
  const template = $("#game-card-template");

  state.games.forEach((game) => {
    const fragment = template.content.cloneNode(true);
    const card = fragment.querySelector(".game-card");
    const title = fragment.querySelector(".game-title");
    const meta = fragment.querySelector(".game-meta");
    const status = fragment.querySelector(".game-status");
    const currentVersion = fragment.querySelector(".current-version");
    const installedVersion = fragment.querySelector(".installed-version");
    const lastSync = fragment.querySelector(".last-sync");
    const overview = fragment.querySelector(".overview");
    const tags = fragment.querySelector(".tags");
    const warnings = fragment.querySelector(".warnings");
    const groups = fragment.querySelector(".download-groups");
    const refreshButton = fragment.querySelector(".refresh-button");
    const threadLink = fragment.querySelector(".thread-link");

    title.textContent = game.title;
    meta.textContent = [game.developer, game.engine].filter(Boolean).join(" | ") || "No extra metadata";
    status.textContent = formatStatusLabel(game.status);
    status.classList.add(game.status);
    currentVersion.textContent = game.currentVersion || "Unknown";
    installedVersion.textContent = game.installedVersion || "Not set";
    lastSync.textContent = formatDate(game.lastSyncAt);
    overview.textContent = game.overview || "No overview detected.";
    threadLink.href = game.threadUrl;
    threadLink.textContent = "Open Thread";

    refreshButton.addEventListener("click", async () => {
      try {
        await window.f95App.refreshGame(game.id);
        await reloadState();
      } catch (error) {
        alert(error.message);
      }
    });

    game.tags.forEach((tag) => {
      tags.appendChild(createNode("span", "tag", tag));
    });
    if (game.tags.length === 0) {
      tags.appendChild(createNode("span", "tag", "No tags"));
    }

    game.parserWarnings.forEach((warning) => {
      warnings.appendChild(createNode("span", "warning-pill", warning));
    });

    game.downloadGroups.forEach((group) => {
      const wrapper = createNode("div", "download-group");
      wrapper.appendChild(createNode("strong", "", group.label));
      group.links.forEach((link) => {
        const row = createNode("div", "download-row");
        row.appendChild(createNode("span", "", link.label));
        const button = createNode("button", "download-button", "Open Link");
        button.type = "button";
        button.addEventListener("click", () => window.f95App.openLink(link.url));
        row.appendChild(button);
        wrapper.appendChild(row);
      });
      groups.appendChild(wrapper);
    });

    container.appendChild(card);
  });
}

function renderJobs() {
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
    const card = fragment.querySelector(".job-card");
    const title = fragment.querySelector(".job-title");
    const pathNode = fragment.querySelector(".job-path");
    const status = fragment.querySelector(".job-status");
    const details = fragment.querySelector(".job-details");
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

    if (job.status === "needs-review" || job.status === "unmatched") {
      state.games.forEach((game) => {
        const button = createNode("button", "choice-button", game.title);
        button.type = "button";
        button.addEventListener("click", async () => {
          await window.f95App.resolveArchiveMatch({
            jobId: job.id,
            action: "accept",
            gameId: game.id
          });
          await reloadState();
        });
        actions.appendChild(button);
      });

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
    }

    container.appendChild(card);
  });
}

function render() {
  setSettingsForm(state.settings);
  renderAuth();
  renderStats();
  renderGames();
  renderJobs();
}

async function reloadState() {
  const nextState = await window.f95App.bootstrap();
  Object.assign(state, nextState);
  render();
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

async function handleAddThread(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await window.f95App.addThread(form.threadUrl.value.trim());
    form.reset();
    await reloadState();
  } catch (error) {
    alert(error.message);
  }
}

async function initialize() {
  $("#settings-form").addEventListener("submit", handleSettingsSubmit);
  $("#add-thread-form").addEventListener("submit", handleAddThread);
  $("#refresh-all").addEventListener("click", async () => {
    try {
      await window.f95App.refreshAllGames();
      await reloadState();
    } catch (error) {
      alert(error.message);
    }
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
      await reloadState();
    } catch (error) {
      alert(error.message);
    }
  });

  window.f95App.onStateChanged(async () => {
    await reloadState();
  });

  await reloadState();
}

initialize().catch((error) => {
  alert(error.message);
});
