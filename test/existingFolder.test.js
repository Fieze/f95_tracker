const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { AppService } = require("../src/main/services/appService");

const threadUrl = "https://f95zone.to/threads/example-game.1/";
const exists = (target) => fs.access(target).then(() => true, () => false);

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f95-existing-"));
  const html = await fs.readFile(path.join(__dirname, "fixtures", "threads", "renpy-logged-in.html"), "utf8");
  const service = new AppService({
    userDataPath: path.join(root, "userdata"),
    authSession: { cookies: { get: async () => [] }, fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }) },
    folderWatcher: { start: async () => {}, stop: async () => {}, ignoreFile: () => {} },
    onStateChanged: () => {},
    fetcherOptions: { minIntervalMs: 0, jitterMs: 0 }
  });
  await service.db.initialize();
  const dirs = { root, installRoot: path.join(root, "installs"), watchFolder: path.join(root, "watch"), library: path.join(root, "My Games") };
  await fs.mkdir(dirs.library, { recursive: true });
  await service.updateSettings({ watchFolder: dirs.watchFolder, installRoot: dirs.installRoot, syncIntervalMinutes: 30 });
  t.after(async () => {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const game = await service.addThread(threadUrl);
  const makeFolder = async (name) => {
    const folder = path.join(dirs.library, name);
    await fs.mkdir(path.join(folder, "game"), { recursive: true });
    await fs.writeFile(path.join(folder, "game", "data.txt"), "content");
    await fs.writeFile(path.join(folder, "Game.exe"), "exe");
    return folder;
  };
  return { service, game, dirs, makeFolder };
}

const waitForActivity = async (service, predicate) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const found = (await service.getState()).activities.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("activity did not reach the expected state");
};

test("an existing folder can be added where it is", async (t) => {
  const { service, game, makeFolder } = await setup(t);
  const folder = await makeFolder("Example Game v0.1.4.0");
  const updated = await service.addExistingFolder({ folderPath: folder, gameId: game.id, mode: "keep" });
  assert.ok(await exists(path.join(folder, "Game.exe")), "files stay in place");
  assert.deepEqual(updated.folders.map((entry) => entry.folderPath), [folder]);
  assert.equal(updated.folders[0].version, "0.1.4.0");
  assert.equal(updated.installedVersion, "0.1.4.0");
});

test("an existing folder can be moved into the install root under the game's folder", async (t) => {
  const { service, game, dirs, makeFolder } = await setup(t);
  const folder = await makeFolder("Example Game v0.1.3");
  const updated = await service.addExistingFolder({ folderPath: folder, gameId: game.id, mode: "move" });
  const expected = path.join(dirs.installRoot, "Example Game", "Example Game v0.1.3");
  assert.equal(await exists(folder), false, "source folder is gone");
  assert.equal(await fs.readFile(path.join(expected, "game", "data.txt"), "utf8"), "content");
  assert.deepEqual(updated.folders.map((entry) => entry.folderPath), [expected]);
});

test("moving refuses an existing destination and leaves the source untouched", async (t) => {
  const { service, game, dirs, makeFolder } = await setup(t);
  const folder = await makeFolder("Same Name");
  await fs.mkdir(path.join(dirs.installRoot, "Example Game", "Same Name"), { recursive: true });
  await assert.rejects(() => service.addExistingFolder({ folderPath: folder, gameId: game.id, mode: "move" }), /already exists/);
  assert.ok(await exists(path.join(folder, "Game.exe")));
});

test("unsafe folders are rejected", async (t) => {
  const { service, game, dirs, makeFolder } = await setup(t);
  const check = (folderPath, mode, pattern) => assert.rejects(() => service.validateExistingFolder(folderPath, mode), pattern);

  await check(path.parse(dirs.root).root, "keep", /drive root|contains the/);
  await check(dirs.root, "keep", /contains the install root/);
  await check(path.join(dirs.root, "does-not-exist"), "keep", /does not exist/);
  await check("relative/path", "keep", /Choose a folder/);
  await fs.mkdir(dirs.watchFolder, { recursive: true });
  await check(dirs.watchFolder, "keep", /watch folder/);

  const folder = await makeFolder("Registered Game");
  await service.addExistingFolder({ folderPath: folder, gameId: game.id, mode: "keep" });
  await check(folder, "keep", /already part of "Example Game"/);
  await check(path.join(folder, "game"), "keep", /already part of/);

  const linked = await makeFolder("Has Link");
  const target = path.join(dirs.root, "elsewhere");
  await fs.mkdir(target);
  await fs.symlink(target, path.join(linked, "link"), "junction");
  await check(linked, "move", /symbolic links or junctions/);
  await service.validateExistingFolder(linked, "keep").catch(() => assert.fail("keeping a folder with a link inside is allowed"));
});

