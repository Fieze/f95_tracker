const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { SyncScheduler } = require("../src/main/services/syncScheduler");
const { DatabaseService } = require("../src/main/services/db");

test("scheduler logs failures and backs off exponentially", async () => {
  const warnings = [];
  const scheduler = new SyncScheduler({
    onTick: async () => { throw new Error("offline"); },
    logger: { warn: async (message, details) => warnings.push({ message, details }) }
  });
  scheduler.baseIntervalMs = 60_000;
  await scheduler.tick();
  assert.equal(scheduler.failures, 1);
  await scheduler.tick();
  assert.equal(scheduler.failures, 2);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[1].details.consecutiveFailures, 2);
  scheduler.stop();
  assert.equal(scheduler.timer, null);
});

test("scheduler resets backoff after a successful tick", async () => {
  let fail = true;
  const scheduler = new SyncScheduler({ onTick: async () => { if (fail) throw new Error("x"); } });
  scheduler.baseIntervalMs = 60_000;
  await scheduler.tick();
  fail = false;
  await scheduler.tick();
  assert.equal(scheduler.failures, 0);
  scheduler.stop();
});

test("concurrent persist calls are coalesced and the file holds the latest state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "f95-persist-"));
  const db = new DatabaseService(dir);
  await db.initialize();
  let writes = 0;
  const original = db.enqueueWrite.bind(db);
  db.enqueueWrite = (op) => { writes += 1; return original(op); };
  const calls = [db.persist(), db.persist(), db.persist()];
  db.db.run("INSERT INTO settings (key, value) VALUES ('probe', 'latest')");
  await Promise.all([...calls, db.persist()]);
  assert.ok(writes <= 2, `expected coalesced writes, got ${writes}`);
  const reopened = new DatabaseService(dir);
  await reopened.initialize();
  assert.equal(reopened.first("SELECT value FROM settings WHERE key = 'probe'").value, "latest");
});

const baseThread = (overrides) => ({
  sourceUrl: "https://f95zone.to/threads/history-game.555/",
  threadId: "555",
  title: "History Game",
  threadTitle: "History Game [v1.0]",
  currentVersion: "1.0",
  warnings: [],
  developer: "Dev",
  engine: "Ren'Py",
  threadStatus: "Ongoing",
  overview: "",
  releaseDate: "2026-01-01",
  changelog: "",
  bannerImage: null,
  screenshotImages: [],
  rawOpHtml: "",
  rawOpText: "",
  parserDebug: {},
  tags: [],
  downloadGroups: [],
  ...overrides
});

test("game history records version changes once and survives export/import", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "f95-history-"));
  const db = new DatabaseService(dir);
  await db.initialize();
  await db.upsertGameFromThread(baseThread({ changelog: "first" }));
  await db.upsertGameFromThread(baseThread({ changelog: "first" }));
  const updated = await db.upsertGameFromThread(baseThread({ currentVersion: "1.1", changelog: "added things" }));
  assert.deepEqual(updated.history.map((entry) => [entry.previousVersion, entry.version]), [["1.0", "1.1"], [null, "1.0"]]);
  assert.equal(updated.history[0].changelog, "added things");

  const snapshot = db.exportSnapshot();
  assert.equal(snapshot.tables.game_history.length, 2);
  await db.importSnapshot(snapshot);
  assert.equal(db.getGames()[0].history.length, 2);

  delete snapshot.tables.game_history;
  await db.importSnapshot(snapshot);
  assert.equal(db.getGames()[0].history.length, 0);
});
