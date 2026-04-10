const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveSevenZipBinary, resolveSevenZipSupportFiles } = require("../src/main/services/sevenZip");

test("resolveSevenZipBinary prefers bundled resource in app root", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "f95-sevenzip-"));
  const resourceDir = path.join(tempDir, "resources", "tools", "7zip");
  const binaryName = process.platform === "win32" ? "7z.exe" : "7za";
  const binaryPath = path.join(resourceDir, binaryName);

  await fs.promises.mkdir(resourceDir, { recursive: true });
  await fs.promises.writeFile(binaryPath, "stub");

  assert.equal(resolveSevenZipBinary({ appRoot: tempDir }), binaryPath);

  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test("resolveSevenZipBinary prefers bundled 7z.exe over a system installation on Windows", async () => {
  if (process.platform !== "win32") {
    return;
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "f95-sevenzip-pref-"));
  const resourceDir = path.join(tempDir, "resources", "tools", "7zip");
  const bundledPath = path.join(resourceDir, "7z.exe");
  const systemDir = path.join(tempDir, "system");
  const systemPath = path.join(systemDir, "7z.exe");

  await fs.promises.mkdir(resourceDir, { recursive: true });
  await fs.promises.mkdir(systemDir, { recursive: true });
  await fs.promises.writeFile(bundledPath, "stub-7z-bundled");
  await fs.promises.writeFile(systemPath, "stub-7z");

  assert.equal(
    resolveSevenZipBinary({
      appRoot: tempDir,
      systemBinaryCandidates: [systemPath]
    }),
    bundledPath
  );

  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test("resolveSevenZipBinary falls back to a system 7z.exe when the bundle is missing on Windows", async () => {
  if (process.platform !== "win32") {
    return;
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "f95-sevenzip-system-"));
  const systemDir = path.join(tempDir, "system");
  const systemPath = path.join(systemDir, "7z.exe");

  await fs.promises.mkdir(systemDir, { recursive: true });
  await fs.promises.writeFile(systemPath, "stub-7z");

  assert.equal(
    resolveSevenZipBinary({
      appRoot: tempDir,
      systemBinaryCandidates: [systemPath]
    }),
    systemPath
  );

  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test("resolveSevenZipSupportFiles returns bundled 7z.dll for 7z.exe on Windows", async () => {
  if (process.platform !== "win32") {
    return;
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "f95-sevenzip-dll-"));
  const resourceDir = path.join(tempDir, "resources", "tools", "7zip");
  const binaryPath = path.join(resourceDir, "7z.exe");
  const dllPath = path.join(resourceDir, "7z.dll");

  await fs.promises.mkdir(resourceDir, { recursive: true });
  await fs.promises.writeFile(binaryPath, "stub-7z");
  await fs.promises.writeFile(dllPath, "stub-dll");

  assert.deepEqual(resolveSevenZipSupportFiles({ appRoot: tempDir }), [dllPath]);

  await fs.promises.rm(tempDir, { recursive: true, force: true });
});
