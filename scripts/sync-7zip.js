const fs = require("fs/promises");
const path = require("path");
const { path7za } = require("7zip-bin");

async function main() {
  const targetDir = path.resolve(__dirname, "..", "resources", "tools", "7zip");
  const fileName = process.platform === "win32" ? "7za.exe" : "7za";
  const targetPath = path.join(targetDir, fileName);

  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(path7za, targetPath);
  console.log(`Synced 7z binary to ${targetPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
