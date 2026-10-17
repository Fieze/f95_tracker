const { normalizeThreadUrl } = require("./utils");

const FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36";

class CloudflareChallengeError extends Error {
  constructor() {
    super("F95Zone is asking for a browser check. Open the login window once, complete the check there, then try again.");
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
class ThreadFetcher {
  constructor(authSession) {
    this.authSession = authSession;
    this.controller = new AbortController();
  }

  abort() { this.controller.abort(); }

  async buildCookieHeader(normalizedUrl) {
    const cookies = await this.authSession.cookies.get({ url: normalizedUrl });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  async request(url) {
    const init = {
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(60000)]),
      redirect: "follow"
    };
    if (typeof this.authSession.fetch === "function") {
      return this.authSession.fetch(url, init);
    }
    const headers = { "user-agent": FALLBACK_USER_AGENT };
    const cookieHeader = await this.buildCookieHeader(url);
    if (cookieHeader) headers.cookie = cookieHeader;
    return fetch(url, { ...init, headers });
  }

  async assertOk(response, label) {
    if (response.ok) return;
    const body = [403, 429, 503].includes(response.status) ? await response.text().catch(() => "") : "";
    if (isChallengeResponse(response, body)) throw new CloudflareChallengeError();
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
