const { spawn } = require("child_process");

function runSevenZip(binary, args, { onLine, onActivity, signal, stallTimeoutMs = 120000, spawnProcess = spawn } = {}) {
  let child;
  let failure;
  let watchdog;
  let finished = false;
  let terminatePromise;
  let resolveTermination;
  const buffers = { stdout: "", stderr: "" };
  let stderr = "";
  const completion = new Promise((resolve, reject) => {
    child = spawnProcess(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = (error) => {
      if (finished) return;
      failure ||= error;
      clearTimeout(watchdog);
      child.kill();
    };
    const abort = () => stop(Object.assign(new Error("Archive extraction canceled."), { name: "AbortError" }));
    const activity = () => {
      if (failure || finished) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => stop(new Error("Archive extraction timed out.")), stallTimeoutMs);
      onActivity?.();
    };
    const consume = (kind, chunk) => {
      activity();
      buffers[kind] += chunk.toString();
      const lines = buffers[kind].split(/[\r\n\b]+/);
      buffers[kind] = lines.pop() || "";
      for (const line of lines) {
        if (kind === "stderr") stderr = `${stderr}${line}\n`.slice(-16000);
        try { onLine?.(line, kind); } catch (error) { stop(error); }
      }
    };
    child.stdout.on("data", (chunk) => consume("stdout", chunk));
    child.stderr.on("data", (chunk) => consume("stderr", chunk));
    child.on("error", (error) => { failure ||= error; });
    child.on("close", (code, exitSignal) => {
      for (const [kind, remainder] of Object.entries(buffers)) {
        if (remainder) {
          try { onLine?.(remainder, kind); } catch (error) { failure ||= error; }
        }
      }
      finished = true;
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", abort);
      resolveTermination?.();
      if (failure) reject(failure);
      else if (code === 0 && !exitSignal) resolve();
      else reject(new Error(stderr.trim() || `7z exited unexpectedly (${exitSignal || code}).`));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else activity();
  });
  return {
    completion,
    get pid() { return child?.pid; },
    terminate() {
      if (finished) return Promise.resolve();
      if (!terminatePromise) {
        terminatePromise = new Promise((resolve) => { resolveTermination = resolve; });
        failure ||= Object.assign(new Error("Archive extraction canceled."), { name: "AbortError" });
        clearTimeout(watchdog);
        child.kill();
      }
      return terminatePromise;
    }
  };
}

module.exports = { runSevenZip };
