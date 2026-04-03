const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveSevenZipBinary } = require("../src/main/services/sevenZip");

test("resolveSevenZipBinary prefers bundled resource in app root", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "f95-sevenzip-"));
  const resourceDir = path.join(tempDir, "resources", "tools", "7zip");
  const binaryName = process.platform === "win32" ? "7za.exe" : "7za";
  const binaryPath = path.join(resourceDir, binaryName);

  await fs.promises.mkdir(resourceDir, { recursive: true });
  await fs.promises.writeFile(binaryPath, "stub");

  assert.equal(resolveSevenZipBinary({ appRoot: tempDir }), binaryPath);

  await fs.promises.rm(tempDir, { recursive: true, force: true });
});
