const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { Logger } = require("../src/main/services/logger");

test("logger rotates files when the max size is exceeded", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "f95-app-logger-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const filePath = path.join(tempDir, "app-log.txt");
  const logger = new Logger({
    filePath,
    maxFileSizeBytes: 140,
    maxRotatedFiles: 2
  });

  await logger.initialize();
  await logger.info("first", { payload: "x".repeat(80) });
  await logger.info("second", { payload: "y".repeat(80) });
  await logger.info("third", { payload: "z".repeat(80) });

  const currentLog = await fs.readFile(filePath, "utf8");
  const rotatedOne = await fs.readFile(`${filePath}.1`, "utf8");
  const rotatedTwo = await fs.readFile(`${filePath}.2`, "utf8");

  assert.match(currentLog, /third/);
  assert.match(rotatedOne, /second/);
  assert.match(rotatedTwo, /first/);
});

test("child loggers share the same rotation queue", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "f95-app-logger-child-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const filePath = path.join(tempDir, "app-log.txt");
  const rootLogger = new Logger({
    filePath,
    maxFileSizeBytes: 160,
    maxRotatedFiles: 2
  });
  const childLogger = rootLogger.child("service");

  await rootLogger.initialize();
  await rootLogger.info("root-entry", { payload: "a".repeat(80) });
  await childLogger.info("child-entry", { payload: "b".repeat(80) });

  const currentLog = await fs.readFile(filePath, "utf8");
  const rotatedOne = await fs.readFile(`${filePath}.1`, "utf8");

  assert.match(currentLog, /\[app:service\] child-entry/);
  assert.match(rotatedOne, /\[app\] root-entry/);
});
