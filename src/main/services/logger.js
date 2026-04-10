const fs = require("fs/promises");
const path = require("path");

const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024;
const DEFAULT_MAX_ROTATED_FILES = 5;

class Logger {
  constructor({ filePath, scope = "app", state, maxFileSizeBytes, maxRotatedFiles } = {}) {
    this.filePath = filePath ? path.resolve(filePath) : "";
    this.scope = scope;
    this.maxFileSizeBytes = Number.isFinite(maxFileSizeBytes) ? Number(maxFileSizeBytes) : DEFAULT_MAX_FILE_SIZE_BYTES;
    this.maxRotatedFiles = Number.isFinite(maxRotatedFiles) ? Number(maxRotatedFiles) : DEFAULT_MAX_ROTATED_FILES;
    this.state = state || { writeQueue: Promise.resolve() };
  }

  child(scope) {
    const childScope = [this.scope, scope].filter(Boolean).join(":");
    return new Logger({
      filePath: this.filePath,
      scope: childScope,
      state: this.state,
      maxFileSizeBytes: this.maxFileSizeBytes,
      maxRotatedFiles: this.maxRotatedFiles
    });
  }

  async initialize() {
    if (!this.filePath) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.append("INFO", "Logger initialized.");
  }

  info(message, details) {
    return this.append("INFO", message, details);
  }

  warn(message, details) {
    return this.append("WARN", message, details);
  }

  error(message, details) {
    return this.append("ERROR", message, details);
  }

  append(level, message, details) {
    if (!this.filePath) {
      return Promise.resolve();
    }

    const line = this.formatLine(level, message, details);
    this.state.writeQueue = this.state.writeQueue
      .then(async () => {
        await this.rotateIfNeeded(Buffer.byteLength(line, "utf8"));
        await fs.appendFile(this.filePath, line, "utf8");
      })
      .catch(() => {});
    return this.state.writeQueue;
  }

  async rotateIfNeeded(incomingBytes = 0) {
    if (!this.filePath || this.maxFileSizeBytes <= 0 || this.maxRotatedFiles < 1) {
      return;
    }

    const stats = await fs.stat(this.filePath).catch(() => null);
    if (!stats || stats.size + incomingBytes <= this.maxFileSizeBytes) {
      return;
    }

    for (let index = this.maxRotatedFiles; index >= 1; index -= 1) {
      const sourcePath = this.buildRotatedPath(index);
      const targetPath = this.buildRotatedPath(index + 1);

      if (index === this.maxRotatedFiles) {
        await fs.rm(sourcePath, { force: true }).catch(() => {});
        continue;
      }

      await fs.rename(sourcePath, targetPath).catch(() => {});
    }

    await fs.rename(this.filePath, this.buildRotatedPath(1)).catch(() => {});
  }

  buildRotatedPath(index) {
    return `${this.filePath}.${index}`;
  }

  formatLine(level, message, details) {
    const serialized = this.serializeDetails(details);
    return `[${new Date().toISOString()}] [${level}] [${this.scope}] ${message}${serialized}\n`;
  }

  serializeDetails(details) {
    if (details === undefined) {
      return "";
    }

    if (details instanceof Error) {
      return ` ${JSON.stringify({
        name: details.name,
        message: details.message,
        stack: details.stack
      })}`;
    }

    try {
      return ` ${JSON.stringify(details)}`;
    } catch {
      return ` ${JSON.stringify({ value: String(details) })}`;
    }
  }
}

const noopLogger = {
  child() {
    return this;
  },
  initialize: async () => {},
  info: async () => {},
  warn: async () => {},
  error: async () => {}
};

module.exports = {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_MAX_ROTATED_FILES,
  Logger,
  noopLogger
};
