// Uses the shared state and helpers declared in renderer-app.js.
function setSettingsForm(settings) {
  const form = $("#settings-form");
  form.watchFolder.value = settings.watchFolder || "";
  form.installRoot.value = settings.installRoot || "";
  form.syncIntervalMinutes.value = settings.syncIntervalMinutes || 30;
  form.keepArchives.checked = Boolean(settings.keepArchives);
  form.extraDownloadHosts.value = settings.extraDownloadHosts || "";
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
  } else if (state.auth.sessionExpired) {
    statusNode.textContent = "Your F95Zone session has expired. Log in again for download links and all tags.";
  } else {
    statusNode.textContent = "Not logged in. Threads can be added and refreshed as a guest; log in for download links and all tags.";
  }

  if (resultNode) {
    resultNode.textContent = state.authCheckResult || "";
  }
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  $("#settings-status").textContent = "Saving…";
  try {
    await window.f95App.updateSettings({
      watchFolder: form.watchFolder.value.trim(),
      installRoot: form.installRoot.value.trim(),
      syncIntervalMinutes: Number(form.syncIntervalMinutes.value || 30),
      keepArchives: form.keepArchives.checked,
      extraDownloadHosts: form.extraDownloadHosts.value.trim()
    });
    $("#settings-status").textContent = "Saved";
    await reloadState();
  } catch (error) {
    $("#settings-status").textContent = "Failed – see the message";
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
  $("#settings-status").textContent = "Exporting…";
  try {
    const result = await window.f95App.exportData();
    $("#settings-status").textContent = result?.canceled ? "" : "Exported";
  } catch (error) {
    $("#settings-status").textContent = "Failed – see the message";
    alert(error.message);
  }
}

async function handleImportData() {
  const confirmed = window.confirm("Importing replaces the current local app data. Continue?");
  if (!confirmed) {
    return;
  }

  $("#settings-status").textContent = "Importing…";
  try {
    const result = await window.f95App.importData();
    if (result?.canceled) {
      $("#settings-status").textContent = "";
      return;
    }
    $("#settings-status").textContent = "Imported";
    await reloadState();
  } catch (error) {
    $("#settings-status").textContent = "Failed – see the message";
    alert(error.message);
  }
}
