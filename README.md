# f95_tracker

Windows desktop app for tracking F95Zone threads, monitoring updates, managing local installs, downloading archives, and extracting releases into organized game folders.

## What The App Does

`f95_tracker` is built around a full desktop workflow for F95Zone users:

- Add a thread once and keep its metadata, version, downloads, and local installs in one place.
- Watch for new releases and compare thread versions against what you already have installed.
- Download supported files directly inside the app.
- Detect archives in a watch folder, match them to games, and extract them into managed install locations.
- Keep all data local with no external backend.

## Core Features

### Thread Tracking And Update Monitoring

- Import F95Zone threads by URL.
- Parse and store thread metadata such as title, developer, engine, release date, overview, tags, screenshots, status, and download groups.
- Refresh a single game or all tracked games on demand.
- Run background synchronization on a configurable interval.
- Show update badges when the thread version is newer than the installed version.
- Track thread states such as complete, on hold, and abandoned.
- Store parser warnings and raw debug output for troubleshooting difficult threads.

### Login And Authenticated Fetching

- Open a dedicated F95Zone login window inside the app.
- Reuse the app's authenticated session for thread fetching and supported downloads.
- Show login state directly in the UI.
- Clear the stored F95Zone session with logout.

### Download Management

- Display grouped download links parsed from each thread.
- Start direct in-app downloads for supported hosts such as Pixeldrain and Vikingfile.
- Fall back to opening unsupported hosts in the browser when direct takeover is not possible.
- Track active downloads in the activity bar.
- Show live progress, status, file names, and cancellation controls.
- Continue the workflow from resolved download pages when the app can detect the final file URL.

### Archive Detection And Extraction

- Watch a configurable folder for new archive files.
- Detect common release formats including `.zip`, `.rar`, `.7z`, and other supported archive-style downloads.
- Create archive jobs automatically when new files appear.
- Match archives to known games using filename heuristics.
- Send uncertain matches to a review queue so you can assign the correct game manually.
- Detect likely version numbers from archive names.
- Extract archives with a bundled `7z` binary.
- Show live extraction progress and job status in the activity bar.
- Cleanly handle extraction errors and interrupted jobs.

### Install Folder Management

- Maintain a managed install root for extracted games.
- Build clean install directories from thread titles and detected versions.
- Track multiple install folders per game.
- Rank folders so the newest or most relevant install becomes the primary one.
- Edit install metadata manually when needed.
- Store per-folder version numbers, preferred executable, season number, and season-final state.
- Launch games directly from the selected executable.
- Detect and synchronize managed folders so the app can reflect the real state on disk.

### Library View And Game Details

- Browse all tracked games from a desktop library view.
- See overview counters for total games, pending updates, and open archive jobs.
- Open a details panel with version info, developer, engine, screenshots, overview text, genres, installs, and downloads.
- Jump straight to the original thread in the browser.
- Delete games you no longer want to track.

### Background Helpers

- Minimize to the system tray.
- Restore the main window from the tray.
- Show desktop notifications when tracked games receive updates.
- Perform startup refreshes and periodic background syncs.
- Keep downloaded thread assets cached locally for faster reuse.

### Local Data, Backup, Import, And Export

- Store app data locally in SQLite via `sql.js`.
- Keep thread data, downloads, archive jobs, sync history, settings, and install folders on the local machine.
- Create automatic local backups.
- Export the full app snapshot to a file.
- Import a previously exported snapshot back into the app.

## Typical Workflow

1. Log in to F95Zone from inside the app.
2. Add one or more thread URLs.
3. Set a watch folder and install root in Settings.
4. Refresh tracked threads and review detected updates.
5. Start direct downloads from supported hosts or use browser fallback links.
6. Let the app detect archives, match them to games, and extract them into managed folders.
7. Launch installed builds directly from the game details view.

## Local Development

### Start

```powershell
npm.cmd install
npm.cmd start
```

### Lint

```powershell
npm.cmd run lint
```

CI (`.github/workflows/ci.yml`) runs lint, the test suite and a runtime dependency audit on every push and pull request.

### Tests

```powershell
npm.cmd test
```

