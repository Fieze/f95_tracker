const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { AppService } = require("../src/main/services/appService");
const { FolderWatcher } = require("../src/main/services/folderWatcher");
const { runSevenZip } = require("../src/main/services/sevenZipRunner");
const { resolveSevenZipBinary } = require("../src/main/services/sevenZip");
const { zipFixture } = require("./zipFixture");

test("bundled 7zip installs flat and single-root archives and rejects traversal", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f95-integration-"));
  const service = new AppService({ userDataPath: root, authSession: { cookies: { get: async () => [] } },
    folderWatcher: { start: async () => {}, stop: async () => {}, ignoreFile: () => {} } });
  await service.db.initialize();
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const installRoot = path.join(root, "games");
  await service.db.saveSettings({ installRoot, watchFolder: "", syncIntervalMinutes: 30 });
  const game = await service.db.upsertGameFromThread({ sourceUrl: "https://f95zone.to/threads/integration.444/",
    title: "Integration", threadTitle: "Integration", currentVersion: "2.0", developer: "Dev", engine: "Ren'Py",
    threadStatus: "Ongoing", overview: "", releaseDate: "", changelog: "", bannerImage: null,
    screenshotImages: [], tags: [], aliases: [], warnings: [], rawOpHtml: "", rawOpText: "", parserDebug: {}, downloadGroups: [] });
  for (const [index, prefix] of ["", "original/"].entries()) {
    const archivePath = path.join(root, `valid-${index}.zip`);
    await fs.writeFile(archivePath, zipFixture([{ name: prefix + "game.exe", content: "game" }, { name: prefix + "assets/data.bin", content: "data" }]));
    const job = await service.db.createArchiveJob({ archivePath, archiveName: path.basename(archivePath), archiveHash: String(index),
      gameId: game.id, detectedVersion: "2.0", status: "queued", confidence: "high", matchCandidates: [] });
    await service.extractJob(job.id, game.id, "2.0"); await service.archiveQueue.waitIdle();
    const finished = service.db.listArchiveJobs().find((entry) => entry.id === job.id);
    assert.equal(finished.status, "processed", finished.errorText);
    assert.equal(await fs.readFile(path.join(finished.extractedTo, "game.exe"), "utf8"), "game");
    await assert.rejects(fs.access(archivePath));
  }
  assert.equal(service.db.listGameFolders(game.id).length, 2);
  const dangerous = path.join(root, "dangerous.zip");
  await fs.writeFile(dangerous, zipFixture([{ name: "../escape.exe", content: "unsafe" }]));
  const job = await service.db.createArchiveJob({ archivePath: dangerous, archiveName: "dangerous.zip", archiveHash: "bad",
    gameId: game.id, detectedVersion: "2.0", status: "queued", confidence: "high", matchCandidates: [] });
  await service.extractJob(job.id, game.id, "2.0"); await service.archiveQueue.waitIdle();
  const failed = service.db.listArchiveJobs().find((entry) => entry.id === job.id);
  assert.equal(failed.status, "failed"); assert.match(failed.errorText, /Unsafe/);
  await fs.access(dangerous);
  assert.equal(service.db.listGameFolders(game.id).length, 2);
});

test("cancellation terminates the actual bundled 7zip process", async () => {
  const binary = resolveSevenZipBinary();
  const handle = runSevenZip(binary, ["b", "-mmt1", "-md18"]);
  const rejected = assert.rejects(handle.completion, /canceled/);
  assert.ok(handle.pid);
  process.kill(handle.pid, 0);
  await handle.terminate();
  await rejected;
  assert.throws(() => process.kill(handle.pid, 0), /ESRCH/);
});

test("real folder watcher detects a stable archive", { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f95-watcher-"));
  let resolveDetected, rejectDetected;
  const detected = new Promise((resolve, reject) => { resolveDetected = resolve; rejectDetected = reject; });
  const watcher = new FolderWatcher({ onArchiveDetected: resolveDetected });
  t.after(async () => { await watcher.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await watcher.start(root);
  watcher.watcher.on("error", rejectDetected);
  const archivePath = path.join(root, "stable.zip");
  await fs.writeFile(archivePath, zipFixture([{ name: "game.exe" }]));
  const timeout = setTimeout(() => rejectDetected(new Error("Folder watcher did not detect the archive.")), 12000);
  try {
    const result = await detected;
    assert.equal(result.archivePath, archivePath); assert.equal(result.archiveHash.length, 64);
  } finally { clearTimeout(timeout); }
});
