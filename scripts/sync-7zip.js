const fs = require("fs/promises");
const path = require("path");
const { path7za } = require("7zip-bin");

function getWindowsSevenZipSourceDir() {
  const envSourceDir = process.env.SEVEN_ZIP_SOURCE_DIR ? path.resolve(process.env.SEVEN_ZIP_SOURCE_DIR) : "";
  const candidates = [
    envSourceDir,
    "C:\\Program Files\\7-Zip",
    "C:\\Program Files (x86)\\7-Zip"
  ].filter(Boolean);

  return candidates;
}

async function main() {
  const targetDir = path.resolve(__dirname, "..", "resources", "tools", "7zip");
  await fs.mkdir(targetDir, { recursive: true });

  if (process.platform === "win32") {
    const sourceDir = await findExistingDirectory(getWindowsSevenZipSourceDir());
    if (!sourceDir) {
      const bundledBinary = path.join(targetDir, "7z.exe");
      const bundledLibrary = path.join(targetDir, "7z.dll");
      const bundledExists = await exists(bundledBinary);
      const bundledLibraryExists = await exists(bundledLibrary);
      if (bundledExists && bundledLibraryExists) {
        console.log(`Keeping bundled 7-Zip binaries from ${targetDir}`);
        return;
      }

      throw new Error(
        "Full 7-Zip installation could not be found. Install 7-Zip or set SEVEN_ZIP_SOURCE_DIR before running postinstall."
      );
    }

    const filesToCopy = ["7z.exe", "7z.dll"];
    for (const fileName of filesToCopy) {
      const sourcePath = path.join(sourceDir, fileName);
      const targetPath = path.join(targetDir, fileName);
      await fs.copyFile(sourcePath, targetPath);
      console.log(`Synced ${fileName} to ${targetPath}`);
    }

    await fs.rm(path.join(targetDir, "7za.exe"), { force: true }).catch(() => {});
    return;
  }

  const targetPath = path.join(targetDir, "7za");
  await fs.copyFile(path7za, targetPath);
  console.log(`Synced 7z binary to ${targetPath}`);
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findExistingDirectory(candidates) {
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isDirectory()) {
        return candidate;
      }
    } catch {
      // Ignore missing source directories and keep searching.
    }
  }

  return "";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
