// Status line at the bottom of the window: shows what is running in the background.
// Uses the shared state and helpers declared in renderer-app.js and activities.js.
function buildStatusItems() {
  const items = [];

  for (const activity of state.activities || []) {
    const progress = activity.progress ? ` (${activity.progress.done}/${activity.progress.total})` : "";
    if (activity.status === "running") {
      items.push({ kind: "running", text: `${activity.label}${progress}` });
    } else if (activity.status === "error") {
      items.push({ kind: "error", text: `${activity.label}: ${activity.message}`, activityId: activity.id });
    } else {
      items.push({ kind: "done", text: activity.message || activity.label });
    }
  }

  const downloads = getActiveDownloadJobs();
  if (downloads.length > 0) {
    const known = downloads.filter((job) => Number(job.bytesTotal) > 0);
    const percent = known.length
      ? Math.round(known.reduce((sum, job) => sum + getDownloadProgressPercent(job), 0) / known.length)
      : null;
    const label = downloads.length === 1 ? "Downloading 1 file" : `Downloading ${downloads.length} files`;
    items.push({ kind: "running", text: percent === null ? label : `${label} (${percent}%)` });
  }

  const extraction = state.currentExtraction;
  if (extraction) {
    const files = extraction.totalFiles ? ` (${extraction.processedFiles || 0}/${extraction.totalFiles} files)` : "";
    items.push({ kind: "running", text: `Extracting ${extraction.archiveName}${files}` });
  }

  const queued = (state.archiveJobs || []).filter((job) => job.status === "queued").length;
  if (queued > 0) {
    items.push({ kind: "running", text: `${queued} archive${queued === 1 ? "" : "s"} waiting for extraction` });
  }

  // Failures first, then running work, then finished entries.
  const order = { error: 0, running: 1, done: 2 };
  return items.sort((left, right) => order[left.kind] - order[right.kind]);
}

function renderStatusLine() {
  const container = $("#status-line-items");
  if (!container) return;
  const items = buildStatusItems();
  container.innerHTML = "";
  $("#status-line").classList.toggle("is-busy", items.some((item) => item.kind === "running"));

  if (items.length === 0) {
    container.appendChild(createNode("span", "status-item status-idle", "Ready"));
    return;
  }

  const MAX_VISIBLE = 3;
  const hidden = items.slice(MAX_VISIBLE);
  for (const item of items.slice(0, MAX_VISIBLE)) {
    const node = createNode("span", `status-item status-${item.kind}`);
    node.appendChild(createNode("span", "status-dot"));
    node.appendChild(createNode("span", "status-text", item.text));
    node.title = item.text;
    if (item.activityId) {
      const dismiss = createNode("button", "status-dismiss", "\u00d7");
      dismiss.type = "button";
      dismiss.setAttribute("aria-label", "Dismiss");
      dismiss.addEventListener("click", async () => {
        await window.f95App.dismissActivity(item.activityId);
        await reloadState();
      });
      node.appendChild(dismiss);
    }
    container.appendChild(node);
  }
  if (hidden.length > 0) {
    const more = createNode("span", "status-item status-more", `+${hidden.length} more`);
    more.title = hidden.map((item) => item.text).join("\n");
    container.appendChild(more);
  }
}
