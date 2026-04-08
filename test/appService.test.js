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
