const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { DatabaseService } = require("../src/main/services/db");
const { AppService } = require("../src/main/services/appService");
const { ArchiveQueue } = require("../src/main/services/archiveQueue");
const { OperationGate } = require("../src/main/services/operationGate");
const { assertManagedInstallPath, assertSafeTree } = require("../src/main/services/safeFiles");
const { isSafeBrowserUrl, assertTrustedIpcSender } = require("../src/main/services/browserSafety");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f95-safety-"));
  const app = new AppService({ userDataPath: root, authSession: { cookies: { get: async () => [] } },
    folderWatcher: { start: async () => {}, stop: async () => {}, ignoreFile: () => {} } });
  await app.db.initialize();
  t.after(async () => { await app.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const installRoot = path.join(root, "installs");
  await app.db.saveSettings({ installRoot, watchFolder: "", syncIntervalMinutes: 30 });
  const game = await app.db.upsertGameFromThread({ sourceUrl: "https://f95zone.to/threads/safety.98765/",
    title: "Safety Game", threadTitle: "Safety Game", currentVersion: "1.2", tags: [], aliases: [],
    developer: "Dev", engine: "Ren'Py", threadStatus: "Ongoing", overview: "", releaseDate: "", changelog: "",
    bannerImage: null, rawOpHtml: "", rawOpText: "",
    warnings: [], screenshotImages: [], downloadGroups: [], parserDebug: {} });
  return { app, root, installRoot, game, gameRoot: path.join(installRoot, "Safety Game") };
}

async function archive(f, name = "release.zip") {
  const archivePath = path.join(f.root, name);
  await fs.writeFile(archivePath, "archive");
  const job = await f.app.db.createArchiveJob({ archivePath, archiveName: name, archiveHash: name,
    gameId: f.game.id, detectedVersion: "1.2", status: "queued", confidence: "high", matchCandidates: [] });
  return f.app.db.listArchiveJobs().find((row) => row.id === job.id);
}

test("database serializes writes and reopens with the latest complete state", async (t) => {
  const { app, root } = await fixture(t);
  const writes = [];
  for (let index = 0; index < 20; index++) {
    app.db.db.run("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", [`test-${index}`, String(index)]);
    writes.push(app.db.persist());
  }
  await Promise.all(writes);
  await app.db.flush();
  const reopened = new DatabaseService(root);
  await reopened.initialize();
  assert.equal(reopened.query("SELECT * FROM settings WHERE key LIKE 'test-%'").length, 20);
  reopened.db.close();
  assert.equal((await fs.readdir(root)).some((name) => name.endsWith(".tmp")), false);
});

test("failed atomic replacement preserves disk data and subsequent writes recover", async (t) => {
  const { app } = await fixture(t);
  const before = await fs.readFile(app.db.dbPath);
  const originalRename = fs.rename;
  t.mock.method(fs, "rename", async (source, target) => {
    if (target === app.db.dbPath) throw Object.assign(new Error("injected rename failure"), { code: "EPERM" });
    return originalRename(source, target);
  });
  await assert.rejects(app.db.persist(), /injected/);
  await assert.rejects(app.db.flush(), /injected/);
  assert.deepEqual(await fs.readFile(app.db.dbPath), before);
  t.mock.restoreAll();
  await app.db.persist();
  await app.db.flush();
});

test("database initialization rejects unreadable and corrupt existing files", async (t) => {
  const { root } = await fixture(t);
  const db = new DatabaseService(root);
  const originalRead = fs.readFile;
  t.mock.method(fs, "readFile", async (file, ...args) => {
    if (file === db.dbPath) throw Object.assign(new Error("access denied"), { code: "EACCES" });
    return originalRead(file, ...args);
  });
  await assert.rejects(db.initialize(), /access denied/);
  t.mock.restoreAll();
  await fs.writeFile(db.dbPath, "broken database");
  await assert.rejects(new DatabaseService(root).initialize());
  assert.equal(await fs.readFile(db.dbPath, "utf8"), "broken database");
});

test("invalid snapshot and broken references preserve current memory and disk", async (t) => {
  const { app } = await fixture(t);
  const snapshot = app.db.exportSnapshot();
  const disk = await fs.readFile(app.db.dbPath);
  for (const change of [
    (copy) => { copy.version = 999; },
    (copy) => { copy.tables.games = {}; },
    (copy) => { copy.tables.games[0].unexpected = "invalid"; },
    (copy) => { copy.tables.game_folders = [{ id: 8, game_id: 999, folder_name: "bad", folder_path: "bad", version_source: "manual", created_at: "now", updated_at: "now" }]; }
  ]) {
    const copy = structuredClone(snapshot); change(copy);
    await assert.rejects(app.db.importSnapshot(copy));
    assert.deepEqual(app.db.exportSnapshot().tables, snapshot.tables);
    assert.deepEqual(await fs.readFile(app.db.dbPath), disk);
  }
});

test("snapshot replacement failure leaves the current database active", async (t) => {
  const { app } = await fixture(t);
  const snapshot = app.db.exportSnapshot();
  const current = app.db.db;
  t.mock.method(fs, "rename", async () => { throw new Error("replacement failed"); });
  await assert.rejects(app.db.importSnapshot(snapshot), /replacement failed/);
  assert.equal(app.db.db, current);
  assert.deepEqual(app.db.exportSnapshot().tables, snapshot.tables);
  t.mock.restoreAll();
  await app.db.persist();
});

test("import backs up data and rejects active downloads and operations", async (t) => {
  const { app, root } = await fixture(t);
  const file = path.join(root, "export.json");
  await app.exportDataToFile(file);
  const job = app.createDownloadJob({ gameId: 1, url: "https://example.com/archive.zip" });
  await assert.rejects(app.importDataFromFile(file), /downloads/);
  app.cancelDownloadJob(job.id);
  let release;
  const pending = app.gate.run(() => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(app.importDataFromFile(file), /operations/);
  release(); await pending;
  await app.importDataFromFile(file);
  assert.ok((await fs.readdir(app.backupPath)).some((name) => name.endsWith(".json")));
});

test("operation gate blocks mutations during import and does not leak timer context", async () => {
  const gate = new OperationGate();
  let release, timerResult;
  const work = gate.runExclusive(() => new Promise((resolve) => { release = resolve; }));
  assert.throws(() => gate.run(() => {}), /importing/);
  release(); await work;
  await gate.run(async () => {
    timerResult = new Promise((resolve) => setTimeout(() => {
      try { gate.run(() => {}); resolve(false); } catch { resolve(true); }
    }, 10));
  });
  gate.closed = true;
  assert.equal(await timerResult, true);
});

test("path validation rejects roots, sibling and foreign folders, permits missing managed folders", async (t) => {
  const { installRoot, gameRoot, root } = await fixture(t);
  const valid = path.join(gameRoot, "Safety Game-1.2");
  for (const value of [installRoot, gameRoot, path.join(root, "foreign"), path.join(installRoot + "-other", "game"), path.join(gameRoot + "-other", "build")]) {
    await assert.rejects(assertManagedInstallPath(installRoot, [gameRoot], value), /installation/);
  }
  assert.equal(await assertManagedInstallPath(installRoot, [gameRoot], valid), valid);
});

test("Windows junctions are rejected without touching the target", async (t) => {
  const { installRoot, gameRoot, root } = await fixture(t);
  const target = path.join(root, "foreign");
  const junction = path.join(gameRoot, "linked");
  await fs.mkdir(gameRoot, { recursive: true });
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "keep.txt"), "keep");
  await fs.symlink(target, junction, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(assertManagedInstallPath(installRoot, [gameRoot], junction), /junctions/);
  await assert.rejects(assertManagedInstallPath(installRoot, [gameRoot], path.join(junction, "nested")), /junctions/);
  await assert.rejects(assertSafeTree(gameRoot), /Unsafe/);
  await fs.unlink(junction);
  assert.equal(await fs.readFile(path.join(target, "keep.txt"), "utf8"), "keep");
});

test("install deletion removes a valid or missing folder and protects external entries", async (t) => {
  const f = await fixture(t);
  const valid = path.join(f.gameRoot, "build");
  await fs.mkdir(valid, { recursive: true });
  await f.app.db.upsertGameFolder(f.game.id, { folderName: "build", folderPath: valid, version: "1.2" });
  const entry = f.app.db.listGameFolders(f.game.id)[0];
  await f.app.deleteGameFolder({ folderId: entry.id });
  await assert.rejects(fs.access(valid));
  await f.app.db.upsertGameFolder(f.game.id, { folderName: "build", folderPath: valid, version: "1.2" });
  await f.app.deleteGameFolder({ folderId: f.app.db.listGameFolders(f.game.id)[0].id });
  const outside = path.join(f.root, "outside"); await fs.mkdir(outside);
  await f.app.db.upsertGameFolder(f.game.id, { folderName: "outside", folderPath: outside, version: "1.0" });
  const foreign = f.app.db.listGameFolders(f.game.id)[0];
  await f.app.syncGameFolders(f.game.id);
  assert.equal(f.app.db.getGameFolder(foreign.id)?.folderPath, outside);
  await assert.rejects(f.app.deleteGameFolder({ folderId: foreign.id }), /installation/);
  await fs.access(outside);
});

test("archive queue is FIFO, deduplicates jobs and continues after errors", async () => {
  const starts = [], errors = [];
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const queue = new ArchiveQueue({ prepare: async () => {}, run: async ({ jobId }) => {
    starts.push(jobId); if (jobId === 1) await first; if (jobId === 2) throw new Error("broken");
  }, onError: (error) => errors.push(error.message) });
  await queue.enqueue({ jobId: 1, gameId: 1 });
  await queue.enqueue({ jobId: 1, gameId: 1 });
  await queue.enqueue({ jobId: 2, gameId: 1 });
  await queue.enqueue({ jobId: 3, gameId: 2 });
  assert.deepEqual(starts, [1]); assert.equal(queue.hasGame(2), true);
  release(); await queue.waitIdle();
  assert.deepEqual(starts, [1, 2, 3]); assert.deepEqual(errors, ["broken"]);
});

test("separate staged installs preserve old files and explicit version metadata", async (t) => {
  const f = await fixture(t);
  f.app.archiveHasSingleRootDirectory = async () => true;
  f.app.extractArchiveWithProgress = (source, target, progress) => ({ completion: (async () => {
    await fs.mkdir(path.join(target, "original"));
    await fs.writeFile(path.join(target, "original", "game.exe"), "new build");
    progress({ currentFile: "game.exe", processedFiles: 1, totalFiles: 1 });
  })(), terminate: async () => {} });
  const old = path.join(f.gameRoot, "Safety Game-1.2");
  await fs.mkdir(old, { recursive: true });
  await fs.writeFile(path.join(old, "save.dat"), "my save");
  await f.app.db.upsertGameFolder(f.game.id, { folderName: path.basename(old), folderPath: old,
    version: "1.2", versionSource: "manual", seasonNumber: 3, seasonFinal: true });
  for (const name of ["first.zip", "second.zip"]) {
    const job = await archive(f, name);
    await f.app.extractJob(job.id, f.game.id, "1.2");
    await f.app.archiveQueue.waitIdle();
    assert.equal(f.app.db.listArchiveJobs().find((row) => row.id === job.id).status, "processed");
  }
  assert.equal(await fs.readFile(path.join(old, "save.dat"), "utf8"), "my save");
  for (const suffix of [" (2)", " (3)"]) {
    const folderPath = old + suffix;
    assert.equal(await fs.readFile(path.join(folderPath, "game.exe"), "utf8"), "new build");
    assert.equal(f.app.db.findGameFolderByPath(f.game.id, folderPath).version, "1.2");
  }
  assert.equal(f.app.db.findGameFolderByPath(f.game.id, old).seasonNumber, 3);
  assert.deepEqual(await fs.readdir(path.join(f.installRoot, ".f95-staging")), []);
});

test("failed staging retains archive and never exposes incomplete installations", async (t) => {
  const f = await fixture(t);
  f.app.archiveHasSingleRootDirectory = async () => false;
  f.app.extractArchiveWithProgress = (source, target) => ({ completion: (async () => {
    await fs.writeFile(path.join(target, "partial.exe"), "partial");
    throw new Error("broken archive");
  })(), terminate: async () => {} });
  const job = await archive(f);
  await f.app.extractJob(job.id, f.game.id, "1.2");
  await f.app.archiveQueue.waitIdle();
  await fs.access(job.archivePath);
  assert.equal(f.app.db.listArchiveJobs()[0].status, "failed");
  assert.equal(f.app.db.listGameFolders(f.game.id).length, 0);
  assert.deepEqual(await fs.readdir(path.join(f.installRoot, ".f95-staging")), []);
});

test("shutdown waits for extraction abort, preserves archive, and saves queued status", async (t) => {
  const f = await fixture(t);
  f.app.archiveHasSingleRootDirectory = async () => false;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  f.app.extractArchiveWithProgress = (source, target, progress, { signal }) => {
    const completion = new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("interrupted"), { name: "AbortError" })), { once: true });
      started();
    });
    return { completion, terminate: async () => { await completion.catch(() => {}); } };
  };
  const job = await archive(f);
  await f.app.extractJob(job.id, f.game.id, "1.2"); await ready;
  await assert.rejects(f.app.deleteGame(f.game.id), /Finish/);
  await assert.rejects(f.app.deleteArchiveFile(job.id), /queued/);
  await assert.rejects(f.app.updateSettings({ installRoot: path.join(f.root, "new") }), /Finish/);
  await Promise.all([f.app.dispose(), f.app.dispose()]);
  await fs.access(job.archivePath);
  assert.equal(f.app.db.listArchiveJobs()[0].status, "queued");
  const reopened = new DatabaseService(f.root); await reopened.initialize();
  assert.equal(reopened.listArchiveJobs()[0].status, "queued"); reopened.db.close();
});

