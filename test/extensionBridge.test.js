const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const http = require("http");
const { AppService } = require("../src/main/services/appService");
const { ExtensionBridge } = require("../src/main/services/extensionBridge");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f95-bridge-"));
  const app = new AppService({ userDataPath: root, authSession: { cookies: { get: async () => [] } },
    folderWatcher: { start: async () => {}, stop: async () => {}, ignoreFile: () => {} } });
  await app.db.initialize();
  await app.db.upsertGameFromThread({ sourceUrl: "https://f95zone.to/threads/tracked-game.4242/",
    title: "Tracked Game", threadTitle: "Tracked Game", currentVersion: "1.0", tags: [], aliases: [],
    developer: "", engine: "", threadStatus: "", overview: "", releaseDate: "", changelog: "",
    bannerImage: null, rawOpHtml: "", rawOpText: "", warnings: [], screenshotImages: [], downloadGroups: [], parserDebug: {} });
  const added = [];
  const confirm = { answer: true };
  app.addThreadInBackground = (url) => { added.push(url); return { queued: true }; };
  const bridge = new ExtensionBridge({ appService: app, userDataPath: root, port: 0, confirmPair: async () => confirm.answer });
  await bridge.start();
  t.after(async () => { await bridge.stop(); await app.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { bridge, added, confirm };
}

function request(bridge, { method = "GET", path: urlPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: bridge.port, method, path: urlPath, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("extension bridge reports tracked state and adds untracked threads", async (t) => {
  const { bridge, added } = await fixture(t);
  const auth = { "X-F95-Token": bridge.token };
  const status = (url) => request(bridge, { path: `/v1/status?url=${encodeURIComponent(url)}`, headers: auth });

  const tracked = await status("https://f95zone.to/threads/tracked-game.4242/page-3");
  assert.equal(tracked.json.tracked, true);
  assert.equal(tracked.json.game.title, "Tracked Game");
  assert.equal((await status("https://f95zone.to/threads/other.9/")).json.tracked, false);
  assert.equal((await status("https://example.com/threads/x.1/")).status, 400);

  const add = await request(bridge, { method: "POST", path: "/v1/games", headers: auth, body: JSON.stringify({ url: "https://f95zone.to/threads/other.9/post-1" }) });
  assert.equal(add.status, 202);
  assert.deepEqual(added, ["https://f95zone.to/threads/other.9/"]);

  const again = await request(bridge, { method: "POST", path: "/v1/games", headers: auth, body: JSON.stringify({ url: "https://f95zone.to/threads/tracked-game.4242/" }) });
  assert.equal(again.json.tracked, true);
  assert.equal(added.length, 1);
});

test("extension bridge rejects missing tokens, web origins and foreign hosts", async (t) => {
  const { bridge } = await fixture(t);
  assert.equal((await request(bridge, { path: "/v1/status" })).status, 401);
  assert.equal((await request(bridge, { path: "/v1/status", headers: { "X-F95-Token": "0".repeat(64) } })).status, 401);
  assert.equal((await request(bridge, { path: "/v1/status", headers: { "X-F95-Token": bridge.token, Origin: "https://evil.example" } })).status, 403);
  assert.equal((await request(bridge, { path: "/v1/status", headers: { "X-F95-Token": bridge.token, Host: "evil.example" } })).status, 403);
  const ok = await request(bridge, { path: "/v1/status", headers: { "X-F95-Token": bridge.token, Origin: "moz-extension://abc-123" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["access-control-allow-origin"], "moz-extension://abc-123");
});

test("extension bridge keeps its token across restarts", async (t) => {
  const { bridge } = await fixture(t);
  const second = new ExtensionBridge({ appService: bridge.appService, userDataPath: path.dirname(bridge.tokenPath), port: 0 });
  assert.equal(await second.loadOrCreateToken(), bridge.token);
});

test("extension pairing needs an extension origin and the user's approval", async (t) => {
  const { bridge, confirm } = await fixture(t);
  const pair = (headers) => request(bridge, { method: "POST", path: "/v1/pair", headers, body: "{}" });
  assert.equal((await pair({})).status, 403);
  assert.equal((await pair({ Origin: "https://evil.example" })).status, 403);

  confirm.answer = false;
  assert.equal((await pair({ Origin: "moz-extension://abc-123" })).status, 403);
  confirm.answer = true;
  assert.equal((await pair({ Origin: "moz-extension://abc-123" })).status, 403, "a denial pauses further prompts");

  bridge.pairDeniedAt = 0;
  const granted = await pair({ Origin: "moz-extension://abc-123" });
  assert.equal(granted.status, 200);
  assert.equal(granted.json.token, bridge.token);
});

test("extension bridge moves to the next port when one is taken", async (t) => {
  const { bridge: first } = await fixture(t);
  const second = new ExtensionBridge({ appService: first.appService, userDataPath: path.dirname(first.tokenPath), port: first.port });
  await second.start();
  t.after(() => second.stop());
  assert.equal(second.port, first.port + 1);
});
