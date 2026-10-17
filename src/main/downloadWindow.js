const path = require("path");
const { BrowserWindow, session } = require("electron");
const { isSafeBrowserUrl } = require("./services/browserSafety");
const { ctx, DOWNLOAD_PARTITION, appIconPath } = require("./context");

function isSupportedDirectDownload(candidateUrl, label = "") {
  const normalizedLabel = String(label || "").toLowerCase();
  if (
    normalizedLabel.includes("pixeldrain") ||
    normalizedLabel.includes("vikingfile") ||
    normalizedLabel.includes("vik1ngfile")
  ) {
    return true;
  }

  try {
    const host = new URL(String(candidateUrl || "").trim()).host.toLowerCase();
    return (
      host === "vik1ngfile.site" ||
      host === "vikingfile.com" ||
      host === "pixeldrain.com" ||
      host === "www.pixeldrain.com"
    );
  } catch {
    return false;
  }
}

function getDownloadSession() {
  return session.fromPartition(DOWNLOAD_PARTITION);
}

function buildDownloadWindowTitle(payload) {
  const label = String(payload?.label || "").trim();
  return label ? `Download - ${label}` : "Download";
}

function closeDownloadWindow() {
  if (!ctx.downloadWindow || ctx.downloadWindow.isDestroyed()) {
    ctx.downloadWindow = null;
    ctx.downloadWindowState = null;
    return;
  }

  if (ctx.downloadWindowState) {
    ctx.downloadWindowState.closing = true;
  }

  ctx.downloadWindow.close();
}