test("HTTP link allowlist and IPC trust boundary reject unsafe inputs", () => {
  for (const url of ["https://example.com", "http://example.com/page"]) assert.equal(isSafeBrowserUrl(url), true);
  for (const url of ["file:///C:/game.exe", "javascript:alert(1)", "steam://run/1", "bad", ""]) assert.equal(isSafeBrowserUrl(url), false);
  const frame = {}, contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  assert.doesNotThrow(() => assertTrustedIpcSender({ sender: contents, senderFrame: frame }, window));
  assert.throws(() => assertTrustedIpcSender({ sender: {}, senderFrame: frame }, window), /untrusted/);
  assert.throws(() => assertTrustedIpcSender({ sender: contents, senderFrame: {} }, window), /untrusted/);
});

test("concurrent download filename reservations avoid collisions and stale partial files", async (t) => {
  const { app, root } = await fixture(t);
  await fs.writeFile(path.join(root, "same.zip.part"), "unfinished");
  const paths = await Promise.all(Array.from({ length: 5 }, () => app.reserveDownloadTargetPath(root, "same.zip")));
  assert.equal(new Set(paths).size, 5);
  assert.equal(paths.includes(path.join(root, "same.zip")), false);
});

test("queue preserves request order even when preparation finishes out of order", async () => {
  let release;
  const prepared = new Promise((resolve) => { release = resolve; });
  const starts = [];
  const queue = new ArchiveQueue({ prepare: ({ jobId }) => jobId === 1 ? prepared : Promise.resolve(), run: async ({ jobId }) => starts.push(jobId) });
  const first = queue.enqueue({ jobId: 1 });
  await queue.enqueue({ jobId: 2 });
  assert.deepEqual(starts, []);
  release(); await first; await queue.waitIdle();
  assert.deepEqual(starts, [1, 2]);
});

