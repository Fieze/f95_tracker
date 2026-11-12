const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { AppService } = require("../src/main/services/appService");
const { PixeldrainRestrictedError, parsePixeldrainUrl, resolvePixeldrainDownload } = require("../src/main/services/pixeldrain");
const { findSaveItems, transferSaves } = require("../src/main/services/saveTransfer");
const { zipFixture } = require("./zipFixture");

const fixture = (name) => fs.readFile(path.join(__dirname, "fixtures", "threads", `${name}.html`), "utf8");
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function createService(t, { sessionFetch, downloadFetch, engine = "Ren'Py" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f95-updates-"));
  const service = new AppService({
    userDataPath: root,
    authSession: { cookies: { get: async () => [] }, fetch: sessionFetch },
    folderWatcher: { start: async () => {}, stop: async () => {}, ignoreFile: () => {} },
    onStateChanged: () => {},
    downloadFetch,
    fetcherOptions: { minIntervalMs: 0, jitterMs: 0 }
  });
  await service.db.initialize();
  t.after(async () => {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const installRoot = path.join(root, "games");
  await service.db.saveSettings({ installRoot, watchFolder: path.join(root, "watch"), syncIntervalMinutes: 30 });
  const game = await service.db.upsertGameFromThread({ sourceUrl: "https://f95zone.to/threads/update-test.555/",
    title: "Update Test", threadTitle: "Update Test", currentVersion: "2.0", developer: "Dev", engine,
    threadStatus: "Ongoing", overview: "", releaseDate: "", changelog: "", bannerImage: null,
    screenshotImages: [], tags: [], aliases: [], warnings: [], rawOpHtml: "", rawOpText: "", parserDebug: {}, downloadGroups: [] });
  return { service, root, installRoot, game };
}

async function install(service, root, game, version, entries) {
  const archivePath = path.join(root, `update-test-${version}.zip`);
  await fs.writeFile(archivePath, zipFixture(entries));
  const job = await service.db.createArchiveJob({ archivePath, archiveName: path.basename(archivePath), archiveHash: version,
    gameId: game.id, detectedVersion: version, status: "queued", confidence: "high", matchCandidates: [] });
  await service.extractJob(job.id, game.id, version);
  await service.archiveQueue.waitIdle();
  const finished = service.db.listArchiveJobs().find((entry) => entry.id === job.id);
  assert.equal(finished.status, "processed", finished.errorText);
  return finished.extractedTo;
}

const exists = (target) => fs.access(target).then(() => true, () => false);

test("pixeldrain addresses are recognised by kind", () => {
  assert.deepEqual(parsePixeldrainUrl("https://pixeldrain.com/u/AbC123xy"), { kind: "file", id: "AbC123xy" });
  assert.deepEqual(parsePixeldrainUrl("https://pixeldrain.com/api/file/AbC123xy?download"), { kind: "file", id: "AbC123xy" });
  assert.deepEqual(parsePixeldrainUrl("https://www.pixeldrain.com/l/List42#item=1"), { kind: "list", id: "List42", item: 1 });
  assert.deepEqual(parsePixeldrainUrl("https://pixeldrain.com/d/abcd1234/builds/win.zip"), { kind: "filesystem", id: "abcd1234", path: ["builds", "win.zip"] });
  assert.equal(parsePixeldrainUrl("https://pixeldrain.com/"), null);
  assert.equal(parsePixeldrainUrl("https://example.org/u/AbC123xy"), null);
  assert.equal(parsePixeldrainUrl("https://f95zone.to/dl/100/?k=1"), null);
});

test("the pixeldrain API turns a page address into the file's download address, name and checksum", async () => {
  const sha = "a".repeat(64);
  const calls = [];
  const fetchStub = async (url) => {
    calls.push(url);
    if (url.endsWith("/file/AbC123xy/info")) return jsonResponse({ success: true, id: "AbC123xy", name: "Game-1.0-pc.zip", size: 1234, hash_sha256: sha, availability: "" });
    if (url.endsWith("/list/List42")) return jsonResponse({ success: true, id: "List42", files: [{ id: "note1", name: "readme.txt" }, { id: "AbC123xy", name: "Game-1.0-pc.zip" }] });
    if (url.endsWith("/filesystem/abcd1234?stat")) return jsonResponse({ path: [{ type: "dir", name: "share" }], base_index: 0, children: [{ type: "file", name: "Game 1.0.7z", file_size: 77, sha256_sum: sha }] });
    return jsonResponse({ success: false, value: "not_found" }, 404);
  };

  const file = await resolvePixeldrainDownload("https://pixeldrain.com/u/AbC123xy", { fetch: fetchStub });
  assert.deepEqual(file, { url: "https://pixeldrain.com/api/file/AbC123xy?download", fileName: "Game-1.0-pc.zip", size: 1234, sha256: sha });

  const fromList = await resolvePixeldrainDownload("https://pixeldrain.com/l/List42", { fetch: fetchStub });
  assert.equal(fromList.fileName, "Game-1.0-pc.zip", "the only archive of a list is chosen");

  const fromDirectory = await resolvePixeldrainDownload("https://pixeldrain.com/d/abcd1234", { fetch: fetchStub });
  assert.deepEqual(fromDirectory, { url: "https://pixeldrain.com/api/filesystem/abcd1234/Game%201.0.7z?attach", fileName: "Game 1.0.7z", size: 77, sha256: sha });

  await assert.rejects(() => resolvePixeldrainDownload("https://pixeldrain.com/u/Missing0", { fetch: fetchStub }), /no longer exists/);
  assert.ok(calls.every((url) => url.startsWith("https://pixeldrain.com/api/")));
});

test("a pixeldrain file behind a captcha, or a list with several archives, is left to the page", async () => {
  const limited = async () => jsonResponse({ success: true, id: "AbC123xy", name: "a.zip", size: 1, availability: "file_rate_limited_captcha_required", availability_message: "captcha" });
  await assert.rejects(
    () => resolvePixeldrainDownload("https://pixeldrain.com/u/AbC123xy", { fetch: limited }),
    (error) => error instanceof PixeldrainRestrictedError && error.code === "file_rate_limited_captcha_required"
  );
  const several = async () => jsonResponse({ success: true, files: [{ id: "one00001", name: "win.zip" }, { id: "two00002", name: "mac.zip" }] });
  await assert.rejects(
    () => resolvePixeldrainDownload("https://pixeldrain.com/l/List42", { fetch: several }),
    (error) => error.restricted === true && error.code === "multiple_files"
  );
});

test("a download is checked against the checksum the host published", async (t) => {
  const body = "archive bytes";
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  const { service } = await createService(t, { downloadFetch: async () => new Response(body, { headers: { "content-length": String(body.length) } }) });

  const good = service.createDownloadJob({ url: "https://pixeldrain.com/api/file/AbC123xy?download" });
  const done = await service.startResolvedDownload(good.id, { url: good.sourceUrl, fileName: "good.bin", expectedSha256: sha });
  assert.equal(done.status, "completed");
  assert.equal(await fs.readFile(done.targetPath, "utf8"), body);

  const bad = service.createDownloadJob({ url: "https://pixeldrain.com/api/file/AbC123xy?download" });
  await assert.rejects(() => service.startResolvedDownload(bad.id, { url: bad.sourceUrl, fileName: "bad.bin", expectedSha256: "0".repeat(64) }), /checksum/);
  const failed = service.getDownloadJob(bad.id);
  assert.equal(failed.status, "failed");
  assert.equal(await exists(failed.targetPath), false);
  assert.equal(await exists(`${failed.targetPath}.part`), false);
});

test("a refused pixeldrain download explains the captcha instead of a bare status code", async (t) => {
  const { service } = await createService(t, {
    downloadFetch: async () => jsonResponse({ success: false, value: "ip_download_limited_captcha_required", message: "limit" }, 403)
  });
  const job = service.createDownloadJob({ url: "https://pixeldrain.com/api/file/AbC123xy?download" });
  await assert.rejects(() => service.startResolvedDownload(job.id, { url: job.sourceUrl }), /captcha/);
});

test("two loads of an unchanged thread compare equal although every link is signed anew", async (t) => {
  const html = await fixture("seasons-logged-in");
  let load = 0;
  const { service } = await createService(t, {
    sessionFetch: async () => new Response(html.replace(/t=tok/g, `t=load${++load}tok`), { headers: { "content-type": "text/html" } })
  });
  const game = await service.addThread("https://f95zone.to/threads/example-saga.9/");
  const before = service.db.getGameById(game.id).downloadGroups.flatMap((group) => group.links);
  assert.ok(before.every((link) => /t=load1tok/.test(link.url)));
  assert.equal(before.find((link) => link.label === "PIXELDRAIN").host, "pixeldrain.com");

  const parsed = await service.loadThread(game.threadUrl);
  assert.equal(service.hasThreadChanges(service.db.getGameRefreshMetadata(game.id), parsed), false);

  await service.refreshGame(game.id);
  const after = service.db.getGameById(game.id).downloadGroups.flatMap((group) => group.links);
  assert.deepEqual(after.map((link) => link.id).sort(), before.map((link) => link.id).sort(), "links keep their ids");
  assert.ok(after.every((link) => /t=load3tok/.test(link.url)), "but carry the newest signature");
});

test("an old forum download link is renewed from a fresh page load before the download starts", async (t) => {
  const html = await fixture("seasons-logged-in");
  let load = 0;
  const { service } = await createService(t, {
    sessionFetch: async () => new Response(html.replace(/t=tok/g, `t=load${++load}tok`), { headers: { "content-type": "text/html" } })
  });
  const game = await service.addThread("https://f95zone.to/threads/example-saga.9/");
  const link = service.db.getGameById(game.id).downloadGroups.flatMap((group) => group.links).find((entry) => /k=a2&/.test(entry.url));

  const fresh = await service.freshDownloadPayload({ gameId: game.id, linkId: link.id, url: link.url, label: link.label });
  assert.equal(fresh.url, link.url, "a link that was just read is used as it is");
  assert.equal(fresh.host, "pixeldrain.com");
  assert.equal(load, 1);

  service.db.db.run("UPDATE download_links SET last_seen_at = ? WHERE game_id = ?", [new Date(Date.now() - 3600000).toISOString(), game.id]);
  const renewed = await service.freshDownloadPayload({ gameId: game.id, linkId: link.id, url: link.url, label: link.label });
  assert.equal(load, 2);
  assert.match(renewed.url, /k=a2&.*t=load2tok/, "the same link, signed by the new page load");
});

test("refreshing all games asks the version check first and only reads threads whose version changed", async (t) => {
  const html = await fixture("renpy-logged-in");
  const versions = { 1: "v0.1.4.0", 2: "v0.1.4.0" };
  const requests = [];
  const { service } = await createService(t, {
    sessionFetch: async (url) => {
      requests.push(url);
      if (url.includes("/sam/checker.php")) return jsonResponse({ status: "ok", msg: versions });
      return new Response(html, { headers: { "content-type": "text/html" } });
    }
  });
  const first = await service.addThread("https://f95zone.to/threads/example-game.1/");
  const second = await service.addThread("https://f95zone.to/threads/example-two.2/");
  assert.equal(first.currentVersion, "v0.1.4.0");

  requests.length = 0;
  await service.refreshAllGames();
  assert.equal(requests[0], "https://f95zone.to/sam/checker.php?threads=1,2,555");
  assert.equal(requests.filter((url) => /\/threads\/example-/.test(url)).length, 0, "confirmed threads are not read");
  assert.equal(requests.filter((url) => url.includes("/threads/update-test.555")).length, 1, "a thread never read in this run is");
  assert.equal(service.db.getGameById(second.id).lastSyncStatus, "success");

  versions[2] = "v0.2.0.0";
  requests.length = 0;
  await service.refreshAllGames();
  assert.equal(requests.filter((url) => url.includes("/threads/example-two.2")).length, 1, "the changed thread is read");
  assert.equal(requests.filter((url) => url.includes("/threads/example-game.1")).length, 0, "the unchanged one is not");
});

test("save data is found where the common engines keep it and copied with its time stamps", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f95-saves-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldDir = path.join(root, "old");
  const newDir = path.join(root, "new");
  const write = async (base, relative, content) => {
    await fs.mkdir(path.dirname(path.join(base, relative)), { recursive: true });
    await fs.writeFile(path.join(base, relative), content);
  };
  await write(oldDir, "game/saves/1-1-LT1.save", "renpy save");
  await write(oldDir, "game/saves/persistent", "persistent");
  await write(oldDir, "www/save/file1.rpgsave", "mv save");
  await write(oldDir, "Save01.rvdata2", "ace save");
  await write(oldDir, "Project/Saved/SaveGames/slot.sav", "unreal save");
  await write(oldDir, "game/script.rpy", "not a save");
  await write(oldDir, "renpy/common/saves/ignored.txt", "engine files are skipped");
  await write(newDir, "game/saves/persistent", "shipped with the new version");
  const stamp = new Date("2024-05-01T10:00:00Z");
  await fs.utimes(path.join(oldDir, "game/saves/1-1-LT1.save"), stamp, stamp);

  const found = (await findSaveItems(oldDir)).map((item) => item.relativePath.split(path.sep).join("/")).sort();
  assert.deepEqual(found, ["Project/Saved/SaveGames", "Save01.rvdata2", "game/saves", "www/save"]);

  const result = await transferSaves(oldDir, newDir);
  assert.equal(result.files, 5);
  assert.equal(await fs.readFile(path.join(newDir, "game/saves/persistent"), "utf8"), "persistent", "the player's saves win");
  assert.equal(await fs.readFile(path.join(newDir, "Project/Saved/SaveGames/slot.sav"), "utf8"), "unreal save");
  assert.equal((await fs.stat(path.join(newDir, "game/saves/1-1-LT1.save"))).mtime.getTime(), stamp.getTime());
  assert.equal(await exists(path.join(newDir, "game/script.rpy")), false);
});

test("installing an update carries the saves over and removes the version it replaces", async (t) => {
  const { service, root, game } = await createService(t);
  const first = await install(service, root, game, "1.0", [{ name: "Game.exe", content: "v1" }, { name: "Game-32.exe", content: "v1" }, { name: "game/script.rpy", content: "v1" }]);
  await fs.mkdir(path.join(first, "game", "saves"), { recursive: true });
  await fs.writeFile(path.join(first, "game", "saves", "1-1-LT1.save"), "progress");
  const firstFolder = service.db.listGameFolders(game.id)[0];
  await service.db.updateGameFolderMetadata(firstFolder.id, { preferredExePath: path.join(first, "Game-32.exe") });

  const second = await install(service, root, game, "2.0", [{ name: "Game.exe", content: "v2" }, { name: "Game-32.exe", content: "v2" }, { name: "game/script.rpy", content: "v2" }]);
  assert.equal(await fs.readFile(path.join(second, "game", "saves", "1-1-LT1.save"), "utf8"), "progress");
  assert.equal(await exists(first), false, "the replaced version is gone");
  const folders = service.db.listGameFolders(game.id);
  assert.deepEqual(folders.map((folder) => folder.version), ["2.0"]);
  assert.equal(folders[0].preferredExePath, path.join(second, "Game-32.exe"), "the chosen executable is kept");
  assert.ok(service.activities.some((activity) => /1 save file carried over from 1\.0, old version removed/.test(activity.message)));
});

test("the previous version stays when removal is switched off, when no saves were found, or for an older install", async (t) => {
  const { service, root, game } = await createService(t, { engine: "RPGM" });
  const first = await install(service, root, game, "1.0", [{ name: "Game.exe", content: "v1" }]);

  // RPG Maker keeps saves in the game folder; none found means they may be somewhere this app did not look.
  const second = await install(service, root, game, "2.0", [{ name: "Game.exe", content: "v2" }]);
  assert.equal(await exists(first), true);
  assert.ok(service.activities.some((activity) => activity.status === "error" && /No save files were found/.test(activity.message)));

  await fs.mkdir(path.join(second, "www", "save"), { recursive: true });
  await fs.writeFile(path.join(second, "www", "save", "file1.rpgsave"), "progress");
  await service.db.saveSettings({ removeOldVersion: false });
  const third = await install(service, root, game, "3.0", [{ name: "Game.exe", content: "v3" }]);
  assert.equal(await fs.readFile(path.join(third, "www", "save", "file1.rpgsave"), "utf8"), "progress");
  assert.equal(await exists(second), true, "kept because removal is switched off");

  // Installing an older build again is not an update: nothing is copied into it and nothing is removed.
  await service.db.saveSettings({ removeOldVersion: true });
  const older = await install(service, root, game, "0.5", [{ name: "Game.exe", content: "v0.5" }]);
  assert.equal(await exists(path.join(older, "www", "save")), false);
  assert.equal(await exists(third), true);

  await service.db.saveSettings({ transferSaves: false });
  const fourth = await install(service, root, game, "4.0", [{ name: "Game.exe", content: "v4" }]);
  assert.equal(await exists(path.join(fourth, "www", "save")), false, "nothing is carried over when the option is off");
  assert.equal(await exists(third), true);
});
