const fs = require("fs/promises");
const path = require("path");
const { atomicWrite } = require("./safeFiles");

class ApiKeyStore {
  constructor(userDataPath, safeStorage) {
    this.filePath = path.join(userDataPath, "f95-api-key.bin");
    this.safeStorage = safeStorage;
    this.key = "";
    this.persistent = false;
  }
  canEncrypt() {
    try {
      return Boolean(this.safeStorage?.isEncryptionAvailable() &&
        this.safeStorage.getSelectedStorageBackend?.() !== "basic_text");
    } catch { return false; }
  }
  async initialize() {
    try {
      const encrypted = await fs.readFile(this.filePath);
      if (this.canEncrypt()) {
        this.key = this.safeStorage.decryptString(encrypted);
        this.persistent = true;
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.loadFailed = true;
    }
  }
  async set(value) {
    const key = String(value || "").trim();
    if (key.length > 4096 || /[\r\n]/.test(key)) throw new Error("API key is invalid.");
    let encrypted = null;
    if (key && this.canEncrypt()) {
      try { encrypted = this.safeStorage.encryptString(key); } catch { /* OS encryption can fail despite the availability probe. */ }
    }
    const persistent = Boolean(encrypted);
    if (persistent) await atomicWrite(this.filePath, encrypted);
    else await fs.unlink(this.filePath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    this.key = key;
    this.persistent = persistent;
    this.loadFailed = false;
  }
  getState() { return { configured: Boolean(this.key), persistent: this.persistent, loadFailed: Boolean(this.loadFailed) }; }
}
module.exports = { ApiKeyStore };
