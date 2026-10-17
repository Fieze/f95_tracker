// "Add existing folder" dialog. Uses the shared state and helpers declared in renderer-app.js.
function sanitizeFolderSegment(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim()
    .replace(/[. ]+$/g, "") || "game";
}

function folderNameOf(folderPath) {
  return String(folderPath || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
}

function populateAddFolderGames() {
  const select = $("#add-folder-form").elements.gameId;
  const previous = select.value;
  select.innerHTML = "";
  select.appendChild(new Option("New game from a thread URL\u2026", ""));
  [...state.games]
    .sort((left, right) => String(left.title).localeCompare(String(right.title), undefined, { sensitivity: "base" }))
    .forEach((game) => select.appendChild(new Option(game.title, String(game.id))));
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

// Keeps the form consistent: URL field only for new games, move option only when an install root exists, and a
// preview of where the folder would end up.
function updateAddFolderForm() {
  const form = $("#add-folder-form");
  const installRoot = (state.settings.installRoot || "").trim();
  const game = state.games.find((entry) => String(entry.id) === form.elements.gameId.value);
  const moveOption = form.querySelector("input[name='mode'][value='move']");
  const folderName = folderNameOf(form.elements.folderPath.value);

  form.querySelector("#add-folder-url-label").classList.toggle("hidden", Boolean(game));
  form.elements.threadUrl.required = !game;
  moveOption.disabled = !installRoot;
  if (!installRoot && moveOption.checked) form.querySelector("input[name='mode'][value='keep']").checked = true;

  const destination = $("#add-folder-destination");
  if (!installRoot) {
    destination.textContent = "Set an install root in Settings to enable moving.";
  } else {
    const title = game ? sanitizeFolderSegment(game.title) : "<game title>";
    destination.textContent = `${installRoot.replace(/[\\/]+$/, "")}\\${title}\\${folderName || "<folder name>"}`;
  }
}

async function handleAddFolderSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const mode = form.querySelector("input[name='mode']:checked").value;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    // Checks the folder right away; the move/import itself continues in the background (status line).
    const result = await window.f95App.addExistingFolder({
      folderPath: form.elements.folderPath.value.trim(),
      gameId: form.elements.gameId.value || null,
      threadUrl: form.elements.threadUrl.value.trim(),
      mode
    });
    if (result?.duplicate) alert("This folder is already being added.");
    form.reset();
    closeAddFolderPanel();
    await reloadState();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

async function handleBrowseExistingFolder() {
  const form = $("#add-folder-form");
  try {
    const result = await window.f95App.selectFolder({
      title: "Select the game's folder",
      defaultPath: form.elements.folderPath.value.trim() || undefined
    });
    if (!result?.canceled && result.path) {
      form.elements.folderPath.value = result.path;
      updateAddFolderForm();
    }
  } catch (error) {
    alert(error.message);
  }
}

// Opens the dialog, optionally for one specific game (from its details panel). Closing returns to where it was opened.
function openAddFolderPanel(gameId = null) {
  state.addFolderReturnToDetails = gameId !== null && state.openOverlay === "game-details";
  populateAddFolderGames();
  const form = $("#add-folder-form");
  form.reset();
  if (gameId !== null) form.elements.gameId.value = String(gameId);
  updateAddFolderForm();
  state.openOverlay = "add-folder";
  render();
}

function closeAddFolderPanel() {
  state.openOverlay = state.addFolderReturnToDetails && state.selectedGameId ? "game-details" : null;
  state.addFolderReturnToDetails = false;
}

function initAddFolderPanel() {
  const form = $("#add-folder-form");
  form.addEventListener("submit", handleAddFolderSubmit);
  form.addEventListener("input", updateAddFolderForm);
  form.addEventListener("change", updateAddFolderForm);
  $("#browse-existing-folder").addEventListener("click", handleBrowseExistingFolder);
  $("#open-add-folder-panel").addEventListener("click", () => openAddFolderPanel());
}
