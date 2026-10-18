// Builds the Firefox extension: stages the files with the app's version stamped into the manifest, then zips them
// into an .xpi (a zip with manifest.json at its root). Usage: node scripts/build-extension.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");
const sourceDir = path.join(root, "extensions", "firefox");
const stageDir = path.join(root, "dist", "extension-stage");
const version = require(path.join(root, "package.json")).version;
const xpiPath = path.join(root, "dist", `f95-tracker-companion-${version}-unsigned.xpi`);

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  }).sort();
}

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuffer = Buffer.from(name);
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    parts.push(local, nameBuffer, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuffer, end]);
}

fs.rmSync(stageDir, { recursive: true, force: true });
const entries = [];
for (const name of listFiles(sourceDir)) {
  let data = fs.readFileSync(path.join(sourceDir, name));
  if (name === "manifest.json") {
    const manifest = JSON.parse(data.toString("utf8"));
    manifest.version = version;
    data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  }
  fs.mkdirSync(path.dirname(path.join(stageDir, name)), { recursive: true });
  fs.writeFileSync(path.join(stageDir, name), data);
  entries.push([name, data]);
}
fs.mkdirSync(path.dirname(xpiPath), { recursive: true });
fs.writeFileSync(xpiPath, zip(entries));
console.log(`Built ${path.relative(root, xpiPath)} (${entries.length} files)`);
