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
- Queue further downloads while the download window is busy, and add more supported hosts in the settings.
- Resume interrupted transfers safely (If-Range, exact byte check) and keep partial files for later; verify archives that arrive without a length.
- Keep the download history across restarts.

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
- Check free disk space before extracting and report byte-based progress.
- Explain password-protected, incomplete and multi-part archives, and extract password-protected ones after entering the password.
- Optionally keep extracted archives in an `Extracted` folder instead of deleting them.

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

### Firefox Extension

`extensions/firefox` contains a companion extension. On F95Zone thread pages it shows a small overlay that tells you whether the thread is already tracked and otherwise offers "Add to tracker".

- The app runs a bridge on `127.0.0.1` (first free port from 47950 to 47959, loopback only). The extension finds it by itself.
- On first use the overlay shows "Connect to F95 Tracker"; the app then asks you to allow the extension once. After that every request carries a token, the Host must be a loopback name and the Origin must be a browser extension.
- Install: the release page offers `f95-tracker-companion-<version>.xpi`. Release Firefox only installs signed add-ons; the release workflow signs it when the `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` repository secrets (Mozilla add-on API keys) exist, otherwise it attaches an `-unsigned.xpi` that works in Developer Edition and Nightly. `npm.cmd run build:extension` builds it locally into `dist/`.
- Try it without installing: open `about:debugging` in Firefox, choose "This Firefox" > "Load Temporary Add-on" and select `extensions/firefox/manifest.json`. The app must be running.

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

### UI audit

```powershell
npm.cmd run audit:ui
```

Renders the real renderer with generated data at five window sizes (900x640 up to 1920x1080) in fifteen UI states (library, empty and filtered library, settings, login, dialogs, game details, busy status line and download drawer), saves screenshots to `.cache/ui-audit/` and reports overlapping panels, overflow, clipped text, small click targets and text contrast below WCAG AA. It uses local fixtures only and never contacts F95Zone.

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

### Data Source

Thread metadata is scraped directly from the F95Zone website through the app's own login session. An earlier version offered an optional F95ApiDB integration; it has been removed. A key stored by that version is deleted on startup, and `backups/pre-api-upgrade.sqlite` still preserves the original database from that migration. Old JSON exports remain importable.

- The app is designed for Windows.
- Thread fetching and many download links require a valid F95Zone session.
- Direct in-app downloading depends on host support and successful resolution of the final file URL.
- Archive extraction uses bundled `7z` resources that are included in the packaged app.
- Library and installation data stay local. The app only contacts F95Zone and the download hosts needed for assets and files.
