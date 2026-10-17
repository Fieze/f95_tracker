const { app, Notification } = require("electron");
const { ctx, appIconPath } = require("./context");

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let timer = null;

// electron-updater expects a console-like logger; forward to the app logger without ever throwing.
function createUpdaterLogger() {
  const forward = (level) => (message) => {
    Promise.resolve(ctx.logger?.[level]?.(`Updater: ${typeof message === "string" ? message : message?.message || String(message)}`)).catch(() => {});
  };
  return { info: forward("info"), warn: forward("warn"), error: forward("error"), debug() {} };
}

// Only installed (NSIS) builds can update themselves: skip dev runs and the portable build.
function canAutoUpdate() {
  return app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, icon: appIconPath }).show();
}

function startAutoUpdate() {
  if (!canAutoUpdate() || timer) return null;
  const { autoUpdater } = require("electron-updater");
  autoUpdater.logger = createUpdaterLogger();
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => {
    notify("Update ready", `Version ${info.version} will be installed when you quit the app.`);
  });
  const check = () => autoUpdater.checkForUpdates().catch((error) => ctx.logger?.warn("Update check failed.", { message: error.message }));
  void check();
  timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  timer.unref?.();
  return autoUpdater;
}

function stopAutoUpdate() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startAutoUpdate, stopAutoUpdate, canAutoUpdate };
