const { normalizeThreadUrl } = require("./utils");

const FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36";

const DEFAULT_MIN_INTERVAL_MS = 1500;
const DEFAULT_JITTER_MS = 500;
const DEFAULT_CHALLENGE_COOLDOWN_MS = 10 * 60 * 1000;

class CloudflareChallengeError extends Error {
  constructor(paused = false) {
    super(
      paused
        ? "F95Zone asked for a browser check and requests are paused to avoid making it worse. Open the login window, complete the check there, then try again."
        : "F95Zone is asking for a browser check. Open the login window once, complete the check there, then try again."
    );
    this.name = "CloudflareChallengeError";
    this.challenge = true;
  }
}

function isChallengeResponse(response, body = "") {
  if (response.headers?.get?.("cf-mitigated") === "challenge") return true;
  return [403, 429, 503].includes(response.status) && /just a moment|cf-chl|challenge-platform/i.test(body);
}

// Requests go through the Electron session when available: that is the same Chromium network stack, user agent
// and cookie jar (including Cloudflare clearance) as the login window. Plain fetch with copied cookies remains as
// a fallback for tests and non-Electron use.
//
// Requests are paced (a burst of page loads is what triggers Cloudflare in the first place) and, once a
// challenge shows up, paused for a cooldown instead of hammering the site with the remaining requests.
class ThreadFetcher {
  constructor(authSession, {
    // Pacing matters for the real site; without an Electron session (tests, scripts) it defaults to off.
    minIntervalMs = typeof authSession?.fetch === "function" ? DEFAULT_MIN_INTERVAL_MS : 0,
    jitterMs = typeof authSession?.fetch === "function" ? DEFAULT_JITTER_MS : 0,
    cooldownMs = DEFAULT_CHALLENGE_COOLDOWN_MS,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}) {
    this.authSession = authSession;
    this.controller = new AbortController();
    Object.assign(this, { minIntervalMs, jitterMs, cooldownMs, now, sleep });
    this.queue = Promise.resolve();
    this.nextRequestAt = 0;
    this.blockedUntil = 0;
  }

  abort() { this.controller.abort(); }

  // Called once the user has completed the browser check (login window closed).
  resetChallenge() {
    this.blockedUntil = 0;
    this.nextRequestAt = 0;
  }

  isPaused() { return this.now() < this.blockedUntil; }

  // Serialises requests and keeps at least minIntervalMs (plus jitter) between their starts.
  schedule(task) {
    const run = async () => {
      if (this.isPaused()) throw new CloudflareChallengeError(true);
      const wait = this.nextRequestAt - this.now();
      if (wait > 0) await this.sleep(wait);
      if (this.isPaused()) throw new CloudflareChallengeError(true);
      this.nextRequestAt = this.now() + this.minIntervalMs + Math.random() * this.jitterMs;
      return task();
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async buildCookieHeader(normalizedUrl) {
    const cookies = await this.authSession.cookies.get({ url: normalizedUrl });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  request(url) {
    return this.schedule(() => this.performRequest(url));
  }

  async performRequest(url) {
    const init = {
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(60000)]),
      redirect: "follow"
    };
    if (typeof this.authSession.fetch === "function") {
      return this.authSession.fetch(url, { ...init, credentials: "include" });
    }
    const headers = { "user-agent": FALLBACK_USER_AGENT };
    const cookieHeader = await this.buildCookieHeader(url);
    if (cookieHeader) headers.cookie = cookieHeader;
    return fetch(url, { ...init, headers });
  }

  async assertOk(response, label) {
    if (response.ok) return;
    const body = [403, 429, 503].includes(response.status) ? await response.text().catch(() => "") : "";
    if (isChallengeResponse(response, body)) {
      this.blockedUntil = this.now() + this.cooldownMs;
      throw new CloudflareChallengeError();
    }
    throw new Error(`${label} request failed with status ${response.status}`);
  }

  async fetchUrl(url) {
    const normalizedUrl = /^https?:/i.test(url) ? url : normalizeThreadUrl(url);
    const response = await this.request(normalizedUrl);
    await this.assertOk(response, "Thread");

    const html = await response.text();
    return {
      url: response.url || normalizedUrl,
      requestedUrl: normalizedUrl,
      status: response.status,
      html
    };
  }

  async fetchThread(url) {
    return this.fetchUrl(normalizeThreadUrl(url));
  }

  async fetchBinary(url) {
    const normalizedUrl = String(url || "").trim();
    if (!/^https?:/i.test(normalizedUrl)) {
      throw new Error("Binary fetch requires an absolute URL.");
    }

    const response = await this.request(normalizedUrl);
    await this.assertOk(response, "Asset");

    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      url: response.url || normalizedUrl,
      requestedUrl: normalizedUrl,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      buffer
    };
  }
}

module.exports = {
  CloudflareChallengeError,
  ThreadFetcher
};
