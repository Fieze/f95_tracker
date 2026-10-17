const { app, Tray, Menu, Notification } = require("electron");
const { ctx, appIconPath } = require("./context");

function restoreMainWindow() {
  if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) {
    return;
  }

  if (ctx.mainWindow.isMinimized()) {
    ctx.mainWindow.restore();
  }

  ctx.mainWindow.setSkipTaskbar(false);
  ctx.mainWindow.show();
  ctx.mainWindow.focus();
}

async function hideMainWindowToTray() {
  if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) {
    return;
  }

  await ctx.logger?.info("Hiding main window to tray.");
  ctx.mainWindow.setSkipTaskbar(true);
  ctx.mainWindow.hide();
}

function createTray() {
  if (ctx.tray) {
    return ctx.tray;
  }

  ctx.tray = new Tray(appIconPath);
  ctx.tray.setToolTip("F95 Tracker");
  ctx.tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open",
        click: () => {
          restoreMainWindow();
        }
      },
      { type: "separator" },
      {
        label: "Quit",
        click: async () => {
          ctx.isQuitting = true;
          await ctx.logger?.info("Quit requested from ctx.tray.");
          app.quit();
        }
      }
    ])
  );
  ctx.tray.on("click", () => {
    restoreMainWindow();
  });
  return ctx.tray;
}

function buildUpdateNotificationBody(payload) {
  const title = payload?.title || "A tracked game";
  const currentVersion = payload?.currentVersion ? `v${payload.currentVersion}` : "a new version";
  const installedVersion = payload?.installedVersion ? `Installed: v${payload.installedVersion}` : "Not installed yet";
  return `${title}: ${currentVersion} is available. ${installedVersion}`;
}

function showGameUpdateNotification(payload) {
  if (!Notification.isSupported()) {
    ctx.logger?.warn("System notifications are not supported on this platform.");
    return;
  }

  const notification = new Notification({
    title: "Update available",
    body: buildUpdateNotificationBody(payload),
    icon: appIconPath,
    silent: false
  });

  notification.on("click", () => {
    restoreMainWindow();
  });
  notification.show();
}

module.exports = { restoreMainWindow, hideMainWindowToTray, createTray, showGameUpdateNotification };
