const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { AppService } = require("../src/main/services/appService");

async function createService() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "f95-app-service-"));
  const service = new AppService({
    userDataPath,
    authSession: {
      cookies: {
        get: async () => []
      }
    },
    onStateChanged: () => {}
  });
  await service.db.initialize();
  return { service, userDataPath };
}

test("inferInstalledVersionFromFolder returns improved versions for common folder formats", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  assert.equal(
    service.inferInstalledVersionFromFolder("D:\\Games\\Example Game\\Example Game Ep.1-29").inferredVersion,
    "Ep.1-29"
  );
  assert.equal(
    service.inferInstalledVersionFromFolder("D:\\Games\\Example Game\\Example Game v0.15.1a").inferredVersion,
    "0.15.1a"
  );
});

test("createBackup keeps only the newest three backups", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  for (let index = 0; index < 4; index += 1) {
    await service.createBackup();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const files = await fs.readdir(path.join(userDataPath, "backups"));
  assert.equal(files.filter((name) => name.endsWith(".json")).length, 3);
});

test("listLaunchExecutables only scans direct .exe files and recommends the best match", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const folderPath = path.join(userDataPath, "Away From Home", "Away From Home-0.10");
  await fs.mkdir(path.join(folderPath, "bin"), { recursive: true });
  await fs.writeFile(path.join(folderPath, "Away From Home.exe"), "");
  await fs.writeFile(path.join(folderPath, "UnityCrashHandler64.exe"), "");
  await fs.writeFile(path.join(folderPath, "bin", "NestedGame.exe"), "");

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/away-from-home.1234/",
    title: "Away From Home",
    threadTitle: "Away From Home [v0.10]",
    currentVersion: "0.10",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: ["AFH"],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  await service.db.replaceGameFolders(game.id, [
    {
      folderName: path.basename(folderPath),
      folderPath,
      version: "0.10",
      versionSource: "inferred"
    }
  ]);

  const folders = service.db.listGameFolders(game.id);
  const result = await service.listLaunchExecutables({ folderId: folders[0].id });

  assert.deepEqual(
    result.executables.map((entry) => entry.fileName),
    ["Away From Home.exe", "UnityCrashHandler64.exe"]
  );
  assert.equal(result.executables[0].isRecommended, true);
});

test("launchExecutable rejects paths outside the selected folder root", async (t) => {
  const { service, userDataPath } = await createService();
  t.after(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const folderPath = path.join(userDataPath, "Away From Home", "Away From Home-0.10");
  const nestedPath = path.join(folderPath, "bin", "Away From Home.exe");
  await fs.mkdir(path.dirname(nestedPath), { recursive: true });
  await fs.writeFile(nestedPath, "");

  const game = await service.db.upsertGameFromThread({
    sourceUrl: "https://f95zone.to/threads/away-from-home.9999/",
    title: "Away From Home",
    threadTitle: "Away From Home",
    currentVersion: "0.10",
    developer: "Dev",
    engine: "Ren'Py",
    threadStatus: "Ongoing",
    overview: "",
    releaseDate: "",
    changelog: "",
    bannerImage: null,
    screenshotImages: [],
    tags: [],
    warnings: [],
    aliases: [],
    rawOpHtml: "",
    rawOpText: "",
    parserDebug: {},
    downloadGroups: []
  });

  await service.db.replaceGameFolders(game.id, [
    {
      folderName: path.basename(folderPath),
      folderPath,
      version: "0.10",
      versionSource: "inferred"
    }
  ]);

  const folders = service.db.listGameFolders(game.id);

  await assert.rejects(
    service.launchExecutable({
      folderId: folders[0].id,
      executablePath: nestedPath
    }),
    /directly inside the selected game folder/i
  );
});
