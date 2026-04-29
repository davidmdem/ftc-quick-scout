/**
 * FTC Scouting — Google Apps Script backend
 *
 * Setup (pick one):
 *
 *   A. BOUND to the sheet (simplest):
 *      1. Open the target Google Sheet.
 *      2. Extensions → Apps Script. Paste this file in.
 *      3. Leave SHEET_ID blank below.
 *
 *   B. STANDALONE script:
 *      1. Open https://script.google.com → New project, paste this file in.
 *      2. Open the target Sheet, copy the ID from the URL:
 *           https://docs.google.com/spreadsheets/d/<THIS_PART>/edit
 *      3. Paste it into SHEET_ID below.
 *
 *   Then in either case:
 *      4. Run setupHeaders() once (Apps Script will prompt for permissions).
 *      5. Deploy → New deployment → type "Web app":
 *           - Execute as: Me
 *           - Who has access: Anyone
 *      6. Copy the /exec URL into DEFAULT_ENDPOINT in app.js (or paste it into
 *         each tablet's Settings dialog).
 */

const SHEET_ID = '';   // leave blank if the script is bound to the sheet
const SHEET_NAME = 'RawData';

const HEADERS = [
  'timestamp',
  'deviceId',
  'eventCode',
  'matchNumber',
  'alliance',
  'teamNumber',
  'autoMade',
  'autoMissed',
  'teleopMade',
  'teleopMissed',
  'notes',
  'entryId',
];

function getSpreadsheet_() {
  const ss = SHEET_ID
    ? SpreadsheetApp.openById(SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error(
      'No spreadsheet attached. Either set SHEET_ID at the top of this file, ' +
      'or open this script via Extensions → Apps Script from inside the target Sheet.'
    );
  }
  return ss;
}

function getOrCreateSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  return sheet;
}

function doPost(e) {
  try {
    const sheet = getOrCreateSheet_();
    const data = JSON.parse(e.postData.contents);

    sheet.appendRow([
      data.timestamp || new Date().toISOString(),
      data.deviceId || '',
      data.eventCode || '',
      data.matchNumber,
      data.alliance || '',
      data.teamNumber,
      data.autoShotsMade || 0,
      data.autoShotsMissed || 0,
      data.teleopShotsMade || 0,
      data.teleopShotsMissed || 0,
      data.notes || '',
      data.id || '',
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService.createTextOutput('FTC Scouting endpoint is live.');
}

/** Run once from the Apps Script editor to write the header row. */
function setupHeaders() {
  const sheet = getOrCreateSheet_();
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  sheet.setFrozenRows(1);
}
