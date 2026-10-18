const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { AppService } = require("../src/main/services/appService");
const { classifySevenZipFailure } = require("../src/main/services/sevenZipRunner");
const { assertEnoughFreeSpace, stallTimeoutFor } = require("../src/main/services/extractor");

function newService(userDataPath, downloadFetch) {
  return new AppService({
    userDataPath,
    authSession: { cookies: { get: async () => [] } },
    onStateChanged: () => {},
    downloadFetch,
    folderWatcher: { start: async () => {}, stop: async () => {}, ignoreFile: () => {} }
  });
}

async function createService(downloadFetch) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "f95-downloads-"));
  const service = newService(userDataPath, downloadFetch);
  await service.db.initialize();
  await service.updateSettings({
    watchFolder: path.join(userDataPath, "watch"),
    installRoot: path.join(userDataPath, "installs"),
    syncIntervalMinutes: 30
  });
  return { service, userDataPath };
}

function cleanup(t, service, userDataPath) {
  t.after(async () => {
    await service.dispose();
    await fs.rm(userDataPath, { recursive: true, force: true });
  });
}

function brokenResponse(firstChunk, headers) {
  let sent = false;
  const body = new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(firstChunk));
      } else {
        controller.error(new Error("connection reset"));
      }
    }
  });
  return new Response(body, { headers });
}

const FULL = "download payload";
const STRONG_HEADERS = {
  "content-length": String(FULL.length),
  etag: "\"abc123\"",
  "content-disposition": "attachment; filename=\"big.zip\""
};

test("file names are made safe for Windows", async (t) => {
  const { service, userDataPath } = await createService(async () => new Response(""));
  cleanup(t, service, userDataPath);
  assert.equal(service.sanitizeDownloadFileName("NUL.zip"), "_NUL.zip");
  assert.equal(service.sanitizeDownloadFileName("game.zip. "), "game.zip");
  assert.equal(service.sanitizeDownloadFileName("a:b?c.7z"), "a_b_c.7z");
  assert.equal(service.sanitizeDownloadFileName("..."), "");
  assert.equal(service.extractFileNameFromContentDisposition("attachment; filename*=UTF-8''bad%E0%A4%A.zip"), "bad%E0%A4%A.zip");
  assert.equal(service.extractFileNameFromContentDisposition("attachment; filename*=UTF-8''my%20game.zip"), "my game.zip");
});

test("a resume request carries If-Range and the resolved URL", async (t) => {
  const requests = [];
  const { service, userDataPath } = await createService(async (url, init) => {
    requests.push({ url, range: init.headers.range || null, ifRange: init.headers["if-range"] || null });
    if (!init.headers.range) return brokenResponse("download ", STRONG_HEADERS);
    return new Response("payload", { status: 206, headers: { "content-range": "bytes 9-15/16" } });
  });
  cleanup(t, service, userDataPath);
  const job = service.createDownloadJob({ url: "https://host.example/start" });
  const done = await service.startResolvedDownload(job.id, { url: "https://host.example/start" });
  assert.equal(done.status, "completed");
  assert.deepEqual(requests[1], { url: "https://host.example/start", range: "bytes=9-", ifRange: "\"abc123\"" });
  assert.equal(await fs.readFile(done.targetPath, "utf8"), FULL);
});

test("a continuation that starts at the wrong byte is rejected", async (t) => {
  const { service, userDataPath } = await createService(async (url, init) => {
    if (!init.headers.range) return brokenResponse("download ", STRONG_HEADERS);
    return new Response("payload", { status: 206, headers: { "content-range": "bytes 0-6/16" } });
  });
  cleanup(t, service, userDataPath);
  const job = service.createDownloadJob({ url: "https://host.example/start" });
  await assert.rejects(() => service.startResolvedDownload(job.id, { url: "https://host.example/start" }), /connection reset/);
  await assert.rejects(() => fs.access(`${service.getDownloadJob(job.id).targetPath}.part`));
});

test("a canceled download with validators keeps its partial file and the next attempt continues it", async (t) => {
  const ranges = [];
  let calls = 0;
  const { service, userDataPath } = await createService(async (url, init) => {
    ranges.push(init.headers.range || null);
    calls += 1;
    if (init.headers.range) return new Response("payload", { status: 206, headers: { "content-range": "bytes 9-15/16" } });
    if (calls === 1) {
      // The first transfer delivers half the file and then waits until the app aborts it.
      let sent = false;
      const body = new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode("download "));
            return undefined;
          }
          return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
        }
      });
      return new Response(body, { headers: STRONG_HEADERS });
    }
    return new Response(FULL, { headers: STRONG_HEADERS });
  });
  cleanup(t, service, userDataPath);

  const first = service.createDownloadJob({ url: "https://host.example/start" });
  const running = service.startResolvedDownload(first.id, { url: "https://host.example/start" });
  running.catch(() => {});
  for (let waited = 0; service.getDownloadJob(first.id).bytesReceived === 0 && waited < 100; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  service.cancelDownloadJob(first.id, "Download canceled.");
  await assert.rejects(() => running);
  const canceled = service.getDownloadJob(first.id);
  assert.equal(canceled.status, "canceled");
  assert.equal(await fs.readFile(`${canceled.targetPath}.part`, "utf8"), "download ");
  assert.ok(JSON.parse(await fs.readFile(`${canceled.targetPath}.part.json`, "utf8")).etag);

  const second = service.createDownloadJob({ url: "https://host.example/start" });
  const done = await service.startResolvedDownload(second.id, { url: "https://host.example/start" });
  assert.equal(done.targetPath, canceled.targetPath);
  assert.equal(await fs.readFile(done.targetPath, "utf8"), FULL);
  assert.equal(done.sha256, crypto.createHash("sha256").update(FULL).digest("hex"));
  assert.ok(ranges.includes("bytes=9-"));
  await assert.rejects(() => fs.access(`${done.targetPath}.part.json`));
});

