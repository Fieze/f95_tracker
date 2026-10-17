const { BrowserWindow } = require("electron");
const { CloudflareChallengeError } = require("./services/threadFetcher");

const CHALLENGE_TITLE = /just a moment|nur einen moment|un instant|un momento|attention required|checking your browser/i;
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const POLL_INTERVAL_MS = 500;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Loads F95Zone pages the way the login window does: a real navigation in the shared browser profile.
// Cloudflare accepts that (the user already passes its check there) but challenges plain background requests,
// so thread pages are read from a hidden window instead of through fetch.
function createBrowserPageLoader({ partition, session, logger, autoSolveMs = 20000, userSolveMs = 180000, loadTimeoutMs = 60000 }) {
  let win = null;
  let lastStatus = 200;

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 800,
      title: "F95Zone browser check",
      autoHideMenuBar: true,
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    const contentsId = win.webContents.id;
    // Thread pages need no pictures; skip them for this window only (the login window shares the session).
    session.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
      callback({ cancel: details.webContentsId === contentsId && BLOCKED_RESOURCE_TYPES.has(details.resourceType) });
    });
    win.webContents.on("did-navigate", (_event, _url, httpResponseCode) => { if (httpResponseCode) lastStatus = httpResponseCode; });
    win.on("closed", () => { win = null; });
    return win;
  }

  const isChallenge = (current) => CHALLENGE_TITLE.test(current.webContents.getTitle());

  async function waitUntilCleared(current, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (isChallenge(current) && Date.now() < deadline) {
      if (current.isDestroyed()) return false;
      await delay(POLL_INTERVAL_MS);
    }
    return !current.isDestroyed() && !isChallenge(current);
  }

  async function load(url, { interactive = false } = {}) {
    const current = ensureWindow();
    lastStatus = 200;
    await Promise.race([
      current.loadURL(url).catch((error) => {
        // Redirects and the challenge's own reload abort the first navigation; that is not a failure.
        if (error?.code !== "ERR_ABORTED") throw error;
      }),
      delay(loadTimeoutMs).then(() => { throw new Error("Loading the F95Zone page timed out."); })
    ]);

    if (isChallenge(current) && !(await waitUntilCleared(current, autoSolveMs))) {
      if (!interactive || current.isDestroyed()) throw new CloudflareChallengeError();
      await logger?.info("F95Zone browser check needs the user; showing the check window.");
      current.show();
      current.focus();
      const solved = await waitUntilCleared(current, userSolveMs);
      if (!current.isDestroyed()) current.hide();
      if (!solved) throw new CloudflareChallengeError();
    }

    // After a challenge the real page loads in a follow-up navigation; wait for it to settle.
    for (let waited = 0; current.webContents.isLoading() && waited < 15000; waited += POLL_INTERVAL_MS) await delay(POLL_INTERVAL_MS);

    if (lastStatus >= 400) throw new Error(`Thread request failed with status ${lastStatus}`);
    const html = await current.webContents.executeJavaScript("document.documentElement.outerHTML");
    return { url: current.webContents.getURL() || url, status: lastStatus, html: `<!DOCTYPE html>\n${html}` };
  }

  function dispose() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  return { load, dispose };
}

module.exports = { createBrowserPageLoader, CHALLENGE_TITLE };
