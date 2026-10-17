const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { ApiKeyStore } = require("../src/main/services/apiKeyStore");
const { F95ApiClient } = require("../src/main/services/f95ApiClient");
const { adaptApiThread, downloadsOf, ThreadDataSource, summaryFingerprint } = require("../src/main/services/threadDataSource");
const { AppService } = require("../src/main/services/appService");

const url = "https://f95zone.to/threads/example.42/";
const detail = { thread_id: 42, url, title: "Example [2.0]", version: "2.0", developer: "Dev",
  overview: "Description", release_date: "2026-10-12", changelog: "Fixed bugs", tag_names: ["test"], last_promoted: 123,
  banner: "https://attachments.f95zone.to/banner.png", previews: ["https://attachments.f95zone.to/preview.png"],
  downloads: [{ group: "Win", links: [{ host: "Pixeldrain", label: "Mirror", url: "https://pixeldrain.com/u/test" }] }] };
const handiwork = { id: 42, name: "Example", version: "2.0", engine: "Ren'Py", status: "Completed" };
const store = () => ({ key: "private-fixture-key", getState: () => ({ configured: true, persistent: false }) });
function clientFor(fetchImpl, options = {}) {
  let time = 0;
  return new F95ApiClient(store(), { fetchImpl, now: () => time, wait: async (ms) => { time += ms; }, ...options });
}
async function serviceFor(t, fetchImpl) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f95-api-test-"));
  const service = new AppService({ userDataPath: root, authSession: { cookies: { get: async () => [] } },
    folderWatcher: { start: async () => {}, stop: async () => {} }, apiOptions: { fetchImpl, wait: async () => {} } });
  await service.db.initialize();
  await service.setApiKey("private-fixture-key");
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return service;
}

