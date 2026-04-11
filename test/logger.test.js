const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { Logger } = require("../src/main/services/logger");

async function listRotatedLogs(dirPath) {
  const entries = await fs.readdir(dirPath);
  return entries
    .filter((entry) => /^app-log-[0-9T:-]+Z(?:-\d+)?\.txt$/i.test(entry))
    .sort();
}

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
  const rotatedNames = await listRotatedLogs(tempDir);
  const rotatedContents = await Promise.all(rotatedNames.map((entry) => fs.readFile(path.join(tempDir, entry), "utf8")));

  assert.match(currentLog, /third/);
  assert.equal(rotatedContents.length, 2);
  assert.ok(rotatedNames.every((entry) => /app-log-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?\.txt/i.test(entry)));
  assert.ok(rotatedContents.some((content) => /first/.test(content)));
  assert.ok(rotatedContents.some((content) => /second/.test(content)));
});

test("child loggers share the same rotation queue", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "f95-app-logger-child-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const filePath = path.join(tempDir, "app-log.txt");
  const rootLogger = new Logger({
    filePath,
    maxFileSizeBytes: 220,
    maxRotatedFiles: 2
  });
  const childLogger = rootLogger.child("service");

  await rootLogger.initialize();
  await rootLogger.info("root-entry", { payload: "a".repeat(80) });
  await childLogger.info("child-entry", { payload: "b".repeat(80) });

  const currentLog = await fs.readFile(filePath, "utf8");
  const rotatedNames = await listRotatedLogs(tempDir);
  const rotatedOne = await fs.readFile(path.join(tempDir, rotatedNames[0]), "utf8");

  assert.match(currentLog, /\[app:service\] child-entry/);
  assert.match(rotatedOne, /\[app\] root-entry/);
});

test("logger keeps only the configured number of rotated files", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "f95-app-logger-prune-"));
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
  await logger.info("one", { payload: "a".repeat(80) });
  await logger.info("two", { payload: "b".repeat(80) });
  await logger.info("three", { payload: "c".repeat(80) });
  await logger.info("four", { payload: "d".repeat(80) });

  const rotatedNames = await listRotatedLogs(tempDir);
  const rotatedContents = await Promise.all(rotatedNames.map((entry) => fs.readFile(path.join(tempDir, entry), "utf8")));

  assert.equal(rotatedNames.length, 2);
  assert.ok(rotatedContents.some((content) => /two/.test(content)));
  assert.ok(rotatedContents.some((content) => /three/.test(content)));
  assert.ok(rotatedContents.every((content) => !/one/.test(content)));
});
