# FTC Quick Scout

Tablet-friendly Progressive Web App for FTC match scouting. Works fully offline,
stores entries on-device in IndexedDB, and syncs to a shared Google Sheet via a
Google Apps Script Web App when online.

## Files

- `index.html`, `app.js`, `styles.css` — UI and app logic.
- `manifest.json` — PWA manifest.
- `service-worker.js` — cache-first app shell so the app loads offline.
- `icons/icon.svg` — placeholder app icon (replace with a branded PNG/SVG when ready).
- `apps-script.gs` — paste into the target Google Sheet's Apps Script editor.

## Backend setup (one time)

1. Create or open your scouting Google Sheet.
2. Add a tab named `RawData`.
3. **Extensions → Apps Script**, paste the contents of `apps-script.gs`.
4. Run `setupHeaders()` once (this writes the header row into `RawData`).
5. **Deploy → New deployment → Web app**:
   - Execute as: *Me*
   - Who has access: *Anyone*
6. Copy the `/exec` URL — you'll paste it into the app's Settings on each tablet.

## Hosting (GitHub Pages)

1. In `app.js`, set `DEFAULT_ENDPOINT` to your Apps Script `/exec` URL. Every
   tablet that loads the hosted app will pick this up automatically.
2. Push this repo to GitHub.
3. **Settings → Pages → Build from `main` (root)**.
4. Open the published URL in Chrome on the Samsung tablet.
5. Use Chrome's menu → **Add to Home screen** to install the PWA.

## On the tablet

Nothing required if `DEFAULT_ENDPOINT` is set — open the app and start scouting.

To override on a specific tablet (e.g. point at a test sheet), tap ⚙︎, paste a
different URL into **Apps Script URL**, and **Save**. Clearing the override and
saving falls back to the default.

After that, scouts can capture matches with no internet. Tap **Sync** (or rely on
auto-sync when the tablet reconnects) to flush entries to the sheet. The unsynced
counter in the header shows what still needs to upload.

## Data model

Each entry stored in IndexedDB and posted to the sheet:

```
id, timestamp, deviceId, eventCode, matchNumber, alliance,
teamNumber, autoShotsMade, autoShotsMissed,
teleopShotsMade, teleopShotsMissed, notes, synced
```

The Apps Script appends each entry as a row in `RawData` with an extra `entryId`
column (the local UUID) so you can dedupe later if needed.

## Notes

- The sync POST uses `Content-Type: text/plain;charset=utf-8` to avoid a CORS
  preflight against Apps Script. The script still parses the JSON via
  `e.postData.contents`.
- Service worker caches the app shell; entries live in IndexedDB and are not
  evicted when the cache version bumps. Bump `CACHE_VERSION` in
  `service-worker.js` whenever shell assets change.
- To reset a tablet's local store, open DevTools → Application → IndexedDB →
  delete `ftc-scouting`. Settings live in `localStorage` under
  `ftc-scouting:settings` and `ftc-scouting:deviceId`.
