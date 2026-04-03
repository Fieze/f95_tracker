const { normalizeThreadUrl } = require("./utils");

class ThreadFetcher {
  constructor(authSession) {
    this.authSession = authSession;
  }

  async buildCookieHeader(normalizedUrl) {
    const cookies = await this.authSession.cookies.get({ url: normalizedUrl });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  async fetchUrl(url) {
    const normalizedUrl = /^https?:/i.test(url) ? url : normalizeThreadUrl(url);
    const headers = {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36"
    };

    const cookieHeader = await this.buildCookieHeader(normalizedUrl);
    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }

    const response = await fetch(normalizedUrl, {
      headers,
      redirect: "follow"
    });

    if (!response.ok) {
      throw new Error(`Thread request failed with status ${response.status}`);
    }

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

    const headers = {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36"
    };

    const cookieHeader = await this.buildCookieHeader(normalizedUrl);
    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }

    const response = await fetch(normalizedUrl, {
      headers,
      redirect: "follow"
    });

    if (!response.ok) {
      throw new Error(`Asset request failed with status ${response.status}`);
    }

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
  ThreadFetcher
};
