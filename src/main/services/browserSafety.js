function isSafeBrowserUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}

function assertTrustedIpcSender(event, mainWindow) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents ||
      !event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("IPC request denied: untrusted sender.");
  }
}

module.exports = { isSafeBrowserUrl, assertTrustedIpcSender };