test("moving needs an install root", async (t) => {
  const { service, makeFolder } = await setup(t);
  await service.updateSettings({ watchFolder: "", installRoot: "", syncIntervalMinutes: 30 });
  const folder = await makeFolder("No Root");
  await assert.rejects(() => service.validateExistingFolder(folder, "move"), /install root/i);
});

test("background add reports through activities, creating the game from a thread URL when needed", async (t) => {
  const { service, dirs, makeFolder } = await setup(t);
  const folder = await makeFolder("Brand New v1");
  await assert.rejects(() => service.addExistingFolderInBackground({ folderPath: folder, mode: "keep", threadUrl: "nonsense" }), /thread/i);

  const result = await service.addExistingFolderInBackground({ folderPath: folder, mode: "move", gameId: null, threadUrl: "https://f95zone.to/threads/example-two.2/" });
  assert.equal(result.queued, true);
  const duplicate = await service.addExistingFolderInBackground({ folderPath: folder, mode: "move", threadUrl: "https://f95zone.to/threads/example-two.2/" });
  assert.equal(duplicate.duplicate, true);

  const done = await waitForActivity(service, (entry) => entry.kind === "add-folder" && entry.status !== "running");
  assert.equal(done.status, "done", done.message);
  assert.match(done.message, /Moved Brand New v1/);
  assert.ok(await exists(path.join(dirs.installRoot, "Example Game", "Brand New v1", "Game.exe")));
});

test("a failed background move shows the error and keeps the folder", async (t) => {
  const { service, game, dirs, makeFolder } = await setup(t);
  const folder = await makeFolder("Blocked");
  await fs.mkdir(path.join(dirs.installRoot, "Example Game", "Blocked"), { recursive: true });
  await service.addExistingFolderInBackground({ folderPath: folder, mode: "move", gameId: game.id });
  const failed = await waitForActivity(service, (entry) => entry.kind === "add-folder" && entry.status === "error");
  assert.match(failed.message, /already exists/);
  assert.ok(await exists(path.join(folder, "Game.exe")));
});

test("no game folder is created until a move is confirmed", async (t) => {
  const { service, game, dirs, makeFolder } = await setup(t);
  const gameRoot = path.join(dirs.installRoot, "Example Game");
  assert.equal(await exists(gameRoot), false, "adding a game must not create its install folder");
  await service.refreshGame(game.id);
  await service.refreshAllGames();
  assert.equal(await exists(gameRoot), false, "refreshing must not create it either");

  const kept = await makeFolder("Kept Here");
  await service.addExistingFolder({ folderPath: kept, gameId: game.id, mode: "keep" });
  assert.equal(await exists(gameRoot), false, "adding a folder in place must not create it");

  const moved = await makeFolder("Moved Over");
  await service.addExistingFolder({ folderPath: moved, gameId: game.id, mode: "move" });
  assert.ok(await exists(path.join(gameRoot, "Moved Over", "Game.exe")), "confirmed move creates the folder");
});

test("a folder that already sits in the install root is moved into the game's subfolder", async (t) => {
  const { service, game, dirs } = await setup(t);
  const loose = path.join(dirs.installRoot, "loose_game-1.0-pc");
  await fs.mkdir(path.join(loose, "game"), { recursive: true });
  await fs.writeFile(path.join(loose, "Game.exe"), "exe");

  const updated = await service.addExistingFolder({ folderPath: loose, gameId: game.id, mode: "move" });
  const expected = path.join(dirs.installRoot, "Example Game", "loose_game-1.0-pc");
  assert.equal(await exists(loose), false);
  assert.ok(await exists(path.join(expected, "Game.exe")));
  assert.deepEqual(updated.folders.map((entry) => entry.folderPath), [expected]);
});

test("a folder already inside the game's folder is simply added; the game's own folder is refused", async (t) => {
  const { service, game, dirs } = await setup(t);
  const gameRoot = path.join(dirs.installRoot, "Example Game");
  const inside = path.join(gameRoot, "Version 1");
  await fs.mkdir(inside, { recursive: true });
  await fs.writeFile(path.join(inside, "Game.exe"), "exe");

  await assert.rejects(() => service.validateExistingFolder(gameRoot, "move", game), /install folder of "Example Game" itself/);
  const updated = await service.addExistingFolder({ folderPath: inside, gameId: game.id, mode: "move" });
  assert.ok(await exists(path.join(inside, "Game.exe")), "nothing was moved");
  assert.deepEqual(updated.folders.map((entry) => entry.folderPath), [inside]);
});

test("a version chosen in the dialog overrides the one guessed from the folder name", async (t) => {
  const { service, game, makeFolder } = await setup(t);
  const folder = await makeFolder("Example Game v0.1.4.0");
  const updated = await service.addExistingFolder({ folderPath: folder, gameId: game.id, mode: "keep", version: "0.2" });
  assert.equal(updated.folders[0].version, "0.2");
});

