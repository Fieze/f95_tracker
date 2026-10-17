const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const { PassThrough } = require("node:stream");
const { runSevenZip } = require("../src/main/services/sevenZipRunner");
const { validateArchiveEntry } = require("../src/main/services/extractor");

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 123;
  child.kill = () => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
  return child;
}

test("7zip waits for close and reads final output after exit", async () => {
  const child = fakeProcess();
  const lines = [];
  const handle = runSevenZip("7z", [], { spawnProcess: () => child, onLine: (line) => lines.push(line) });
  let completed = false;
  handle.completion.then(() => { completed = true; });
  child.emit("exit", 0);
  await Promise.resolve();
  assert.equal(completed, false);
  child.stdout.write("100% complete");
  child.stdout.end();
  child.emit("close", 0, null);
  await handle.completion;
  assert.deepEqual(lines, ["100% complete"]);
});

test("7zip rejects an unexpected exit", async () => {
  const child = fakeProcess();
  const handle = runSevenZip("7z", [], { spawnProcess: () => child });
  child.emit("close", 2, null);
  await assert.rejects(handle.completion, /unexpectedly/);
});

test("7zip cancellation waits for process close", async () => {
  const child = fakeProcess();
  let killed = false;
  child.kill = () => { killed = true; };
  const handle = runSevenZip("7z", [], { spawnProcess: () => child });
  const rejection = assert.rejects(handle.completion, /canceled/);
  let ended = false;
  const termination = handle.terminate().then(() => { ended = true; });
  assert.equal(killed, true);
  await Promise.resolve();
  assert.equal(ended, false);
  child.emit("close", null, "SIGTERM");
  await termination;
  await rejection;
});

test("7zip inactivity times out and terminates the process", async () => {
  const child = fakeProcess();
  const handle = runSevenZip("7z", [], { spawnProcess: () => child, stallTimeoutMs: 20 });
  await assert.rejects(handle.completion, /timed out/);
});

test("7zip percentage output resets the inactivity timeout", async () => {
  const child = fakeProcess();
  const handle = runSevenZip("7z", [], { spawnProcess: () => child, stallTimeoutMs: 80 });
  const timer = setInterval(() => child.stdout.write("50%\r"), 15);
  await new Promise((resolve) => setTimeout(resolve, 130));
  clearInterval(timer);
  child.emit("close", 0, null);
  await handle.completion;
});

test("archive entry validation rejects traversal, absolute paths and links", () => {
  for (const value of ["../game.exe", "C:/game.exe", "/game.exe", "folder/../../game.exe", "//server/share", "game.exe:stream"]) {
    assert.throws(() => validateArchiveEntry({ path: value }), /Unsafe/);
  }
  assert.throws(() => validateArchiveEntry({ path: "safe", symbolicLink: "elsewhere" }), /Unsafe/);
  assert.throws(() => validateArchiveEntry({ path: "safe", hardLink: "elsewhere" }), /Unsafe/);
  assert.doesNotThrow(() => validateArchiveEntry({ path: "game/assets/file.png" }));
});
