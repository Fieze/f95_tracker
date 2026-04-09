const { contextBridge, ipcRenderer } = require("electron");

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
  setInstalledVersion: (payload) => ipcRenderer.invoke("games:setInstalledVersion", payload),
  listGameFolders: (gameId) => ipcRenderer.invoke("games:listFolders", { gameId }),
  updateGameFolderVersion: (payload) => ipcRenderer.invoke("games:updateFolderVersion", payload),
  deleteGameFolder: (payload) => ipcRenderer.invoke("games:deleteFolder", payload),
  refreshGameFolders: (gameId) => ipcRenderer.invoke("games:refreshFolders", { gameId }),
  listLaunchExecutables: (payload) => ipcRenderer.invoke("games:listLaunchExecutables", payload),
  launchExecutable: (payload) => ipcRenderer.invoke("games:launchExecutable", payload),
  inferInstalledVersion: (folderPath) => ipcRenderer.invoke("games:inferInstalledVersion", { folderPath }),
  validateInstallPath: (gameId) => ipcRenderer.invoke("games:validateInstallPath", { gameId }),
  moveInstallPath: (gameId) => ipcRenderer.invoke("games:moveInstallPath", { gameId }),
  refreshAllGames: () => ipcRenderer.invoke("games:refreshAll"),
  resolveArchiveMatch: (payload) => ipcRenderer.invoke("jobs:decision", payload),
  openLink: (url) => ipcRenderer.invoke("links:open", url),
  onStateChanged: (handler) => ipcRenderer.on("state:changed", handler)
});