test("API adapter maps metadata and filters unsafe/platform download links", () => {
  const parsed = adaptApiThread(handiwork, detail, url);
  assert.equal(parsed.engine, "Ren'Py"); assert.equal(parsed.threadStatus, "complete");
  assert.equal(parsed.changelog, "Fixed bugs"); assert.equal(parsed.developer, "Dev");
  assert.equal(parsed.bannerImageUrl, detail.banner); assert.deepEqual(parsed.screenshotImageUrls, detail.previews);
  assert.equal(parsed.rawOpHtml, ""); assert.equal(parsed.dataSource, "api");
  assert.equal(parsed.downloadGroups[0].label, "Win");
  assert.deepEqual(downloadsOf([{ group: "Mac", links: detail.downloads[0].links },
    { group: "Win/Linux", links: [{ url: "file:///evil" }, ...detail.downloads[0].links] }]),
    [{ label: "Win/Linux", links: [{ label: "Mirror", url: "https://pixeldrain.com/u/test" }] }]);
});
test("API adapter supports Handiwork changelog, cover and authors and validates identity", () => {
  const parsed = adaptApiThread({ ...handiwork, status: "Onhold", authors: [{ name: "Author" }],
    cover: "https://example.org/cover.jpg", changelog: [{ version: "2", information: ["Fix"] }] },
    { thread_id: 42, title: "Example", version: "2" }, url);
  assert.equal(parsed.changelog, "2\nFix"); assert.equal(parsed.developer, "Author");
  assert.equal(parsed.threadStatus, "on hold"); assert.equal(parsed.bannerImageUrl, "https://example.org/cover.jpg");
  assert.ok(parsed.warnings.length);
  assert.throws(() => adaptApiThread(handiwork, { ...detail, thread_id: 43 }, url), /incomplete/);
});
test("API client serializes concurrent requests with at least one second between starts", async () => {
  let time = 0; const starts = [];
  const client = clientFor(async (target, options) => {
    starts.push(time); assert.equal(new URL(target).origin, "https://f95api.xyz");
    assert.equal(options.headers["X-API-Key"], "private-fixture-key"); assert.equal(options.redirect, "error");
    return Response.json({ items: [] });
  }, { now: () => time, wait: async (ms) => { time += ms; } });
  await Promise.all([client.request("/v1/threads"), client.request("/v1/threads"), client.request("/v1/threads")]);
  assert.deepEqual(starts, [0, 1000, 2000]);
});
test("API client obeys Retry-After and continues after a rate limit", async () => {
  let count = 0, time = 0; const starts = [];
  const client = clientFor(async () => { starts.push(time); return ++count === 1
    ? new Response("", { status: 429, headers: { "retry-after": "5" } }) : Response.json({ items: [] });
  }, { now: () => time, wait: async (ms) => { time += ms; } });
  await client.request("/v1/threads"); assert.deepEqual(starts, [0, 5000]);
});
for (const status of [401, 403, 404, 422, 503]) test(`API ${status} is reported safely and auth failures suspend requests`, async () => {
  let count = 0;
  const client = clientFor(async () => { count++; return new Response("secret response body", { status }); });
  await assert.rejects(client.request("/v1/threads"), new RegExp(String(status)));
  assert.ok(!JSON.stringify(client.getState()).includes("private-fixture-key"));
  if ([401, 403].includes(status)) {
    await assert.rejects(client.request("/v1/threads"), /paused/); assert.equal(count, 1);
    client.reset(); await assert.rejects(client.request("/v1/threads")); assert.equal(count, 2);
  }
});
test("API retries exhausted 429, invalid JSON and network errors preserve safe errors", async () => {
  let count = 0;
  const limited = clientFor(async () => { count++; return new Response("", { status: 429 }); });
  await assert.rejects(limited.request("/v1/threads"), /429/); assert.equal(count, 3);
  await assert.rejects(clientFor(async () => new Response("not JSON")).request("/v1/threads"), /invalid JSON/);
  await assert.rejects(clientFor(async () => { throw new Error("private-fixture-key"); }).request("/v1/threads"), /could not connect/);
});
test("API timeout and shutdown abort active and queued requests", async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const timed = clientFor(fetchImpl, { timeoutMs: 10 });
  const keepAlive = setInterval(() => {}, 50);
  try { await assert.rejects(timed.request("/v1/threads"), /timed out/); } finally { clearInterval(keepAlive); }
  const client = new F95ApiClient(store(), { fetchImpl });
  const pending = Promise.allSettled([client.request("/v1/threads"), client.request("/v1/threads")]);
  await new Promise((resolve) => setTimeout(resolve, 10)); client.abort();
  assert.ok((await pending).every((result) => result.status === "rejected"));
});
test("API key encrypts on disk, reloads, deletes and falls back to session storage", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f95-key-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secure = { isEncryptionAvailable: () => true, encryptString: (key) => Buffer.from(key.split("").reverse().join("")),
    decryptString: (buffer) => buffer.toString().split("").reverse().join("") };
  const keyStore = new ApiKeyStore(root, secure); await keyStore.set("private-fixture-key");
  assert.ok(!(await fs.readFile(keyStore.filePath, "utf8")).includes("private-fixture-key"));
  const reloaded = new ApiKeyStore(root, secure); await reloaded.initialize(); assert.equal(reloaded.key, keyStore.key);
  assert.equal(reloaded.getState().persistent, true);
  await reloaded.set(""); await assert.rejects(fs.access(keyStore.filePath));
  const session = new ApiKeyStore(root, { isEncryptionAvailable: () => false });
  await session.set("session-key"); assert.equal(session.getState().persistent, false); await assert.rejects(fs.access(session.filePath));
  const broken = new ApiKeyStore(root, { isEncryptionAvailable: () => true, encryptString: () => { throw new Error("OS encryption unavailable"); } });
  await broken.set("session-key"); assert.equal(broken.getState().persistent, false); await assert.rejects(fs.access(broken.filePath));
});
test("API source only falls back for missing/incomplete game data with forum login", async () => {
  let calls = 0;
  const service = { apiKeyStore: store(), apiClient: { request: async () => { const error = new Error("missing"); error.status = 404; throw error; } },
    getAuthState: async () => ({ loggedIn: true }), fetcher: { fetchThread: async () => { calls++; return { html: "fixture", url }; } },
    parseThreadWithLogging: async () => ({ title: "Scraped" }) };
  assert.equal((await new ThreadDataSource(service).load(url)).dataSource, "scraper"); assert.equal(calls, 1);
  for (const status of [401, 403, 422, 429, 503]) {
    service.apiClient.request = async () => { const error = new Error("failure"); error.status = status; throw error; };
    await assert.rejects(new ThreadDataSource(service).load(url));
  }
  assert.equal(calls, 1);
});
test("API refresh without forum login preserves installations and incomplete optional fields, excludes keys from export", async (t) => {
  const service = await serviceFor(t, async (target) => Response.json(target.includes("handiwork") ? handiwork : detail));
  service.hydrateThreadAssets = async (parsed) => ({ ...parsed, bannerImage: null, screenshotImages: [] });
  const game = await service.addThread(url);
  await service.db.updateInstalledVersion(game.id, "1.0", "D:\\ExistingGame");
  await service.db.updateGameSeasons(game.id, true);
  service.apiClient.fetchImpl = async (target) => Response.json(target.includes("handiwork") ? { ...handiwork, engine: "" } :
    { thread_id: 42, url, title: "Example", version: "3.0", downloads: [], overview: "" });
  const updated = await service.refreshGame(game.id);
  assert.equal(updated.currentVersion, "3.0"); assert.equal(updated.installedVersion, "1.0");
  assert.equal(updated.installPath, "D:\\ExistingGame"); assert.equal(updated.hasSeasons, true);
  assert.equal(updated.overview, "Description"); assert.equal(updated.engine, "Ren'Py"); assert.equal(updated.downloadGroups.length, 1);
  assert.ok(updated.parserWarnings.length);
  assert.ok(!JSON.stringify(await service.getState()).includes("private-fixture-key"));
  const snapshot = service.db.exportSnapshot(); assert.ok(!JSON.stringify(snapshot).includes("private-fixture-key"));
  for (const row of snapshot.tables.games) { delete row.data_source; delete row.api_last_promoted; delete row.api_detail_checked_at; }
  await service.db.importSnapshot(snapshot); assert.equal(service.db.getGameById(game.id).dataSource, "scraper");
});
test("API batch synchronization chunks 25 IDs and skips fresh unchanged details", async (t) => {
  const requests = [];
  const summary = { ...detail };
  const service = await serviceFor(t, async (target) => {
    requests.push(target); const ids = new URL(target).searchParams.get("ids").split(",");
    return Response.json({ items: ids.map((id) => ({ ...summary, thread_id: Number(id) })) });
  });
  for (let id = 1; id <= 26; id++) {
    const parsed = adaptApiThread({ ...handiwork, id }, { ...detail, thread_id: id }, `https://f95zone.to/threads/example.${id}/`);
    parsed.parserDebug.apiSummaryFingerprint = summaryFingerprint(summary);
    await service.db.upsertGameFromThread(parsed);
  }
  await service.refreshAllGames();
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0]).searchParams.get("ids").split(",").length, 25);
  assert.equal(new URL(requests[1]).searchParams.get("ids").split(",").length, 1);
  await service.db.markSyncFailure(1, "old failure");
  service.apiClient.fetchImpl = async () => new Response("", { status: 503 });
  await assert.rejects(service.refreshAllGames(), /503/);
  assert.equal(service.db.getGameById(1).title, "Example");
});

