const { spawn } = require("child_process");

// Turns 7-Zip's free-form complaints into errors the UI can explain; unknown output is passed through unchanged.
function classifySevenZipFailure(output, fallback) {
  const text = String(output || "");
  if (/wrong password|enter password|cannot open encrypted archive|data error in encrypted file/i.test(text)) {
    return Object.assign(new Error("This archive is password protected. Enter the password to extract it."), { code: "ARCHIVE_PASSWORD" });
  }
  if (/missing volume|cannot find volume|unexpected end of archive|unexpected end of data/i.test(text)) {
    return Object.assign(new Error("The archive is incomplete, or a part of a multi-part archive is missing."), { code: "ARCHIVE_INCOMPLETE" });
  }
  if (/no space left|not enough space|disk full|there is not enough space on the disk/i.test(text)) {
    return Object.assign(new Error("The disk ran out of space while extracting."), { code: "ARCHIVE_DISK_SPACE" });
  }
  return new Error(fallback);
}

function runSevenZip(binary, args, { onLine, onActivity, signal, stallTimeoutMs = 120000, spawnProcess = spawn } = {}) {
  let child;
  let failure;
  let watchdog;
  let finished = false;
  let terminatePromise;
  let resolveTermination;
  const buffers = { stdout: "", stderr: "" };
  let stderr = "";
  let output = "";
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
      watchdog = setTimeout(() => stop(Object.assign(new Error("Archive extraction timed out: 7-Zip showed no activity for " + Math.max(1, Math.round(stallTimeoutMs / 60000)) + " minute(s)."), { code: "ARCHIVE_STALLED" })), stallTimeoutMs);
      onActivity?.();
    };
    const consume = (kind, chunk) => {
      activity();
      buffers[kind] += chunk.toString();
      const lines = buffers[kind].split(/[\r\n\b]+/);
      buffers[kind] = lines.pop() || "";
      for (const line of lines) {
        output = (output + line + "\n").slice(-16000);
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
      else reject(classifySevenZipFailure(output, stderr.trim() || `7z exited unexpectedly (${exitSignal || code}).`));
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

module.exports = { runSevenZip, classifySevenZipFailure };
