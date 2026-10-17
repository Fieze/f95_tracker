// Uses the shared state and helpers declared in renderer-app.js.
function createCancelDownloadButton(title = "Cancel download") {
  const button = createNode("button", "download-cancel-button", "");
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  const icon = createSvgNode("svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const rect = createSvgNode("rect");
  rect.setAttribute("x", "7");
  rect.setAttribute("y", "7");
  rect.setAttribute("width", "10");
  rect.setAttribute("height", "10");
  rect.setAttribute("rx", "1.5");
  rect.setAttribute("ry", "1.5");
  icon.appendChild(rect);
  button.appendChild(icon);
  return button;
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

function formatDownloadStatusLabel(status) {
  const labels = {
    opening_host: "opening host",
    awaiting_download: "waiting for download",
    resolving: "resolving",
    downloading: "downloading",
    completed: "done",
    failed: "error",
    canceled: "canceled"
  };
  return labels[String(status || "").toLowerCase()] || formatStatusLabel(status);
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes.toFixed(0)} B`;
}

function formatSpeedMbps(value) {
  const bytesPerSecond = Math.max(0, Number(value || 0));
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
}

function getDownloadProgressPercent(job) {
  const total = Number(job?.bytesTotal || 0);
  const received = Number(job?.bytesReceived || 0);
  if (!total) {
    return 0;
  }
  return Math.max(0, Math.min(100, (received / total) * 100));
}

function buildDownloadProgressSummary(job) {
  if (!job) {
    return "";
  }

  const received = formatBytes(job.bytesReceived);
  const total = job.bytesTotal ? formatBytes(job.bytesTotal) : "unknown size";
  const speed = job.status === "downloading" ? formatSpeedMbps(job.speedBytesPerSecond) : null;
  return speed ? `${received} / ${total} | ${speed}` : `${received} / ${total}`;
}

function getActiveDownloadJobs() {
  return (state.downloadJobs || []).filter((job) =>
    ["opening_host", "awaiting_download", "resolving", "downloading"].includes(job.status)
  );
}

function isCancelableDownloadJob(job) {
  return ["opening_host", "awaiting_download", "resolving", "downloading"].includes(String(job?.status || ""));
}

function getDownloadJobForLink(gameId, link) {
  return (state.downloadJobs || []).find((job) => {
    if (Number(job.gameId) !== Number(gameId)) {
      return false;
    }

    if (job.linkId != null && link.id != null) {
      return Number(job.linkId) === Number(link.id);
    }

    return String(job.sourceUrl || "") === String(link.url || "");
  }) || null;
}

function isSupportedDirectDownload(url, label = "") {
  const normalizedLabel = String(label || "").toLowerCase();
  if (
    normalizedLabel.includes("pixeldrain") ||
    normalizedLabel.includes("vikingfile") ||
    normalizedLabel.includes("vik1ngfile")
  ) {
    return true;
  }

  try {
    const host = new URL(String(url || "").trim()).host.toLowerCase();
    return (
      host === "vik1ngfile.site" ||
      host === "vikingfile.com" ||
      host === "pixeldrain.com" ||
      host === "www.pixeldrain.com"
    );
  } catch {
    return false;
  }
}

function getArchiveQueueOpenCount(jobs = state.archiveJobs) {
  return (jobs || []).filter((job) => ["needs-review", "queued", "processing", "unmatched"].includes(job.status)).length;
}

function getOpenArchiveJobs(jobs = state.archiveJobs) {
  return (jobs || []).filter((job) => ["needs-review", "queued", "processing", "unmatched"].includes(job.status));
}

function getAttentionArchiveCount(jobs = state.archiveJobs) {
  return (jobs || []).filter((job) => ["needs-review", "unmatched"].includes(job.status)).length;
}

function getActiveDownloadCount(downloadJobs = state.downloadJobs) {
  return (downloadJobs || []).filter((job) =>
    ["opening_host", "awaiting_download", "resolving", "downloading"].includes(job.status)
  ).length;
}

function updateArchiveQueueAutoExpand(previousJobs, nextJobs, previousDownloadJobs, nextDownloadJobs) {
  const previousCount = getArchiveQueueOpenCount(previousJobs || []);
  const nextCount = getArchiveQueueOpenCount(nextJobs || []);
  const previousActiveDownloads = getActiveDownloadCount(previousDownloadJobs || []);
  const nextActiveDownloads = getActiveDownloadCount(nextDownloadJobs || []);

  if (!archiveQueueInitialized) {
    state.archiveQueueReady = true;
    archiveQueueInitialized = true;
    return;
  }

  if (nextCount > previousCount || nextActiveDownloads > previousActiveDownloads) {
    state.archiveQueueReady = true;
  }
  // Downloads and extractions report in the status line; the drawer only opens by itself when a decision is needed.
  if (getAttentionArchiveCount(nextJobs || []) > getAttentionArchiveCount(previousJobs || [])) {
    state.activityDrawerOpen = true;
  }
}

function renderJobs() {
  renderExtractionStatus();
  renderActiveDownloads();
  renderArchiveQueueBar();
  const container = $("#jobs-list");
  container.innerHTML = "";
  const openArchiveJobs = getOpenArchiveJobs();

  if (openArchiveJobs.length === 0) {
    container.className = "jobs-list empty-state";
    container.textContent = "No archives need attention.";
    return;
  }

  container.className = "jobs-list";
  const template = $("#job-card-template");

  openArchiveJobs.forEach((job) => {
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

    const isActionable = !["processed", "processing"].includes(job.status);
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

      const deleteButton = createNode("button", "choice-button", "Delete File");
      deleteButton.type = "button";
      deleteButton.addEventListener("click", async () => {
        const confirmed = window.confirm(`Delete "${job.archiveName}" from disk and remove it from the archive queue?`);
        if (!confirmed) {
          return;
        }
        await window.f95App.deleteArchiveFile(job.id);
        await reloadState();
      });
      actions.appendChild(deleteButton);
    } else {
      gameSelect.disabled = true;
      if (job.status === "processed") {
        const done = createNode("span", "job-finished-note", "Archive was extracted and removed.");
        actions.appendChild(done);
      } else {
        const deleteButton = createNode("button", "choice-button", "Delete File");
        deleteButton.type = "button";
        deleteButton.addEventListener("click", async () => {
          const confirmed = window.confirm(`Delete "${job.archiveName}" from disk and remove it from the archive queue?`);
          if (!confirmed) {
            return;
          }
          await window.f95App.deleteArchiveFile(job.id);
          await reloadState();
        });
        actions.appendChild(deleteButton);
      }
    }

    container.appendChild(fragment);
  });
}

function renderActiveDownloads() {
  const section = $("#active-downloads-section");
  const countNode = $("#active-downloads-count");
  const list = $("#active-downloads-list");
  if (!section || !countNode || !list) {
    return;
  }

  const activeJobs = getActiveDownloadJobs();
  section.classList.toggle("hidden", activeJobs.length === 0);
  countNode.textContent = String(activeJobs.length);
  $("#active-downloads-heading").textContent = activeJobs.length > 1 ? `Active Downloads (${activeJobs.length})` : "Active Downloads";
  list.innerHTML = "";

  activeJobs.forEach((job) => {
    const card = createNode("article", "download-activity-card");
    const header = createNode("div", "download-activity-header");
    const titleWrap = createNode("div", "download-activity-title-wrap");
    const headerActions = createNode("div", "download-activity-header-actions");
    const title = createNode("strong", "download-activity-title", job.fileName || job.label || job.host || "Download");
    const subtitle = createNode(
      "span",
      "download-activity-subtitle",
      job.label && job.fileName && job.label !== job.fileName ? `${job.label} | ${job.host}` : job.host || job.label || ""
    );
    const status = createNode("span", `status-chip ${job.status || "unknown"}`, formatDownloadStatusLabel(job.status));
    const progress = document.createElement("progress");
    const progressText = createNode("div", "download-activity-progress-text", buildDownloadProgressSummary(job));

    progress.className = "download-activity-progress";
    progress.max = 100;
    progress.value = getDownloadProgressPercent(job);

    titleWrap.appendChild(title);
    if (subtitle.textContent) {
      titleWrap.appendChild(subtitle);
    }
    header.appendChild(titleWrap);
    headerActions.appendChild(status);
    if (isCancelableDownloadJob(job)) {
      const cancelButton = createCancelDownloadButton();
      cancelButton.addEventListener("click", async () => {
        try {
          await window.f95App.cancelDownload(job.id);
          await reloadState();
        } catch (error) {
          alert(error.message);
        }
      });
      headerActions.appendChild(cancelButton);
    }
    header.appendChild(headerActions);
    card.appendChild(header);
    card.appendChild(progress);
    card.appendChild(progressText);
    list.appendChild(card);
  });
}

function renderArchiveQueueBar() {
  const bar = $("#archive-queue-bar");
  const summary = $("#archive-queue-summary");
  if (!bar || !summary) {
    return;
  }

  const openCount = getArchiveQueueOpenCount();
  const extractionActive = Boolean(state.currentExtraction);
  const activeDownloadCount = getActiveDownloadJobs().length;
  const hasVisibleContent = openCount > 0 || activeDownloadCount > 0 || extractionActive;
  const hasDownloads = activeDownloadCount > 0;
  const hasArchives = openCount > 0;
  const hasExtraction = extractionActive;
  const mode =
    hasDownloads && hasArchives && hasExtraction
      ? "all"
      : hasDownloads && hasArchives
        ? "downloads-archives"
        : hasDownloads && hasExtraction
          ? "downloads-extracting"
          : hasArchives && hasExtraction
            ? "archives-extracting"
            : hasDownloads
              ? "downloads-only"
              : hasArchives
                ? "archives-only"
                : hasExtraction
                  ? "extracting-only"
                  : "hidden";
  const summaryText = activeDownloadCount > 0
    ? `${activeDownloadCount} download${activeDownloadCount === 1 ? "" : "s"} active.`
    : extractionActive
      ? "Extraction in progress."
      : openCount > 0
        ? `${openCount} archive${openCount === 1 ? "" : "s"} need attention.`
        : "";

  if (!hasVisibleContent) state.activityDrawerOpen = false;
  bar.classList.toggle("is-pending", !state.archiveQueueReady || !hasVisibleContent || !state.activityDrawerOpen);
  bar.dataset.mode = mode;
  summary.textContent = summaryText;

  const toggle = $("#status-line-toggle");
  const attention = getAttentionArchiveCount();
  toggle.classList.toggle("hidden", !hasVisibleContent);
  toggle.setAttribute("aria-expanded", state.activityDrawerOpen ? "true" : "false");
  $("#status-toggle-badge").textContent = String(attention);
  $("#status-toggle-badge").classList.toggle("hidden", attention === 0);
  syncArchiveBarReservedSpace();
  if (!archiveBarResizeObserver && typeof ResizeObserver !== "undefined") {
    archiveBarResizeObserver = new ResizeObserver(syncArchiveBarReservedSpace);
    archiveBarResizeObserver.observe(bar);
  }
}

function setActivityDrawerOpen(open) {
  state.activityDrawerOpen = open;
  renderArchiveQueueBar();
}

// The bar's height follows its content (capped, then it scrolls); content below it keeps exactly that much room.
let archiveBarResizeObserver = null;
function syncArchiveBarReservedSpace() {
  const bar = $("#archive-queue-bar");
  if (!bar) return;
  const occupied = bar.classList.contains("is-pending") ? 0 : Math.ceil(bar.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--archive-bar-reserved-space", `${occupied}px`);
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
