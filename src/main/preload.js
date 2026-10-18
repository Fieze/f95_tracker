const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Files dragged in from Explorer: the real paths are only available here, so the drop is handled in the preload
// and only the list of paths is handed to the page.
const dropHandlers = [];
const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragover", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
window.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  const paths = [...event.dataTransfer.files].map((file) => webUtils.getPathForFile(file)).filter(Boolean);
  if (paths.length) dropHandlers.forEach((handler) => handler(paths));
});

contextBridge.exposeInMainWorld("f95App", {
  bootstrap: () => ipcRenderer.invoke("app:bootstrap"),
  updateSettings: (payload) => ipcRenderer.invoke("settings:update", payload),
  exportData: () => ipcRenderer.invoke("data:export"),
  importData: () => ipcRenderer.invoke("data:import"),
  selectFolder: (payload) => ipcRenderer.invoke("folders:select", payload),
  openLogin: () => ipcRenderer.invoke("auth:openLogin"),
  logout: () => ipcRenderer.invoke("auth:logout"),
  verifyAuth: () => ipcRenderer.invoke("auth:verify"),
  addThread: (url) => ipcRenderer.invoke("games:addThread", { url }),
  deleteGame: (gameId) => ipcRenderer.invoke("games:delete", gameId),
  refreshGame: (gameId) => ipcRenderer.invoke("games:refresh", gameId),
  updateGameSeasons: (payload) => ipcRenderer.invoke("games:updateSeasons", payload),
  setInstalledVersion: (payload) => ipcRenderer.invoke("games:setInstalledVersion", payload),
  listGameFolders: (gameId) => ipcRenderer.invoke("games:listFolders", { gameId }),
  updateGameFolderVersion: (payload) => ipcRenderer.invoke("games:updateFolderVersion", payload),
  updateGameFolderMetadata: (payload) => ipcRenderer.invoke("games:updateFolderMetadata", payload),
  deleteGameFolder: (payload) => ipcRenderer.invoke("games:deleteFolder", payload),
  refreshGameFolders: (gameId) => ipcRenderer.invoke("games:refreshFolders", { gameId }),
  listLaunchExecutables: (payload) => ipcRenderer.invoke("games:listLaunchExecutables", payload),
  launchExecutable: (payload) => ipcRenderer.invoke("games:launchExecutable", payload),
  inferInstalledVersion: (folderPath) => ipcRenderer.invoke("games:inferInstalledVersion", { folderPath }),
  validateInstallPath: (gameId) => ipcRenderer.invoke("games:validateInstallPath", { gameId }),
  moveInstallPath: (gameId) => ipcRenderer.invoke("games:moveInstallPath", { gameId }),
  refreshAllGames: () => ipcRenderer.invoke("games:refreshAll"),
  resolveArchiveMatch: (payload) => ipcRenderer.invoke("jobs:decision", payload),
  setArchivePassword: (jobId, password) => ipcRenderer.invoke("jobs:password", { jobId, password }),
  deleteArchiveFile: (jobId) => ipcRenderer.invoke("jobs:deleteFile", { jobId }),
  startDownload: (payload) => ipcRenderer.invoke("downloads:start", payload),
  cancelDownload: (jobId) => ipcRenderer.invoke("downloads:cancel", { jobId }),
  addExistingFolder: (payload) => ipcRenderer.invoke("folders:addExisting", payload),
  inspectDroppedPaths: (paths) => ipcRenderer.invoke("drop:inspect", { paths }),
  addDroppedArchive: (payload) => ipcRenderer.invoke("drop:addArchive", payload),
  onFilesDropped: (handler) => { dropHandlers.push(handler); },
  dismissActivity: (activityId) => ipcRenderer.invoke("activities:dismiss", activityId),
  openLink: (url) => ipcRenderer.invoke("links:open", url),
  onStateChanged: (handler) => ipcRenderer.on("state:changed", handler)
});
