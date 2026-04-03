# f95_tracker

Windows desktop app for tracking F95Zone threads, download links, and local game archives.

## Included Features

The app is designed around a practical workflow for managing F95Zone content:

- **Thread management**
  - F95Zone thread URLs can be added manually and managed as central entries.
  - Each entry acts as the source for metadata, current version, and download information.

- **Automatic OP parsing**
  - The OP (Opening Post) is parsed and stored in a structured format.
  - Detected fields include title, version, developer, engine, overview, tags, and download links.
  - This creates a consistent dataset per game instead of unstructured forum links.

- **Local data storage**
  - All captured data is stored locally in a SQLite file via `sql.js`.
  - This keeps the app usable without an external cloud service and fast for local queries.

- **Archive monitoring**
  - A configurable watch folder monitors new archives (`.zip`, `.rar`, `.7z`).
  - New files are detected automatically, so each archive does not need to be imported manually.

- **Automatic archive-to-thread matching**
  - Filenames are matched to existing thread entries using heuristics.
  - Low-confidence matches are sent to a review queue so mappings can be verified and corrected.

- **Extraction and version detection**
  - Archives are extracted into a target directory using a bundled `7z` binary.
  - The installed version is derived from the archive filename for quick local version tracking.

- **Synchronization and updates**
  - Thread data is synchronized in the background.
  - A manual refresh is also available directly in the UI.
  - This keeps the local dataset current as forum threads change over time.

## Start

```powershell
npm.cmd install
npm.cmd start
```

## Tests

```powershell
npm.cmd test
```

## Notes

- Fetching thread data usually requires a valid F95Zone session cookie.
- Download buttons only open the host pages in the default browser. Downloads themselves are not automated.
- Archives are extracted via a bundled `7z` binary. Packaging should ship the `resources/tools` folder as `extraResources`.
