const fs = require("fs");
const path = require("path");
const { app } = require("electron");

// Shared mutable state of the main process. Modules read and write these fields instead of module-level lets.
const ctx = {
  mainWindow: null,
  loginWindow: null,
  downloadWindow: null,
  downloadWindowState: null,
  appService: null,
  logger: null,
  downloadLogger: null,
  extractionLogger: null,
  parsingLogger: null,
  tray: null,
  pageLoader: null,
  extensionBridge: null,
  isQuitting: false
};

const AUTH_PARTITION = "persist:f95-auth";
const DOWNLOAD_PARTITION = "persist:f95-downloads";
const APP_USER_MODEL_ID = "com.f95tracker.app";
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico")
  : path.join(__dirname, "..", "..", "resources", "icon.ico");
const appRootPath = app.isPackaged
  ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)
  : path.join(__dirname, "..", "..");

// Prefer a logs folder next to the app; fall back to userData when that location is read-only.
function resolveLogDirectory() {
  const preferred = path.join(appRootPath, "logs");
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    return path.join(app.getPath("userData"), "logs");
  }
}

const logDirectoryPath = resolveLogDirectory();

module.exports = {
  ctx,
  AUTH_PARTITION,
  DOWNLOAD_PARTITION,
  APP_USER_MODEL_ID,
  appIconPath,
  logDirectoryPath,
  logFilePath: path.join(logDirectoryPath, "main.log"),
  downloadLogFilePath: path.join(logDirectoryPath, "download.log"),
  extractionLogFilePath: path.join(logDirectoryPath, "extraction.log"),
  parsingLogFilePath: path.join(logDirectoryPath, "parsing.log")
};
