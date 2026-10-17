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
  await check(path.join(dirs.installRoot, "Example Game"), "move", /already inside the install root/);

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
