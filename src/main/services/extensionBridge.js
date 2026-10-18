const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { noopLogger } = require("./logger");
const { normalizeThreadUrl, extractThreadId } = require("./utils");

const DEFAULT_PORT = 47950;
const PORT_COUNT = 10;
const PAIR_COOLDOWN_MS = 30000;
const MAX_BODY_BYTES = 4096;
const TOKEN_FILE = "extension-token.txt";

// Local HTTP bridge for the browser extension. It only listens on the loopback interface. The extension gets the
// token by asking to pair, which the user confirms in the app; after that every request needs the token (a custom
// header, so ordinary web pages cannot send it without a CORS preflight that we refuse).
// The Host header must be a loopback name (blocks DNS rebinding) and the Origin, if any, must be an extension.
class ExtensionBridge {
  constructor({ appService, userDataPath, port = DEFAULT_PORT, logger, confirmPair }) {
    this.confirmPair = confirmPair || (async () => false);
    this.pairing = false;
    this.pairDeniedAt = 0;
    this.appService = appService;
    this.tokenPath = path.join(userDataPath, TOKEN_FILE);
    this.port = port;
    this.logger = logger || noopLogger;
    this.token = "";
    this.server = null;
  }

  async start() {
    this.token = await this.loadOrCreateToken();
    // The extension probes this port range, so a taken port just moves the bridge to the next one.
    const ports = this.port === 0 ? [0] : Array.from({ length: PORT_COUNT }, (_, index) => this.port + index);
    for (const port of ports) {
      const server = this.createServer();
      if (await this.listen(server, port)) { this.server = server; break; }
    }
    if (this.server) await this.logger.info("Extension bridge listening.", { port: this.port });
    else this.logger.warn("Extension bridge could not start.", { ports });
  }

  createServer() {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.logger.error("Extension request failed.", { message: error.message });
        this.send(req, res, 500, { ok: false, error: "Internal error." });
      });
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    return server;
  }

  listen(server, port) {
    return new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.removeAllListeners("error");
        this.port = server.address().port;
        resolve(true);
      });
    });
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  get running() { return Boolean(this.server); }

  async loadOrCreateToken() {
    const existing = (await fs.readFile(this.tokenPath, "utf8").catch(() => "")).trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
    const token = crypto.randomBytes(32).toString("hex");
    await fs.writeFile(this.tokenPath, token, { mode: 0o600 });
    return token;
  }

  isLoopbackHost(host) {
    return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(host || ""));
  }

  isExtensionOrigin(origin) {
    return /^(moz-extension|chrome-extension):\/\/[a-z0-9-]+$/i.test(origin);
  }

  authorized(req) {
    const given = Buffer.from(String(req.headers["x-f95-token"] || ""));
    const expected = Buffer.from(this.token);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  send(req, res, status, body) {
    const origin = req.headers.origin;
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
    if (origin && this.isExtensionOrigin(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Headers"] = "Content-Type, X-F95-Token";
      headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      headers.Vary = "Origin";
    }
    res.writeHead(status, headers);
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { reject(new Error("Request too large.")); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
        catch { reject(new Error("Invalid JSON.")); }
      });
      req.on("error", reject);
    });
  }

  findTrackedGame(threadUrl) {
    const threadId = extractThreadId(threadUrl);
    return this.appService.db.getGames().find((game) => String(game.threadId) === threadId) || null;
  }

  async handle(req, res) {
    const origin = req.headers.origin;
    if (!this.isLoopbackHost(req.headers.host) || (origin && !this.isExtensionOrigin(origin))) {
      return this.send(req, res, 403, { ok: false, error: "Forbidden." });
    }
    if (req.method === "OPTIONS") return this.send(req, res, 204);
    if (req.method === "POST" && req.url === "/v1/pair") return this.pair(req, res);
    if (!this.authorized(req)) return this.send(req, res, 401, { ok: false, error: "Invalid token." });

    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/status") return this.status(req, res, url);
    if (req.method === "POST" && url.pathname === "/v1/games") return this.add(req, res);
    return this.send(req, res, 404, { ok: false, error: "Not found." });
  }

  // First contact: the user approves the extension in the app, then it receives the token.
  async pair(req, res) {
    if (!req.headers.origin) return this.send(req, res, 403, { ok: false, error: "Forbidden." });
    if (this.pairing) return this.send(req, res, 429, { ok: false, code: "busy" });
    if (Date.now() - this.pairDeniedAt < PAIR_COOLDOWN_MS) return this.send(req, res, 403, { ok: false, code: "denied" });
    this.pairing = true;
    try {
      if (await this.confirmPair()) return this.send(req, res, 200, { ok: true, token: this.token });
      this.pairDeniedAt = Date.now();
      return this.send(req, res, 403, { ok: false, code: "denied" });
    } finally {
      this.pairing = false;
    }
  }

  status(req, res, url) {
    const body = { ok: true, tracked: false, game: null };
    const threadParam = url.searchParams.get("url");
    if (threadParam) {
      let threadUrl;
      try { threadUrl = normalizeThreadUrl(threadParam); }
      catch (error) { return this.send(req, res, 400, { ok: false, error: error.message }); }
      const game = this.findTrackedGame(threadUrl);
      body.tracked = Boolean(game);
      body.game = game && { id: game.id, title: game.title, currentVersion: game.currentVersion };
      body.pending = this.appService.pendingThreadUrls.has(threadUrl);
    }
    return this.send(req, res, 200, body);
  }

  async add(req, res) {
    let threadUrl;
    try {
      const payload = await this.readBody(req);
      threadUrl = normalizeThreadUrl(payload.url);
    } catch (error) {
      return this.send(req, res, 400, { ok: false, error: error.message });
    }
    if (this.findTrackedGame(threadUrl)) return this.send(req, res, 200, { ok: true, queued: false, tracked: true });
    const result = this.appService.addThreadInBackground(threadUrl);
    return this.send(req, res, 202, { ok: true, queued: result.queued, duplicate: Boolean(result.duplicate) });
  }
}

module.exports = { ExtensionBridge, DEFAULT_PORT };