test("API sync reloads changed summaries and details older than 24 hours", async (t) => {
  const requests = [];
  let version = "2.0";
  const service = await serviceFor(t, async (target) => {
    requests.push(target);
    if (target.includes("/batch")) return Response.json({ items: [{ ...detail, version }] });
    return Response.json(target.includes("handiwork") ? handiwork : { ...detail, version });
  });
  service.hydrateThreadAssets = async (parsed) => ({ ...parsed, bannerImage: null, screenshotImages: [] });
  const parsed = adaptApiThread(handiwork, detail, url);
  parsed.parserDebug.apiSummaryFingerprint = summaryFingerprint(detail);
  const game = await service.db.upsertGameFromThread(parsed);
  version = "3.0";
  await service.refreshAllGames();
  assert.equal(requests.length, 3); assert.equal(service.db.getGameById(game.id).currentVersion, "3.0");
  requests.length = 0;
  service.db.db.run("UPDATE games SET api_detail_checked_at = ? WHERE id = ?", ["2000-01-01T00:00:00Z", game.id]);
  await service.refreshAllGames(); assert.equal(requests.length, 3);
  const before = service.db.getGameById(game.id);
  service.apiClient.fetchImpl = async () => new Response("", { status: 401 });
  await assert.rejects(service.refreshGame(game.id), /401/);
  assert.equal(service.db.getGameById(game.id).currentVersion, before.currentVersion);
});

test("API migration backs up existing database before adding columns", async (t) => {
  const service = await serviceFor(t, async () => Response.json({ items: [] }));
  const snapshot = service.db.exportSnapshot();
  // Build an old database by removing the new columns from an isolated fixture.
  service.db.db.run("ALTER TABLE games DROP COLUMN data_source");
  service.db.db.run("ALTER TABLE games DROP COLUMN api_last_promoted");
  service.db.db.run("ALTER TABLE games DROP COLUMN api_detail_checked_at");
  await service.db.persist();
  const before = await fs.readFile(service.db.dbPath);
  const { DatabaseService } = require("../src/main/services/db");
  const reopened = new DatabaseService(service.userDataPath);
  await reopened.initialize();
  assert.deepEqual(await fs.readFile(path.join(service.userDataPath, "backups", "pre-api-upgrade.sqlite")), before);
  await reopened.importSnapshot(snapshot); reopened.db.close();
});
