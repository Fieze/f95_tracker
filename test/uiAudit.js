// Visual and layout audit of the real renderer with generated data.
// Renders the app at several window sizes and UI states, saves screenshots to .cache/ui-audit/ and measures
// overlaps, overflow and clipped text. Run with: npm run audit:ui
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { AppService } = require("../src/main/services/appService");

const cache = path.resolve(__dirname, "..", ".cache");
const outDir = path.join(cache, "ui-audit");
app.setPath("userData", path.join(cache, "electron-audit-profile"));

const SIZES = [
  { name: "min-1320x720", width: 1320, height: 720 },
  { name: "std-1440x900", width: 1440, height: 900 },
  { name: "wide-1920x1080", width: 1920, height: 1080 }
];

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

// Solid-colour PNG, enough to exercise banners and screenshot layouts without binary fixtures.
function makePng(width, height, [red, green, blue]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.writeUInt8(8, 8); header.writeUInt8(2, 9);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [red, green, blue]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const LONG_TITLES = [
  "A Very Long Game Title That Keeps Going And Going Until It Has To Wrap Or Be Cut Off Somewhere",
  "Short", "Medium Length Title", "Another Fairly Long Title With Subtitle: The Return Of The Sequel Part Two",
  "Game 5", "Game 6", "Game 7", "Game 8", "Game 9", "Game 10", "Game 11", "Game 12"
];

async function seed(service, root) {
  const images = path.join(root, "images");
  await fs.mkdir(images, { recursive: true });
  const palette = [[90, 60, 120], [40, 110, 90], [130, 80, 50], [50, 80, 140]];
  const files = [];
  for (let index = 0; index < palette.length; index += 1) {
    const file = path.join(images, `img-${index}.png`);
    await fs.writeFile(file, makePng(640, 360, palette[index]));
    files.push(file);
  }
  const ids = [];
  for (const [index, title] of LONG_TITLES.entries()) {
    const rich = index === 0;
    const game = await service.db.upsertGameFromThread({
      sourceUrl: `https://f95zone.to/threads/audit-${index}.${1000 + index}/`, threadId: String(1000 + index), title,
      threadTitle: `${title} [v1.${index}] [Dev]`, currentVersion: `1.${index}${rich ? " FULL + DLCs Extra Long Version Label" : ""}`,
      developer: rich ? "A Developer With A Surprisingly Long Studio Name" : "Dev", engine: ["Ren'Py", "RPGM", "Unity", "HTML"][index % 4],
      threadStatus: ["Ongoing", "Complete", "Abandoned", "On Hold"][index % 4],
      overview: rich ? "Long overview. ".repeat(60) : "Short overview.", releaseDate: "2026-10-12",
      changelog: rich ? Array.from({ length: 60 }, (_, line) => `- Change number ${line + 1} that is fairly long to force wrapping inside the panel`).join("\n") : "- Fixed things",
      threadUpdated: "2026-10-15", os: "Windows, Linux, Mac, Android", language: "English", censored: "No", rating: 4.3, ratingCount: 1234,
      developerLinks: rich ? ["Patreon", "SubscribeStar", "Itch.io", "Discord", "Website", "Twitter"].map((label) => ({ label, url: `https://example.org/${label}` })) : [],
      bannerImage: index % 5 === 4 ? null : { sourceUrl: "https://example.org/b.png", localPath: files[index % files.length] },
      screenshotImages: rich ? Array.from({ length: 14 }, (_, shot) => ({ sourceUrl: `https://example.org/${shot}.png`, localPath: files[shot % files.length] })) : [],
      tags: rich ? Array.from({ length: 34 }, (_, tag) => `tag number ${tag}`) : ["tag"], aliases: [], warnings: rich ? ["Download links are only visible when logged in to F95Zone."] : [],
      rawOpHtml: "", rawOpText: "", parserDebug: {},
      downloadGroups: rich
        ? [{ label: "Win/Linux", links: ["MEGA", "PIXELDRAIN", "VIKINGFILE", "DATANODES", "MIXDROP", "BUZZHEAVIER"].map((label) => ({ label, url: `https://pixeldrain.com/u/${label}` })) },
          { label: "Android", links: [{ label: "MEGA", url: "https://mega.nz/x" }] }]
        : [{ label: "Win", links: [{ label: "Pixeldrain", url: "https://pixeldrain.com/u/x" }] }]
    });
    ids.push(game.id);
  }
  // Several installations for the rich game.
  const richGame = service.db.getGameById(ids[0]);
  for (const name of ["Game-v1.0-pc", "Game-v1.1-pc", "Game-v1.2 with an unusually long folder name to test wrapping-pc"]) {
    const dir = path.join(root, "games", richGame.title.replace(/[<>:"/\\|?*]/g, "-"), name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "Game.exe"), "exe");
  }
  await service.syncGameFolders(richGame.id, { game: service.db.getGameById(richGame.id) });
  return ids;
}

const MEASURE = `(() => {
  const visible = (element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && Number(style.opacity) > 0.05; };
  const rectOf = (element) => { const r = element.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  const named = [];
  const add = (label, element) => { if (element && visible(element)) named.push({ label, rect: rectOf(element), element }); };
  add("topbar", document.querySelector(".topbar"));
  add("status-line", document.querySelector("#status-line"));
  add("archive-bar", document.querySelector("#archive-queue-bar"));
  document.querySelectorAll(".overlay-panel").forEach((panel) => add("panel:" + panel.id, panel));
  const issues = [];
  for (let i = 0; i < named.length; i += 1) for (let j = i + 1; j < named.length; j += 1) {
    const a = named[i].rect, b = named[j].rect;
    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left), height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (width > 2 && height > 2) issues.push({ type: "overlap", between: [named[i].label, named[j].label], width, height });
  }
  for (const item of named) {
    if (!item.label.startsWith("panel:")) continue;
    const r = item.rect;
    if (r.top < 0 || r.left < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) issues.push({ type: "outside-viewport", element: item.label, rect: r, viewport: [innerWidth, innerHeight] });
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push({ type: "horizontal-scroll", scrollWidth: document.documentElement.scrollWidth, innerWidth });
  const clipped = [];
  document.querySelectorAll("body *").forEach((element) => {
    if (!visible(element) || element.closest("svg")) return;
    const style = getComputedStyle(element);
    if (element.scrollWidth > element.clientWidth + 2 && element.clientWidth > 0 && (style.overflowX === "hidden" || style.overflowX === "clip") && style.textOverflow !== "ellipsis" && element.textContent.trim()) {
      clipped.push((element.id ? "#" + element.id : "") + "." + String(element.className).split(" ").filter(Boolean).slice(0, 2).join(".") + " \\"" + element.textContent.trim().slice(0, 40) + "\\"");
    }
  });
  if (clipped.length) issues.push({ type: "clipped-text", elements: clipped.slice(0, 8), count: clipped.length });
  const smallTargets = [];
  document.querySelectorAll("button, a, input, select").forEach((element) => {
    if (!visible(element)) return;
    const r = element.getBoundingClientRect();
    if ((r.height < 24 || r.width < 24) && element.type !== "radio" && element.type !== "checkbox") smallTargets.push((element.id ? "#" + element.id : "") + "." + String(element.className).split(" ")[0] + " " + Math.round(r.width) + "x" + Math.round(r.height));
  });
  if (smallTargets.length) issues.push({ type: "small-click-target", elements: [...new Set(smallTargets)].slice(0, 6), count: smallTargets.length });
  return JSON.stringify(issues);
})()`;

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, "ui-audit-data-"));
  let window = null;
  const service = new AppService({
    userDataPath: root,
    authSession: { cookies: { get: async () => [] } },
    folderWatcher: { start: async () => {}, stop: async () => {}, ignoreFile: () => {} },
    onStateChanged: () => { if (window && !window.isDestroyed()) window.webContents.send("state:changed"); }
  });
  await service.db.initialize();
  await service.db.saveSettings({ installRoot: path.join(root, "games"), watchFolder: path.join(root, "watch"), syncIntervalMinutes: 30 });
  const ids = await seed(service, root);

  ipcMain.handle("app:bootstrap", () => service.bootstrap());
  ipcMain.handle("activities:dismiss", () => true);
  ipcMain.handle("games:listLaunchExecutables", (_event, payload) => service.listLaunchExecutables(payload));
  window = new BrowserWindow({
    width: 1440, height: 900, show: false, useContentSize: true, backgroundThrottling: false,
    webPreferences: { preload: path.resolve(__dirname, "..", "src", "main", "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const consoleErrors = [];
  window.webContents.on("console-message", (event) => { if (event.level === "error") consoleErrors.push(event.message); });
  await window.loadFile(path.resolve(__dirname, "..", "src", "renderer", "index.html"));
  const js = (code) => window.webContents.executeJavaScript(code);
  // Transitions do not finish in a hidden window; measure the final state of every layout.
  await window.webContents.insertCSS("*, *::before, *::after { transition: none !important; animation: none !important; }");
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await js("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  };
  await js("window.alert = () => {}; reloadState()");
  await settle();

  const richId = ids[0];
  const busy = async () => {
    service.activities = [];
    service.startActivity("refresh-all", "Refreshing A Very Long Game Title That Keeps Going", { total: 35 });
    service.updateActivity(service.activities[0].id, { progress: { done: 12, total: 35 } });
    service.startActivity("add-folder", "Adding folder Some Folder To Another Game");
    const failed = service.startActivity("add-thread", "Adding another game");
    service.finishActivity(failed, { error: "Thread request failed with status 404 and a rather long explanation that goes on" });
    const first = service.createDownloadJob({ gameId: richId, url: "https://pixeldrain.com/u/a", label: "Archive One" });
    service.updateDownloadJob(first.id, { status: "downloading", fileName: "Game-v1.0-pc.zip", bytesReceived: 52e6, bytesTotal: 210e6, speedBytesPerSecond: 8e6 });
    const second = service.createDownloadJob({ gameId: richId, url: "https://pixeldrain.com/u/b", label: "Archive Two" });
    service.updateDownloadJob(second.id, { status: "downloading", fileName: "Another-v2.zip", bytesReceived: 5e6, bytesTotal: 90e6, speedBytesPerSecond: 3e6 });
    service.currentExtraction = { jobId: 1, archiveName: "Some-Long-Archive-Name-v1.2-pc.zip", startedAt: new Date().toISOString(), currentFile: "game/images/bg/very/long/path/file.png", processedFiles: 40, totalFiles: 200, estimatedTotalMs: 60000 };
  };
  const idle = async () => {
    service.activities = [];
    service.downloadJobs = [];
    service.currentExtraction = null;
  };
  const states = [
    { name: "library", setup: async () => idle(), apply: "state.openOverlay = null; state.selectedGameId = null" },
    { name: "library-busy", setup: async () => busy(), apply: "state.openOverlay = null; state.selectedGameId = null" },
    { name: "settings", setup: async () => idle(), apply: "state.openOverlay = 'settings'" },
    { name: "settings-busy", setup: async () => busy(), apply: "state.openOverlay = 'settings'" },
    { name: "login", setup: async () => idle(), apply: "state.openOverlay = 'login'" },
    { name: "add-thread", setup: async () => idle(), apply: "state.openOverlay = 'add-thread'" },
    { name: "add-folder", setup: async () => idle(), apply: "populateAddFolderGames(); updateAddFolderForm(); state.openOverlay = 'add-folder'" },
    { name: "details-rich", setup: async () => idle(), apply: `state.selectedGameId = ${richId}; state.openOverlay = 'game-details'` },
    { name: "details-rich-busy", setup: async () => busy(), apply: `state.selectedGameId = ${richId}; state.openOverlay = 'game-details'` },
    { name: "details-simple", setup: async () => idle(), apply: `state.selectedGameId = ${ids[2]}; state.openOverlay = 'game-details'` },
    { name: "edit-folder", setup: async () => idle(), apply: `state.selectedGameId = ${richId}; state.editingFolderId = (state.games.find((g) => g.id === ${richId}).folders[0] || {}).id; state.openOverlay = 'edit-folder'` }
  ];

  const report = [];
  for (const size of SIZES) {
    window.setContentSize(size.width, size.height);
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const state of states) {
      await state.setup();
      await js(`${state.apply}; reloadState().then(() => { ${state.apply}; render(); })`);
      await settle();
      const issues = JSON.parse(await js(MEASURE));
      const file = `${size.name}__${state.name}.png`;
      await fs.writeFile(path.join(outDir, file), (await window.webContents.capturePage()).toPNG());
      report.push({ size: size.name, state: state.name, file, issues });
    }
  }
  await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify({ report, consoleErrors }, null, 2));
  for (const entry of report) {
    console.log(`${entry.size} ${entry.state}: ${entry.issues.length ? JSON.stringify(entry.issues) : "ok"}`);
  }
  if (consoleErrors.length) console.log("console errors:", consoleErrors.slice(0, 5));
  await service.dispose();
  await fs.rm(root, { recursive: true, force: true });
  app.exit(0);
}).catch((error) => { console.error(error.stack || error); app.exit(1); });
