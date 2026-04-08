const test = require("node:test");
const assert = require("node:assert/strict");
const { AppService } = require("../src/main/services/appService");

function createService() {
  return new AppService({
    userDataPath: "C:\\temp\\f95-test",
    authSession: {
      cookies: {
        get: async () => []
      }
    },
    onStateChanged: () => {}
  });
}

test("inferInstalledVersionFromFolder returns improved versions for common folder formats", () => {
  const service = createService();

  assert.equal(
    service.inferInstalledVersionFromFolder("D:\\Games\\Example Game\\Example Game Ep.1-29").inferredVersion,
    "Ep.1-29"
  );
  assert.equal(
    service.inferInstalledVersionFromFolder("D:\\Games\\Example Game\\Example Game v0.15.1a").inferredVersion,
    "0.15.1a"
  );
});
