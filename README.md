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

### Tests

```powershell
npm.cmd test
```

### Portable Windows Build

```powershell
npm.cmd run build
```

## Notes

- The app is designed for Windows.
- Thread fetching and many download links require a valid F95Zone session.
- Direct in-app downloading depends on host support and successful resolution of the final file URL.
- Archive extraction uses bundled `7z` resources that are included in the packaged app.
- All application data stays local unless you explicitly export it.