The suite includes real bundled 7-Zip processing, process cancellation, Windows junction protection, and the folder watcher. It uses `.cache/test-tmp` inside the project; restricted sandboxes may require permission to create junctions and run these integration tests. Permission failures are reported as failures.

For an isolated Electron renderer/preload smoke test:

```powershell
npm.cmd run test:ui
```

This opens a hidden test window, uses local fixtures for authentication, download responses, and game launch, and records `.cache/ui-smoke.json` and `.cache/ui-smoke.png`. It does not authenticate against real hosts or launch a real game.

## Releases And Auto-Update

`npm.cmd run build` creates an NSIS installer, the portable exe, and `latest.yml` in `dist/` (unsigned).

To publish a release, bump `version` in `package.json`, commit, then push a matching tag:

```powershell
git tag v1.0.1
git push origin v1.0.1
```

`.github/workflows/release.yml` builds on GitHub, publishes the release and attaches installer, portable exe and `latest.yml` to the release. Installed copies check GitHub Releases at startup and every 6 hours, download new versions in the background and install them when the app quits. The portable build and dev runs never self-update. Because the builds are unsigned, Windows SmartScreen shows a warning on first launch ("More info" > "Run anyway").

## Safe Storage And Installations

- Database saves are serialized and atomically replaced. The first startup with an existing database preserves `backups/pre-safety-upgrade.sqlite` before migration; regular JSON backups continue separately.
- Imports are validated in a separate database and backed up before replacement. Finish active operations, downloads, and requested archive jobs before importing.
- Archive extraction runs through one FIFO queue and validates paths and links before publishing files. Temporary output is kept under `.f95-staging`; only directories marked as belonging to the current app data directory are cleaned up.
- Every extracted release receives its own versioned installation folder. Existing folders are retained; duplicate versions receive suffixes such as ` (2)`.
- Installation deletion is restricted to directories inside the configured game roots and rejects symbolic links and junctions. External installations remain visible but cannot be recursively deleted through the app.
- Closing to the tray retains the existing behavior. Explicit quit stops background work, waits for the actual extraction process to end, and finishes database saves. Interrupted archive jobs can be resumed manually after restart.
- External browser links accept only HTTP and HTTPS. The main renderer is the only authorized IPC sender.

The backend separates downloads, archives, and installations into dedicated services; `AppService` coordinates shared state and lifecycle. Renderer scripts separate library/details, activities, and settings from shared state and initialization.

### Portable Windows Build

```powershell
npm.cmd run build
```

## Notes

### F95ApiDB

In Settings, save your personal F95ApiDB key and use **Test Connection**. Metadata fetching then works without an F95Zone login. Account approval and separate download-link approval may be required by the provider. Keys are encrypted using Electron safeStorage in a separate file, never returned to the renderer or included in database exports. If secure storage is unavailable, the key lasts only for the current session.

The API supplies metadata, changelog and image/download URLs. Existing image caching and host-download workflows remain in use. Empty optional fields and unavailable download lists preserve existing data. Missing/unpublished or incomplete API records use the scraper once when a forum login is available; authentication, rate-limit and service errors do not trigger scraping. Without a key, the existing scraper remains active.

Background sync batches 25 thread IDs, reloads changed entries and checks full details at least every 24 hours while the app runs. Requests are serialized at no more than one per second. Authentication failures pause API requests until the key is saved again or the connection is tested. On first migration of an existing database, `backups/pre-api-upgrade.sqlite` preserves its original contents. Old JSON exports remain importable; importing does not replace the separately stored key.

Bookmarks and discovery features are disabled. Follow the [provider terms](https://f95api.xyz/terms): this integration is an ordinary user-run desktop client; do not connect keys to AI agents or MCP systems. Automated tests use local fixtures only. Validate real metadata, download permissions, images and changelog through the app with your approved account, then check download, installation and launch.

- The app is designed for Windows.
- Thread fetching and many download links require a valid F95Zone session.
- Direct in-app downloading depends on host support and successful resolution of the final file URL.
- Archive extraction uses bundled `7z` resources that are included in the packaged app.
- Library and installation data stay local. API mode sends requested thread IDs and API authentication to F95ApiDB; the app also requests forum assets and download hosts as needed.