test("dropped items are classified and matched to a library game by name", async (t) => {
  const { service, game, dirs, makeFolder } = await setup(t);
  const folder = await makeFolder("Example Game v0.1.3");
  const archive = path.join(dirs.library, "Example Game v0.1.3.zip");
  const other = path.join(dirs.library, "notes.txt");
  await fs.writeFile(archive, "zip");
  await fs.writeFile(other, "text");
  const items = await service.inspectDroppedPaths([folder, archive, other, "relative/path"]);
  assert.deepEqual(items.map((item) => item.kind), ["folder", "archive", "unsupported"]);
  assert.equal(items[0].gameId, game.id);
  assert.equal(items[0].version, "0.1.3");
  assert.equal(items[1].gameId, game.id);
});

test("a dropped archive is registered for the game and stays where it is", async (t) => {
  const { service, game, dirs } = await setup(t);
  const archive = path.join(dirs.library, "Example Game v0.1.3.zip");
  await fs.writeFile(archive, "not really a zip");
  const result = await service.addDroppedArchiveInBackground({ archivePath: archive, gameId: game.id, version: "0.1.3", extract: false });
  assert.equal(result.queued, true);
  await waitForActivity(service, (activity) => activity.id === result.activityId && activity.status === "done");
  const jobs = (await service.getState()).archiveJobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].gameId, game.id);
  assert.equal(jobs[0].detectedVersion, "0.1.3");
  assert.ok(await exists(archive), "the original archive is untouched");
  await assert.rejects(() => service.addDroppedArchiveInBackground({ archivePath: path.join(dirs.library, "x.txt"), gameId: game.id }), /ZIP, RAR and 7z/);
});

test("a folder moved with a chapter lands in that chapter's sub-folder and is found again by the folder scan", async (t) => {
  const { service, game, dirs, makeFolder } = await setup(t);
  const folder = await makeFolder("Example Game v0.2");
  const updated = await service.addExistingFolder({ folderPath: folder, gameId: game.id, mode: "move", branch: "Chapter 2" });
  const expected = path.join(dirs.installRoot, "Example Game", "Chapter 2", "Example Game v0.2");
  assert.equal(await exists(expected), true);
  assert.deepEqual(updated.folders.map((entry) => [entry.folderPath, entry.branch]), [[expected, "Chapter 2"]]);
  assert.equal(updated.hasSeasons, true, "numbered branches turn on the season ordering");

  // A second folder dropped into another branch directory by hand is picked up with its branch.
  const manual = path.join(dirs.installRoot, "Example Game", "Christmas Special", "Example Game v1.0");
  await fs.mkdir(manual, { recursive: true });
  await service.syncGameFolders(game.id);
  const synced = (await service.getState()).games.find((entry) => entry.id === game.id);
  assert.deepEqual(
    synced.folders.map((entry) => entry.branch).sort(),
    ["Chapter 2", "Christmas Special"]
  );
  assert.deepEqual(synced.branches, ["Chapter 2", "Christmas Special"]);
});

test("a split archive cannot be dropped in", async (t) => {
  const { service, game, dirs } = await setup(t);
  const archive = path.join(dirs.library, "Example Game v1.0.part1.rar");
  await fs.writeFile(archive, "x");
  await assert.rejects(() => service.addDroppedArchiveInBackground({ archivePath: archive, gameId: game.id }), /Split archives/);
  const [item] = await service.inspectDroppedPaths([archive]);
  assert.equal(item.split, true);
});

test("branches can be added, finished, renamed and removed, and report their update state", async (t) => {
  const { service, game, makeFolder } = await setup(t);
  const folder = await makeFolder("Example Game v0.1");
  await service.addExistingFolder({ folderPath: folder, gameId: game.id, mode: "keep", branch: "Chapter 1" });
  let updated = await service.updateGameBranches(game.id, { action: "add", label: "Chapter 2" });
  assert.deepEqual(updated.branches, ["Chapter 1", "Chapter 2"]);
  updated = await service.updateGameBranches(game.id, { action: "rename", label: "Chapter 2", newLabel: "Chapter 3" });
  assert.deepEqual(updated.branches, ["Chapter 1", "Chapter 3"]);
  updated = await service.updateGameBranches(game.id, { action: "final", label: "Chapter 1", final: true });
  assert.equal(updated.branchStates.find((entry) => entry.branch === "Chapter 1").final, true);
  await assert.rejects(() => service.updateGameBranches(game.id, { action: "remove", label: "Chapter 1" }), /installed folders/);
  updated = await service.updateGameBranches(game.id, { action: "remove", label: "Chapter 3" });
  assert.deepEqual(updated.branches, ["Chapter 1"]);
});
