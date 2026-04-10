const fs = require("fs");
const path = require("path");
const { path7za } = require("7zip-bin");

function uniqueCandidates(candidates) {
  return [...new Set(candidates.filter(Boolean))];
}

function resolveSevenZipBinary(options = {}) {
  const appRoot = options.appRoot || path.resolve(__dirname, "..", "..", "..");
  const resourcesPath = options.resourcesPath || process.resourcesPath || "";
  const isPackaged = options.isPackaged ?? false;
  const isWindows = process.platform === "win32";
  const preferredBinaryNames = isWindows ? ["7z.exe", "7za.exe"] : ["7za"];
  const systemBinaryCandidates = options.systemBinaryCandidates || (
    isWindows
      ? [
          "C:\\Program Files\\7-Zip\\7z.exe",
          "C:\\Program Files (x86)\\7-Zip\\7z.exe"
        ]
      : []
  );

  const candidateGroups = preferredBinaryNames.map((binaryName) => [
    path.join(appRoot, "resources", "tools", "7zip", binaryName),
    ...(isPackaged ? [path.join(resourcesPath, "tools", "7zip", binaryName)] : []),
    ...(isWindows && binaryName === "7z.exe" ? systemBinaryCandidates : []),
    ...(isPackaged && isWindows && binaryName === "7za.exe"
      ? [path.join(resourcesPath, "app.asar.unpacked", "node_modules", "7zip-bin", "win", process.arch, "7za.exe")]
      : []),
    ...(!isWindows && binaryName === "7za" ? [path7za] : []),
    ...(isWindows && binaryName === "7za.exe" ? [path7za] : [])
  ]);

  const candidates = uniqueCandidates(candidateGroups.flat());

  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new Error("Bundled 7z binary could not be found.");
  }

  return resolved;
}

function resolveSevenZipSupportFiles(options = {}) {
  const binaryPath = resolveSevenZipBinary(options);
  if (path.basename(binaryPath).toLowerCase() !== "7z.exe") {
    return [];
  }

  const runtimeDir = path.dirname(binaryPath);
  const dllPath = path.join(runtimeDir, "7z.dll");
  return fs.existsSync(dllPath) ? [dllPath] : [];
}

module.exports = {
  resolveSevenZipBinary,
  resolveSevenZipSupportFiles
};
