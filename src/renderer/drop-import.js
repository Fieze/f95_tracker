// Drag & drop import: folders and archives dropped onto the window open this dialog, one item at a time.
// Uses the shared state and helpers declared in renderer-app.js and add-folder.js.
const dropImport = { queue: [], current: null, versionEdited: false, branchEdited: false };

function populateDropImportGames(selectedId) {
  const select = $("#drop-import-form").elements.gameId;
  select.innerHTML = "";
  select.appendChild(new Option("New game from a thread URL…", ""));
  [...state.games]
    .sort((left, right) => String(left.title).localeCompare(String(right.title), undefined, { sensitivity: "base" }))
    .forEach((game) => select.appendChild(new Option(game.title, String(game.id))));
  select.value = selectedId ? String(selectedId) : "";
}

function updateDropImportForm() {
  const form = $("#drop-import-form");
  const item = dropImport.current;
  if (!item) return;
  const isFolder = item.kind === "folder";
  const installRoot = (state.settings.installRoot || "").trim();
  const game = state.games.find((entry) => String(entry.id) === form.elements.gameId.value);

  $("#drop-import-url-label").classList.toggle("hidden", Boolean(game));
  form.elements.threadUrl.required = !game;
  $("#drop-import-mode").classList.toggle("hidden", !isFolder);
  $("#drop-import-extract").classList.toggle("hidden", isFolder);
  $("#drop-import-extract").disabled = !installRoot || item.split;
  $("#drop-import-extract").title = installRoot ? "" : "Set an install root in Settings to enable extracting.";
  $("#drop-import-add").disabled = Boolean(item.split);
  $("#drop-import-split-warning").classList.toggle("hidden", !item.split);
  fillBranchOptions(game);
  fillVersionOptions(game, form.elements.branch.value.trim() || null);

  const moveOption = form.querySelector("input[name='mode'][value='move']");
  moveOption.disabled = !installRoot;
  if (!installRoot && moveOption.checked) form.querySelector("input[name='mode'][value='keep']").checked = true;
  $("#drop-import-destination").textContent = !installRoot
    ? "Set an install root in Settings to enable moving."
    : [
      installRoot.replace(/[\\/]+$/, ""),
      game ? sanitizeFolderSegment(game.title) : "<game title>",
      form.elements.branch.value.trim() && sanitizeFolderSegment(form.elements.branch.value),
      item.name
    ].filter(Boolean).join("\\");
}

function showDropImportItem() {
  const form = $("#drop-import-form");
  const item = dropImport.current;
  const isFolder = item.kind === "folder";
  const remaining = dropImport.queue.length;

  form.reset();
  dropImport.versionEdited = false;
  dropImport.branchEdited = false;
  populateDropImportGames(item.gameId);
  const game = state.games.find((entry) => entry.id === item.gameId);
  form.elements.branch.value = item.branch || "";
  $("#drop-import-hint").textContent = item.gameId
    ? `Suggested from the name (${item.confidence === "high" ? "high" : "low"} confidence). Please check it.`
    : "No library game matches this name.";
  form.elements.version.value = snapVersionToOptions(game, item.version || "");
  $("#drop-import-eyebrow").textContent = remaining ? `Import · ${remaining} more waiting` : "Import";
  $("#drop-import-title").textContent = isFolder ? "Add Dropped Folder" : "Add Dropped Archive";
  $("#drop-import-source").textContent = item.path;
  $("#drop-import-add").textContent = isFolder ? "Add Folder" : "Add Archive";
  $("#drop-import-skip").classList.toggle("hidden", !remaining);
  updateDropImportForm();
  state.openOverlay = "drop-import";
  render();
}

// Moves on to the next dropped item, or closes the dialog when none are left.
function advanceDropImport() {
  dropImport.current = dropImport.queue.shift() || null;
  if (dropImport.current) {
    showDropImportItem();
    return;
  }
  state.openOverlay = null;
  render();
}

function dismissDropImport() {
  dropImport.queue = [];
  dropImport.current = null;
  state.openOverlay = null;
}

async function handleFilesDropped(paths) {
  // Dialogs are modal; a drop is only taken while the library or this dialog itself is showing.
  if (state.openOverlay && state.openOverlay !== "drop-import") return;
  try {
    const items = await window.f95App.inspectDroppedPaths(paths);
    const usable = items.filter((item) => item.kind !== "unsupported");
    if (!usable.length) {
      alert("Drop a game folder or a ZIP, RAR or 7z archive.");
      return;
    }
    const known = new Set([dropImport.current, ...dropImport.queue].filter(Boolean).map((item) => item.path));
    dropImport.queue.push(...usable.filter((item) => !known.has(item.path)));
    if (!dropImport.current) advanceDropImport();
    else $("#drop-import-eyebrow").textContent = `Import · ${dropImport.queue.length} more waiting`;
    if (!dropImport.current) return;
    $("#drop-import-skip").classList.toggle("hidden", !dropImport.queue.length);
  } catch (error) {
    alert(error.message);
  }
}

async function handleDropImportSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const item = dropImport.current;
  if (!item) return;
  const extract = event.submitter?.dataset.action === "extract";
  const buttons = form.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const common = {
      gameId: form.elements.gameId.value || null,
      threadUrl: form.elements.threadUrl.value.trim(),
      version: form.elements.version.value.trim(),
      branch: form.elements.branch.value.trim()
    };
    // The check happens right away; moving, extracting and importing continue in the background (status line).
    const result = item.kind === "folder"
      ? await window.f95App.addExistingFolder({
        ...common,
        folderPath: item.path,
        mode: form.querySelector("input[name='mode']:checked").value
      })
      : await window.f95App.addDroppedArchive({ ...common, archivePath: item.path, extract });
    if (result?.duplicate) alert(`${item.name} is already being added.`);
    await reloadState();
    advanceDropImport();
  } catch (error) {
    alert(error.message);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
    updateDropImportForm();
  }
}

// Without a manual edit, the suggested version follows the folder/archive name; a typed version is never overwritten.
async function handleDropImportGameChange() {
  updateDropImportForm();
  const item = dropImport.current;
  if (!item || dropImport.versionEdited) return;
  try {
    const result = await window.f95App.inferInstalledVersion(item.name);
    const game = state.games.find((entry) => String(entry.id) === $("#drop-import-form").elements.gameId.value);
    if (dropImport.current === item && !dropImport.versionEdited) {
      $("#drop-import-form").elements.version.value = snapVersionToOptions(game, result?.inferredVersion || "");
    }
  } catch {
    // The guess is only a convenience.
  }
}

function initDropImport() {
  const form = $("#drop-import-form");
  form.addEventListener("submit", handleDropImportSubmit);
  form.elements.gameId.addEventListener("change", handleDropImportGameChange);
  form.elements.version.addEventListener("input", () => { dropImport.versionEdited = true; });
  form.elements.branch.addEventListener("input", () => { dropImport.branchEdited = true; });
  form.addEventListener("change", updateDropImportForm);
  $("#drop-import-skip").addEventListener("click", advanceDropImport);
  window.f95App.onFilesDropped(handleFilesDropped);
}
