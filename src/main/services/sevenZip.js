const fs = require("fs");
const path = require("path");
const { path7za } = require("7zip-bin");

function resolveSevenZipBinary(options = {}) {
  const appRoot = options.appRoot || path.resolve(__dirname, "..", "..", "..");
  const resourcesPath = options.resourcesPath || process.resourcesPath || "";
  const isPackaged = options.isPackaged ?? false;
  const binaryName = process.platform === "win32" ? "7za.exe" : "7za";

  const candidates = [
    path.join(appRoot, "resources", "tools", "7zip", binaryName),
    isPackaged ? path.join(resourcesPath, "tools", "7zip", binaryName) : null,
    isPackaged ? path.join(resourcesPath, "app.asar.unpacked", "node_modules", "7zip-bin", "win", process.arch, binaryName) : null,
    path7za
  ].filter(Boolean);

  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new Error("Bundled 7z binary could not be found.");
  }

  return resolved;
}

module.exports = {
  resolveSevenZipBinary
};
