const fs = require("fs/promises");
const path = require("path");

const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024;
const DEFAULT_MAX_ROTATED_FILES = 3;
const TIMESTAMP_PREFIX_PATTERN = /^\[(?<timestamp>[^\]]+)\]/;

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

    const rotatedPath = await this.buildRotatedPathFromLatestEntry(stats);
    await fs.rename(this.filePath, rotatedPath).catch(() => {});
    await this.pruneRotatedFiles();
  }

  async buildRotatedPathFromLatestEntry(stats) {
    const timestamp = await this.resolveLatestEntryTimestamp(stats);
    const parsedPath = path.parse(this.filePath);
    const baseName = `${parsedPath.name}-${timestamp}`;
    let candidatePath = path.join(parsedPath.dir, `${baseName}${parsedPath.ext}`);
    let collisionIndex = 1;

    while (await fs.stat(candidatePath).then(() => true).catch(() => false)) {
      candidatePath = path.join(parsedPath.dir, `${baseName}-${collisionIndex}${parsedPath.ext}`);
      collisionIndex += 1;
    }

    return candidatePath;
  }

  async resolveLatestEntryTimestamp(stats) {
    const content = await fs.readFile(this.filePath, "utf8").catch(() => "");
    const lines = content.split(/\r?\n/).filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const match = lines[index].match(TIMESTAMP_PREFIX_PATTERN);
      const candidate = match?.groups?.timestamp ? new Date(match.groups.timestamp) : null;
      if (candidate && Number.isFinite(candidate.getTime())) {
        return Logger.formatTimestampForFileName(candidate);
      }
    }

    return Logger.formatTimestampForFileName(stats?.mtime || new Date());
  }

  async pruneRotatedFiles() {
    const rotatedFiles = await this.listRotatedFiles();
    const staleFiles = rotatedFiles
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(this.maxRotatedFiles);

    await Promise.all(staleFiles.map((entry) => fs.rm(entry.fullPath, { force: true }).catch(() => {})));
  }

  async listRotatedFiles() {
    if (!this.filePath) {
      return [];
    }

    const parsedPath = path.parse(this.filePath);
    const entries = await fs.readdir(parsedPath.dir, { withFileTypes: true }).catch(() => []);
    const prefix = `${parsedPath.name}-`;
    const suffix = parsedPath.ext;
    const matchingEntries = entries.filter(
      (entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(suffix)
    );

    return Promise.all(
      matchingEntries.map(async (entry) => {
        const fullPath = path.join(parsedPath.dir, entry.name);
        const fileStats = await fs.stat(fullPath).catch(() => null);
        return {
          fullPath,
          mtimeMs: fileStats?.mtimeMs || 0
        };
      })
    );
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

  static formatTimestampForFileName(value) {
    return new Date(value)
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\./g, "-");
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
