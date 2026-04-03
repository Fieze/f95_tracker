# f95_tracker

Windows desktop app for tracking F95Zone threads, download links, and local game archives.

## Included Features

- Manual adding of F95Zone thread URLs
- OP parsing for title, version, developer, engine, overview, tags, and download links
- Local persistence in a SQLite file via `sql.js`
- Configurable watch folder for `.zip`, `.rar`, and `.7z` archives
- Automatic matching via filename heuristics with a review queue when confidence is low
- Extraction via a bundled `7z` binary into a target folder and deriving the installed version from the archive name
- Background sync of thread data plus manual refresh from the UI

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

## GitHub Upload Checklist

- Do not upload `node_modules/`; dependencies are restored with `npm install`.
- Do not upload local app data such as SQLite files, logs, or any `.env` files.
- F95Zone session cookies are stored by the Electron app at runtime and are not part of this repository.
- `temp_paths.js` is treated as a local helper file and is ignored by Git.