test("startup cleanup removes only staging folders owned by this data directory", async (t) => {
  const { app, installRoot, root } = await fixture(t);
  const owned = path.join(installRoot, ".f95-staging", "job-1-00000000-0000-0000-0000-000000000000");
  const foreign = path.join(installRoot, ".f95-staging", "job-2-00000000-0000-0000-0000-000000000000");
  await fs.mkdir(owned, { recursive: true }); await fs.mkdir(foreign);
  await fs.writeFile(path.join(owned, ".f95-owner"), `f95-tracker-staging-v1\n${path.resolve(root)}`);
  await fs.writeFile(path.join(foreign, ".f95-owner"), "another application");
  await app.cleanupStagingDirectories();
  await assert.rejects(fs.access(owned)); await fs.access(foreign);
});

test("shutdown drain waits for an import already committing data", async () => {
  const gate = new OperationGate();
  let release;
  const importWork = gate.runExclusive(() => new Promise((resolve) => { release = resolve; }));
  gate.closed = true;
  let drained = false;
  const drain = gate.drain().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  release(); await importWork; await drain;
  assert.equal(drained, true);
});

test("an archive for a chapter is installed in that chapter's sub-folder", async (t) => {
  const f = await fixture(t);
  f.app.archiveHasSingleRootDirectory = async () => true;
  f.app.extractArchiveWithProgress = (source, target) => ({ completion: (async () => {
    await fs.mkdir(path.join(target, "original"));
    await fs.writeFile(path.join(target, "original", "game.exe"), "chapter build");
  })(), terminate: async () => {} });
  const job = await archive(f, "chapter.zip");
  await f.app.db.updateArchiveJob(job.id, { branch: "Chapter 2" });
  await f.app.extractJob(job.id, f.game.id, "0.5");
  await f.app.archiveQueue.waitIdle();
  const expected = path.join(f.gameRoot, "Chapter 2", "Safety Game-0.5");
  assert.equal(await fs.readFile(path.join(expected, "game.exe"), "utf8"), "chapter build");
  const folder = f.app.db.findGameFolderByPath(f.game.id, expected);
  assert.equal(folder.branch, "Chapter 2");
  assert.equal(folder.version, "0.5");
});
