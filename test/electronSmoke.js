// Runs the real renderer and preload against isolated local test data.
// Remote login/download hosts and game processes are replaced by controlled fixtures.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const assert = require("assert/strict");
const { AppService } = require("../src/main/services/appService");
const { assertTrustedIpcSender } = require("../src/main/services/browserSafety");
const { zipFixture } = require("./zipFixture");

const cache = path.resolve(__dirname, "..", ".cache");
app.setPath("userData", path.join(cache, "electron-smoke-profile"));
let window, service;
let loggedIn = false;
const errors = [], launches = [], checks = [];

app.whenReady().then(async () => {
  await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, "ui-smoke-"));
  service = new AppService({ userDataPath: root,
    authSession: { cookies: { get: async () => loggedIn ? [{ name: "xf_user", value: "test", domain: "f95zone.to", path: "/" }] : [], remove: async () => { loggedIn = false; } } },
    folderWatcher: { start: async () => {}, stop: async () => {}, ignoreFile: () => {} },
    downloadFetch: async () => new Response(zipFixture([{ name: "game.exe", content: "fixture executable" }]), {
      headers: { "content-disposition": 'attachment; filename="fixture.zip"' }
    }),
    launchProcess: (file, args, options) => { launches.push({ file, options }); return { unref() {} }; },
    onStateChanged: () => { if (window && !window.isDestroyed()) window.webContents.send("state:changed"); }
  });
  await service.db.initialize();
  await service.db.saveSettings({ installRoot: path.join(root, "games"), watchFolder: path.join(root, "watch"), syncIntervalMinutes: 30 });
  const game = await service.db.upsertGameFromThread({ sourceUrl: "https://f95zone.to/threads/ui-smoke.333/", title: "UI Smoke Game",
    threadTitle: "UI Smoke Game", currentVersion: "1.0", developer: "Fixture Dev", engine: "Ren'Py", threadStatus: "Ongoing",
    overview: "Local test fixture.", releaseDate: "2026-10-12", changelog: "Fixture changelog", bannerImage: null, screenshotImages: [], tags: ["test"],
    aliases: [], warnings: [], rawOpHtml: "", rawOpText: "", parserDebug: {},
    downloadGroups: [{ label: "Win", links: [{ label: "Pixeldrain", url: "https://pixeldrain.com/fixture.zip" }] }] });
  const exportPath = path.join(root, "export.json");
  const handle = (channel, listener) => ipcMain.handle(channel, (event, payload) => {
    assertTrustedIpcSender(event, window);
    return listener(payload);
  });
  handle("app:bootstrap", () => service.bootstrap());
  handle("games:listLaunchExecutables", (payload) => service.listLaunchExecutables(payload));
  handle("games:launchExecutable", (payload) => service.launchExecutable(payload));
  handle("games:updateFolderMetadata", (payload) => service.updateGameFolderMetadata(payload, payload));
  handle("settings:update", (payload) => service.updateSettings(payload));
  handle("auth:openLogin", () => { loggedIn = true; return service.getAuthState(); });
  handle("auth:logout", () => service.logout());
  handle("data:export", async () => { await service.exportDataToFile(exportPath); return { canceled: false, path: exportPath }; });
  handle("data:import", async () => { await service.importDataFromFile(exportPath); return { canceled: false, path: exportPath }; });
  handle("downloads:start", async (payload) => {
    const job = service.createDownloadJob(payload);
    return service.startResolvedDownload(job.id, { url: payload.url });
  });

  window = new BrowserWindow({ width: 1440, height: 920, show: false,
    webPreferences: { preload: path.resolve(__dirname, "..", "src", "main", "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  window.webContents.on("render-process-gone", (event, details) => errors.push(details.reason));
  await window.loadFile(path.resolve(__dirname, "..", "src", "renderer", "index.html"));
  const js = (code) => window.webContents.executeJavaScript(code);
  await js("window.confirm = () => true; window.alert = (message) => { throw new Error(message); }; reloadState()");
  assert.equal(await js("document.querySelectorAll('#games-list .game-tile').length"), 1); checks.push("library");
  assert.equal(await js("document.querySelector('#status-line-items').textContent"), "Ready"); checks.push("status line idle");
  await js(`state.activities = [
    { id: 1, kind: "refresh-all", label: "Refreshing Example Game", status: "running", progress: { done: 3, total: 35 } },
    { id: 2, kind: "add-thread", label: "Adding another game", status: "error", message: "Thread request failed with status 404" }
  ]; renderStatusLine()`);
  const statusText = await js("document.querySelector('#status-line-items').textContent");
  assert.ok(statusText.includes("Refreshing Example Game (3/35)") && statusText.includes("status 404"), statusText);
  assert.equal(await js("document.querySelector('#status-line').classList.contains('is-busy')"), true);
  await js("document.querySelector('#game-details-panel').classList.add('hidden'); window.scrollTo(0, 0)");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await fs.writeFile(path.join(cache, "ui-status-line.png"), (await window.webContents.capturePage()).toPNG());
  await js("state.activities = []; renderStatusLine()"); checks.push("status line activities");
  await js("document.querySelector('#open-add-thread-panel').click(); document.querySelector('#open-add-folder-panel').click()");
  assert.equal(await js("document.querySelector('#add-folder-panel').classList.contains('hidden')"), false);
  assert.equal(await js("document.querySelectorAll('#add-folder-form select[name=gameId] option').length"), 2);
  assert.equal(await js("document.querySelector('#add-folder-url-label').classList.contains('hidden')"), false, "URL field for new games");
  await js(`const f = document.querySelector('#add-folder-form'); f.elements.folderPath.value = 'D:/Games/Some Game v1.0';
    f.elements.gameId.value = f.elements.gameId.options[1].value; f.dispatchEvent(new Event('change', { bubbles: true }));`);
  assert.equal(await js("document.querySelector('#add-folder-url-label').classList.contains('hidden')"), true, "URL field hidden for library games");
  assert.equal(await js("getComputedStyle(document.querySelector('#add-folder-url-label')).display"), "none", "URL field is really hidden");
  const destination = await js("document.querySelector('#add-folder-destination').textContent");
  assert.ok(destination.endsWith(["UI Smoke Game", "Some Game v1.0"].join(String.fromCharCode(92))), destination);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await js("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fs.writeFile(path.join(cache, "ui-add-folder.png"), (await window.webContents.capturePage()).toPNG());
  await js("document.querySelector('#overlay-backdrop').click()"); checks.push("add folder dialog");
  await js("document.querySelector('#games-list button').click()");
  assert.equal(await js("document.querySelector('#game-details-panel').classList.contains('hidden')"), false); checks.push("details");
  assert.equal(await js("document.querySelector('#game-details-panel .changelog').textContent"), "Fixture changelog");
  assert.equal(await js("getComputedStyle(document.querySelector('#game-details-panel .rating-item')).display"), "none", "empty optional fields stay hidden");
  assert.equal(await js("document.querySelectorAll('#game-details-panel .history-entry').length"), 1, "first sync is recorded in the history");
  assert.equal(await js("getComputedStyle(document.querySelector('#game-details-panel .history-section')).display"), "block");
  // Import button inside the game details: opens the dialog for exactly this game and returns to the details.
  await js("document.querySelector('#game-details-panel .add-folder-button').click()");
  assert.equal(await js("state.openOverlay"), "add-folder");
  assert.equal(await js("document.querySelector('#add-folder-form').elements.gameId.selectedOptions[0].textContent"), "UI Smoke Game");
  assert.equal(await js("getComputedStyle(document.querySelector('#add-folder-url-label')).display"), "none");
  await js("document.querySelector('#overlay-backdrop').click()");
  assert.equal(await js("state.openOverlay"), "game-details", "closing the dialog returns to the game details");
  assert.equal(await js("state.selectedGameId !== null"), true); checks.push("details add folder button");
  await js("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fs.writeFile(path.join(cache, "ui-details.png"), (await window.webContents.capturePage()).toPNG());
  assert.equal(await js("getComputedStyle(document.querySelector('#game-details-panel .developer-links')).display"), "none");
  await js("document.querySelector('#open-settings-panel').click(); handleExportData()");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await js("document.querySelector('#settings-status').textContent"), "Exported");
  await js("handleImportData()");
  assert.equal(await js("document.querySelector('#settings-status').textContent"), "Imported"); checks.push("export/import");
  await js("window.f95App.openLogin().then(reloadState)");
  assert.equal(await js("state.auth.loggedIn"), true);
  await js("window.f95App.logout().then(reloadState)");
  assert.equal(await js("state.auth.loggedIn"), false); checks.push("login/logout fixture");
  await js(`window.f95App.startDownload({ gameId: ${game.id}, url: 'https://pixeldrain.com/fixture.zip', label: 'Pixeldrain', detectedVersion: '1.0' })`);
  await service.archiveQueue.waitIdle();
  await js("reloadState()");
  const folder = service.db.listGameFolders(game.id)[0];
  assert.ok(folder);
  await js(`window.f95App.launchExecutable({ folderId: ${folder.id} })`);
  assert.equal(launches.length, 1); checks.push("download/extraction/launch fixture");
  await js(`state.selectedGameId = ${game.id}; state.openOverlay = 'game-details'; render()`);
  await fs.writeFile(path.join(cache, "ui-smoke.png"), (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(errors.filter((message) => !message.includes("Content-Security-Policy")), []);
  await service.dispose(); checks.push("shutdown");
  await fs.writeFile(path.join(cache, "ui-smoke.json"), JSON.stringify({ passed: true, checks, errors }, null, 2));
  await fs.rm(root, { recursive: true, force: true });
  window.destroy(); app.exit(0);
}).catch(async (error) => {
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, "ui-smoke.json"), JSON.stringify({ passed: false, checks, error: error.stack || String(error), errors }, null, 2));
  await service?.dispose().catch(() => {});
  window?.destroy(); app.exit(1);
});
