// Uses the shared state and helpers declared in renderer-app.js.
function setSettingsForm(settings) {
  const form = $("#settings-form");
  form.watchFolder.value = settings.watchFolder || "";
  form.installRoot.value = settings.installRoot || "";
  form.syncIntervalMinutes.value = settings.syncIntervalMinutes || 30;
}

function renderAuth() {
  const api = state.api || {};
  $("#api-status").textContent = api.configured
    ? `${api.persistent ? "Key stored securely" : "Key available for this session only"}. ${api.message || "Connection not tested."}`
    : api.loadFailed ? "Saved API key could not be loaded. Enter it again." : "No API key. Metadata requires an F95Zone login.";
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
    statusNode.textContent = api.configured ? "API metadata is available without an F95Zone login. Sign in here for forum access or scraper fallback." : "Not logged in. Configure an API key or sign in to F95Zone.";
  }

  if (resultNode) {
    resultNode.textContent = state.authCheckResult || "";
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