test("a download without a length is checked as an archive before it counts as finished", async (t) => {
  const { service, userDataPath } = await createService(async () =>
    new Response("not really a zip", { headers: { "content-disposition": "attachment; filename=\"cut.zip\"" } }));
  cleanup(t, service, userDataPath);
  service.testArchive = async () => { throw new Error("Unexpected end of archive"); };
  const job = service.createDownloadJob({ url: "https://host.example/start" });
  await assert.rejects(() => service.startResolvedDownload(job.id, { url: "https://host.example/start" }), /damaged or incomplete/);
  const failed = service.getDownloadJob(job.id);
  assert.equal(failed.status, "failed");
  await assert.rejects(() => fs.access(failed.targetPath));
  await assert.rejects(() => fs.access(`${failed.targetPath}.part`));
});

test("finished downloads are remembered after a restart and running ones are marked interrupted", async (t) => {
  const { service, userDataPath } = await createService(async () =>
    new Response(FULL, { headers: { "content-length": String(FULL.length), "content-disposition": "attachment; filename=\"kept.zip\"" } }));
  t.after(() => fs.rm(userDataPath, { recursive: true, force: true }));
  const done = service.createDownloadJob({ url: "https://host.example/a" });
  await service.startResolvedDownload(done.id, { url: "https://host.example/a" });
  const running = service.createDownloadJob({ url: "https://host.example/b" });
  await service.dispose();

  const restarted = newService(userDataPath);
  await restarted.db.initialize();
  await restarted.downloadService.loadPersistedJobs();
  const jobs = restarted.listDownloadJobs();
  assert.equal(restarted.getDownloadJob(done.id).status, "completed");
  assert.equal(restarted.getDownloadJob(running.id).status, "canceled");
  assert.equal(restarted.createDownloadJob({ url: "https://host.example/c" }).id, Math.max(...jobs.map((job) => job.id)) + 1);
  await restarted.dispose();
});

test("7-Zip failures are explained", () => {
  assert.equal(classifySevenZipFailure("ERROR: Wrong password : a.txt", "x").code, "ARCHIVE_PASSWORD");
  assert.equal(classifySevenZipFailure("Cannot open encrypted archive. Wrong password?", "x").code, "ARCHIVE_PASSWORD");
  assert.equal(classifySevenZipFailure("ERROR: Missing volume : a.part2.rar", "x").code, "ARCHIVE_INCOMPLETE");
  assert.equal(classifySevenZipFailure("ERROR: There is not enough space on the disk", "x").code, "ARCHIVE_DISK_SPACE");
  assert.equal(classifySevenZipFailure("something else", "fallback").message, "fallback");
});

test("extraction is refused up front when the disk is too small", async () => {
  await assert.rejects(
    () => assertEnoughFreeSpace(os.tmpdir(), Number.MAX_SAFE_INTEGER),
    (error) => error.code === "ARCHIVE_DISK_SPACE" && /Not enough free disk space/.test(error.message)
  );
  await assertEnoughFreeSpace(os.tmpdir(), 1024);
});

test("big archives get a longer inactivity limit", () => {
  assert.equal(stallTimeoutFor(10 * 1024 * 1024), 120000);
  assert.ok(stallTimeoutFor(8 * 1024 * 1024 * 1024) > 120000);
});

test("a processed archive can be kept in an Extracted folder", async (t) => {
  const { service, userDataPath } = await createService(async () => new Response(""));
  cleanup(t, service, userDataPath);
  const watch = path.join(userDataPath, "watch");
  await fs.mkdir(watch, { recursive: true });
  const archive = path.join(watch, "Game-1.0.zip");
  await fs.writeFile(archive, "zip");
  await service.retireArchive(archive, true);
  await assert.rejects(() => fs.access(archive));
  assert.equal(await fs.readFile(path.join(watch, "Extracted", "Game-1.0.zip"), "utf8"), "zip");
  await fs.writeFile(archive, "zip2");
  await service.retireArchive(archive, true);
  assert.equal(await fs.readFile(path.join(watch, "Extracted", "Game-1.0 (1).zip"), "utf8"), "zip2");
  await fs.writeFile(archive, "zip3");
  await service.retireArchive(archive, false);
  await assert.rejects(() => fs.access(archive));
});
