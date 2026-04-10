const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const childProcess = require("child_process");

test("extractArchiveWithProgress treats a clean worker exit as success even if done arrives late", async () => {
  const originalFork = childProcess.fork;
  const extractorModulePath = require.resolve("../src/main/services/extractor");
  delete require.cache[extractorModulePath];

  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.killed = false;
    }

    send() {
      queueMicrotask(() => {
        this.emit("exit", 0, null);
      });
    }

    kill() {
      this.killed = true;
    }
  }

  childProcess.fork = () => new FakeChild();

  try {
    const { extractArchiveWithProgress } = require("../src/main/services/extractor");
    const handle = extractArchiveWithProgress("C:\\Downloads\\example.rar", "C:\\Games\\Example", () => {});
    await assert.doesNotReject(handle.completion);
  } finally {
    childProcess.fork = originalFork;
    delete require.cache[extractorModulePath];
  }
});
