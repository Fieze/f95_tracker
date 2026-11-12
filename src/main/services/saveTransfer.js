// Finds the save data inside an installed game folder and copies it into another version of the same game.
// Covers the engines that keep saves next to the game: Ren'Py (game/saves), RPG Maker MV / MZ (www/save, save),
// RPG Maker VX Ace / XP / 2000 (Save*.rvdata2 ... in the game folder), Wolf RPG (Save), Unreal
// (<Project>/Saved/SaveGames) and anything else that uses a folder called "save(s)" close to the top.
// Unity, Godot and HTML games keep their saves outside the game folder, so there is nothing to carry over.
const fs = require("fs/promises");
const path = require("path");

const SAVE_DIRECTORY_NAMES = new Set(["save", "saves", "savedata", "save data", "savegame", "savegames", "saved games"]);
// Engine and asset folders that never hold saves and can be large.
const SKIPPED_DIRECTORY_NAMES = new Set(["renpy", "lib", "node_modules", "locales", "img", "audio", "movies", "fonts", "cache"]);
const SAVE_FILE_PATTERN = /^(?:save\d*|global|config)\.(?:rvdata2?|rxdata|lsd|rpgsave|rmmzsave)$/i;
const SEARCH_DEPTH = 3;
// Engines that keep saves outside the game folder (or, for Ren'Py, also in the user profile).
const EXTERNAL_SAVE_ENGINES = /^(?:ren'?py|unity|html|webgl|godot|unreal engine)$/i;

// Relative paths of the save folders and loose save files below `root`.
async function findSaveItems(root) {
  const items = [];
  const visit = async (directory, depth) => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      const name = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (SAVE_DIRECTORY_NAMES.has(name)) items.push({ relativePath: path.relative(root, fullPath), directory: true });
        else if (depth < SEARCH_DEPTH && !SKIPPED_DIRECTORY_NAMES.has(name)) await visit(fullPath, depth + 1);
      } else if (entry.isFile() && depth <= 2 && SAVE_FILE_PATTERN.test(entry.name)) {
        // Loose save files sit in the game folder itself or in "www".
        items.push({ relativePath: path.relative(root, fullPath), directory: false });
      }
    }
  };
  await visit(root, 1);
  return items;
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

async function copyVerified(sourceFile, targetFile) {
  const source = await fs.stat(sourceFile);
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  await fs.copyFile(sourceFile, targetFile);
  // Ren'Py and RPG Maker pick the newest save by its time stamp.
  await fs.utimes(targetFile, source.atime, source.mtime).catch(() => {});
  const copied = await fs.stat(targetFile);
  if (copied.size !== source.size) throw new Error(`Save file was not copied completely: ${path.basename(sourceFile)}`);
  return source.size;
}

// Copies every save from `sourceRoot` to the same place below `targetRoot`. The player's saves win over files
// of the same name that ship with the new version. Throws when a file could not be copied in full, so a caller
// only continues (and removes the old version) after a complete transfer.
async function transferSaves(sourceRoot, targetRoot) {
  const items = await findSaveItems(sourceRoot);
  let files = 0;
  let bytes = 0;
  for (const item of items) {
    const sourcePath = path.join(sourceRoot, item.relativePath);
    const sourceFiles = item.directory ? await listFiles(sourcePath) : [sourcePath];
    for (const sourceFile of sourceFiles) {
      bytes += await copyVerified(sourceFile, path.join(targetRoot, path.relative(sourceRoot, sourceFile)));
      files += 1;
    }
  }
  return { files, bytes, locations: items.map((item) => item.relativePath) };
}

function savesLiveOutsideGameFolder(engine) {
  return EXTERNAL_SAVE_ENGINES.test(String(engine || "").trim());
}

module.exports = { findSaveItems, savesLiveOutsideGameFolder, transferSaves };