async function buildCookieHeaderForUrl(targetUrl) {
  const downloadCookies = await getDownloadSession().cookies.get({ url: targetUrl });
  const authCookies = ctx.appService?.authSession
    ? await ctx.appService.authSession.cookies.get({ url: targetUrl }).catch(() => [])
    : [];
  const cookieMap = new Map();

  [...downloadCookies, ...authCookies].forEach((cookie) => {
    if (cookie?.name) {
      cookieMap.set(cookie.name, cookie.value);
    }
  });

  return [...cookieMap.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function syncAuthCookiesToDownloadSession(targetUrl) {
  if (!ctx.appService?.authSession || !isSafeBrowserUrl(targetUrl)) {
    return;
  }

  const authCookies = await ctx.appService.authSession.cookies.get({ url: targetUrl }).catch(() => []);
  if (authCookies.length === 0) {
    return;
  }

  const downloadSession = getDownloadSession();
  await Promise.all(
    authCookies.map(async (cookie) => {
      const cookieUrl = `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`;
      const payload = {
        url: cookieUrl,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite
      };

      if (cookie.expirationDate) {
        payload.expirationDate = cookie.expirationDate;
      }

      try {
        await downloadSession.cookies.set(payload);
      } catch (error) {
        ctx.downloadLogger?.warn("Failed to mirror auth cookie into download session.", {
          targetUrl,
          cookieName: cookie.name,
          message: error.message
        });
      }
    })
  );
}

async function takeOverResolvedDownload(jobId, payload = {}) {
  const job = ctx.appService.getDownloadJob(jobId);
  if (!job) {
    return null;
  }

  if (["resolving", "downloading", "completed"].includes(job.status)) {
    return job;
  }

  const resolvedUrl = String(payload.url || "").trim();
  if (!resolvedUrl) {
    throw new Error("No resolved download url was provided.");
  }

  await syncAuthCookiesToDownloadSession(resolvedUrl);
  const cookieHeader = payload.cookieHeader ?? (await buildCookieHeaderForUrl(resolvedUrl));
  const referrer =
    payload.referrer ||
    (ctx.downloadWindow && !ctx.downloadWindow.isDestroyed() ? ctx.downloadWindow.webContents.getURL() : job.sourceUrl);

  closeDownloadWindow();
  return ctx.appService.startResolvedDownload(jobId, {
    url: resolvedUrl,
    fileName: payload.fileName || "",
    referrer,
    cookieHeader
  });
}

function maybeTakeOverDownloadUrl(jobId, candidateUrl, extra = {}) {
  if (!ctx.appService.isProbableFileDownloadUrl(candidateUrl)) {
    return false;
  }

  void takeOverResolvedDownload(jobId, {
    url: candidateUrl,
    referrer: extra.referrer || candidateUrl,
    fileName: extra.fileName || ""
  }).catch((error) => {
    ctx.downloadLogger?.error("Failed to take over resolved download url.", {
      jobId,
      candidateUrl,
      message: error.message
    });
  });

  return true;
}

function attachDownloadSessionListeners() {
  const downloadSession = getDownloadSession();
  if (downloadSession.__f95DownloadListenersAttached) {
    return;
  }

  downloadSession.__f95DownloadListenersAttached = true;
  downloadSession.on("will-download", (event, item, webContents) => {
    const state = ctx.downloadWindowState;
    if (!state || webContents.id !== state.webContentsId) {
      return;
    }

    event.preventDefault();
    item.cancel();
    state.downloadStarted = true;

    void takeOverResolvedDownload(state.jobId, {
      url: item.getURL(),
      fileName: item.getFilename(),
      referrer: webContents.getURL()
    }).catch((error) => {
      ctx.downloadLogger?.error("Failed to take over browser-triggered download.", {
        jobId: state.jobId,
        url: item.getURL(),
        message: error.message
      });
    });
  });
}

async function createDownloadWindow(payload) {
  const targetUrl = String(payload?.url || "").trim();
  if (!isSupportedDirectDownload(targetUrl, payload?.label || "")) {
    throw new Error("Direct in-app downloads are currently only supported for Vikingfile and Pixeldrain links.");
  }

  await ctx.appService.ensureDownloadReady();

  if (ctx.downloadWindow && !ctx.downloadWindow.isDestroyed()) {
    if (ctx.downloadWindowState?.jobId) {
      ctx.appService.cancelDownloadJob(ctx.downloadWindowState.jobId, "Canceled because another download window was opened.");
    }
    closeDownloadWindow();
  }

  const job = ctx.appService.createDownloadJob(payload);
  await syncAuthCookiesToDownloadSession(targetUrl);

  await ctx.downloadLogger?.info("Creating download window.", {
    jobId: job.id,
    sourceUrl: targetUrl,
    host: job.host
  });

  ctx.downloadWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    parent: ctx.mainWindow || undefined,
    modal: true,
    autoHideMenuBar: true,
    icon: appIconPath,
    backgroundColor: "#16211e",
    title: buildDownloadWindowTitle(payload),
    webPreferences: {
      partition: DOWNLOAD_PARTITION,
      preload: path.join(__dirname, "downloadPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  ctx.downloadWindowState = {
    jobId: job.id,
    webContentsId: ctx.downloadWindow.webContents.id,
    closing: false,
    downloadStarted: false
  };

  ctx.downloadWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (maybeTakeOverDownloadUrl(job.id, url, { referrer: ctx.downloadWindow.webContents.getURL() })) {
      return { action: "deny" };
    }

    if (!isSafeBrowserUrl(url)) {
      ctx.downloadLogger?.warn("Blocked non-http download window target.", {
        jobId: job.id,
        url
      });
      return { action: "deny" };
    }

    void syncAuthCookiesToDownloadSession(url)
      .then(() => ctx.downloadWindow.loadURL(url))
      .catch((error) => {
        ctx.downloadLogger?.warn("Download window navigation failed.", {
          jobId: job.id,
          url,
          message: error.message
        });
      });
    return { action: "deny" };
  });

  const handlePotentialDownloadNavigation = (candidateUrl) => {
    if (!isSafeBrowserUrl(candidateUrl)) {
      return false;
    }

    maybeTakeOverDownloadUrl(job.id, candidateUrl, {
      referrer: ctx.downloadWindow && !ctx.downloadWindow.isDestroyed() ? ctx.downloadWindow.webContents.getURL() : targetUrl
    });
    return true;
  };

  ctx.downloadWindow.webContents.on("did-finish-load", () => {
    ctx.appService.markDownloadAwaiting(job.id);
  });
  ctx.downloadWindow.webContents.on("will-navigate", (event, candidateUrl) => {
    if (!isSafeBrowserUrl(candidateUrl)) {
      event.preventDefault();
      ctx.downloadLogger?.warn("Blocked non-http navigation inside download window.", {
        jobId: job.id,
        url: candidateUrl
      });
      return;
    }

    if (maybeTakeOverDownloadUrl(job.id, candidateUrl, { referrer: ctx.downloadWindow.webContents.getURL() })) {
      event.preventDefault();
    }
  });
  ctx.downloadWindow.webContents.on("did-redirect-navigation", (_event, candidateUrl) => {
    handlePotentialDownloadNavigation(candidateUrl);
  });
  ctx.downloadWindow.webContents.on("did-navigate", (_event, candidateUrl) => {
    handlePotentialDownloadNavigation(candidateUrl);
  });

  ctx.downloadWindow.on("closed", () => {
    const state = ctx.downloadWindowState;
    ctx.downloadWindow = null;
    ctx.downloadWindowState = null;

    if (state && !state.closing && !state.downloadStarted) {
      ctx.appService.cancelDownloadJob(state.jobId);
    }
  });

  try {
    await syncAuthCookiesToDownloadSession(targetUrl);
    await ctx.downloadWindow.loadURL(targetUrl);
    return job;
  } catch (error) {
    ctx.appService.failDownloadJob(job.id, error);
    closeDownloadWindow();
    throw error;
  }
}

module.exports = { attachDownloadSessionListeners, createDownloadWindow, closeDownloadWindow };
