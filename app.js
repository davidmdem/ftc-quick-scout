// FTC Scouting PWA — local-first capture with Google Sheet sync.
(() => {
  const DB_NAME = 'ftc-scouting';
  const DB_VERSION = 1;
  const STORE = 'entries';

  const SETTINGS_KEY = 'ftc-scouting:settings';
  const DEVICE_ID_KEY = 'ftc-scouting:deviceId';
  const SCOUT_NAME_KEY = 'ftc-scouting:scoutName';
  const DRAFT_KEY = 'ftc-scouting:draft';

  // Paste the Apps Script /exec URL here once and commit. All tablets that
  // load the hosted app will pick it up automatically. Per-tablet Settings
  // can still override; clearing the override falls back to this default.
  const DEFAULT_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwL1XiNvcRg9z8YIwNUi4lFYRl4rXdahtOcKGeHaOMgUwy-59Z50RU7eFo9-Vjvbqc-/exec';

  // Bump this whenever the event changes. migrateSettings() uses it to detect
  // tablets carrying a previous event's saved endpoint/eventCode and reset them
  // to the compiled defaults below, so a code+redeploy is enough to repoint every
  // tablet (no per-device cleanup).
  const EVENT_CONFIG_ID = 'FPEMICRFT';

  const SCHEDULE_URL = './FPEMICRFT-schedule.json';

  const COUNTER_KEYS = ['autoShotsMade', 'autoShotsMissed', 'teleopShotsMade', 'teleopShotsMissed'];

  // ---------- Settings & device id ----------
  function loadSettings() {
    const defaults = {
      endpointUrl: DEFAULT_ENDPOINT,
      defaultEvent: 'FPEMICRFT',
      autoSync: true,
      autoIncrement: false,
      station: '', // 'Red1' | 'Red2' | 'Blue1' | 'Blue2' | ''
      eventConfigId: EVENT_CONFIG_ID,
    };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return defaults;
      const merged = { ...defaults, ...JSON.parse(raw) };
      // Blank/cleared override falls back to the compiled default.
      if (!merged.endpointUrl) merged.endpointUrl = DEFAULT_ENDPOINT;
      return merged;
    } catch {
      return defaults;
    }
  }
  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
  // One-time, idempotent reset for tablets carrying a previous event's saved
  // settings. Without this, loadSettings() would keep merging the old stored
  // endpointUrl/defaultEvent over the new compiled defaults, so the tablet would
  // silently keep syncing to the old sheet. Station and other prefs are kept —
  // tablets stay where they're physically placed.
  function migrateSettings() {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return; // fresh tablet: defaults already correct.
    let stored;
    try {
      stored = JSON.parse(raw);
    } catch {
      return;
    }
    if (stored && stored.eventConfigId === EVENT_CONFIG_ID) return; // already migrated.
    const migrated = {
      ...stored,
      endpointUrl: DEFAULT_ENDPOINT,
      defaultEvent: 'FPEMICRFT',
      eventConfigId: EVENT_CONFIG_ID,
    };
    saveSettings(migrated);
  }
  function getDeviceId() {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  }
  function getScoutName() {
    return localStorage.getItem(SCOUT_NAME_KEY) || '';
  }
  function setScoutName(name) {
    if (name) localStorage.setItem(SCOUT_NAME_KEY, name);
    else localStorage.removeItem(SCOUT_NAME_KEY);
  }

  // ---------- IndexedDB ----------
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('synced', 'synced', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async function addEntry(entry) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = tx(db, 'readwrite').add(entry);
      req.onsuccess = () => resolve(entry);
      req.onerror = () => reject(req.error);
    });
  }

  async function getUnsyncedEntries() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const out = [];
      const req = tx(db, 'readonly').openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(out.sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
        if (cursor.value.synced === false) out.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function markEntrySynced(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const store = tx(db, 'readwrite');
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const e = getReq.result;
        if (!e) return resolve();
        e.synced = true;
        const putReq = store.put(e);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function getEntry(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = tx(db, 'readonly').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function updateEntry(entry) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = tx(db, 'readwrite').put(entry);
      req.onsuccess = () => resolve(entry);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteEntry(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = tx(db, 'readwrite').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function getRecentEntries(limit = 100) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const out = [];
      const req = tx(db, 'readonly').openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
          return resolve(out.slice(0, limit));
        }
        out.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function getUnsyncedCount() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      let count = 0;
      const req = tx(db, 'readonly').openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(count);
        if (cursor.value.synced === false) count++;
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ---------- Sync ----------
  async function postEntry(endpoint, entry) {
    // text/plain avoids a CORS preflight against Apps Script Web Apps;
    // GAS still parses the body via e.postData.contents.
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(entry),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  async function syncAll({ silent = false } = {}) {
    const settings = loadSettings();
    if (!settings.endpointUrl) {
      if (!silent) toast('Set Apps Script URL in settings', 'error');
      return { sent: 0, failed: 0 };
    }
    if (!navigator.onLine) {
      if (!silent) toast('Offline — will sync later', 'error');
      return { sent: 0, failed: 0 };
    }
    const pending = await getUnsyncedEntries();
    if (pending.length === 0) {
      if (!silent) toast('Nothing to sync', 'success');
      return { sent: 0, failed: 0 };
    }

    let sent = 0, failed = 0;
    for (const entry of pending) {
      try {
        await postEntry(settings.endpointUrl, entry);
        await markEntrySynced(entry.id);
        sent++;
        await refreshUnsyncedBadge();
      } catch (err) {
        console.warn('Sync failed for', entry.id, err);
        failed++;
        break; // likely offline / endpoint down — stop and try later
      }
    }
    if (!silent) {
      if (failed > 0) toast(`Synced ${sent}, ${failed} failed`, 'error');
      else toast(`Synced ${sent} entries`, 'success');
    }
    return { sent, failed };
  }

  // ---------- Schedule (event-day match list) ----------
  // Sorted by startTime ascending once loaded. Empty until loadSchedule resolves.
  let schedule = [];

  async function loadSchedule() {
    try {
      const res = await fetch(SCHEDULE_URL);
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data && data.schedule) ? data.schedule : [];
      schedule = list.slice().sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    } catch (e) {
      console.warn('Schedule load failed', e);
    }
  }

  function findMatch(matchNumber) {
    const n = parseInt(matchNumber, 10);
    if (!Number.isFinite(n)) return null;
    return schedule.find((m) => m.matchNumber === n) || null;
  }

  // Pick the scheduled match whose startTime is closest to `now` — works as a
  // sensible default whether we're a few minutes before or after the slot.
  function activeMatchByTime(now = new Date()) {
    if (!schedule.length) return null;
    let best = null;
    let bestDiff = Infinity;
    for (const m of schedule) {
      const diff = Math.abs(new Date(m.startTime).getTime() - now.getTime());
      if (diff < bestDiff) { best = m; bestDiff = diff; }
    }
    return best;
  }

  function teamAt(match, station) {
    if (!match || !station) return null;
    return match.teams.find((t) => t.station === station) || null;
  }

  function allianceFromStation(station) {
    if (!station) return null;
    if (station.indexOf('Red') === 0) return 'red';
    if (station.indexOf('Blue') === 0) return 'blue';
    return null;
  }

  function stationLabel(station) {
    switch (station) {
      case 'Red1': return 'Red 1';
      case 'Red2': return 'Red 2';
      case 'Blue1': return 'Blue 1';
      case 'Blue2': return 'Blue 2';
      default: return '';
    }
  }

  // Fill state.teamNumber + state.alliance from the schedule for the current
  // matchNumber and configured station. Returns true if anything was applied.
  function applyScheduleToCurrent() {
    const settings = loadSettings();
    if (!settings.station) return false;
    const match = findMatch(state.matchNumber);
    if (!match) return false;
    const team = teamAt(match, settings.station);
    if (!team) return false;
    state.teamNumber = String(team.teamNumber);
    state.alliance = allianceFromStation(settings.station);
    return true;
  }

  function formatMatchTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  // Schedule + station + a known team for that match means team# and alliance
  // are determined by the schedule — lock them so scouts can't accidentally
  // type a wrong team or pick the wrong alliance.
  function isLockedByStation() {
    const settings = loadSettings();
    if (!settings.station) return false;
    const match = findMatch(state.matchNumber);
    if (!match) return false;
    return !!teamAt(match, settings.station);
  }

  // ---------- UI state ----------
  let editingId = null;
  const state = {
    scoutName: '',
    matchNumber: '',
    teamNumber: '',
    alliance: null,
    autoShotsMade: 0,
    autoShotsMissed: 0,
    teleopShotsMade: 0,
    teleopShotsMissed: 0,
    notes: '',
  };

  // Draft persistence — survives accidental refresh while offline.
  function persistDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ state, editingId }));
    } catch {}
  }
  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  function renderCounters() {
    $$('.counter').forEach((el) => {
      const key = el.dataset.key;
      $('.counter-value', el).textContent = String(state[key]);
    });
  }
  function renderAlliance() {
    $$('.alliance').forEach((btn) => {
      const on = btn.dataset.alliance === state.alliance;
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  function renderInputs() {
    $('#scoutName').value = state.scoutName;
    $('#matchNumber').value = state.matchNumber;
    $('#teamNumber').value = state.teamNumber;
    $('#notes').value = state.notes;
  }
  function renderEventLabel() {
    const s = loadSettings();
    $('#eventLabel').textContent = s.defaultEvent || '(set in settings)';
    $('#stationLabel').textContent = stationLabel(s.station) || '(none)';
  }

  function renderMatchInfo() {
    const el = $('#matchInfo');
    if (!el) return;
    const settings = loadSettings();
    const match = findMatch(state.matchNumber);
    if (!settings.station || !match) {
      el.hidden = true;
      el.className = 'match-info';
      el.textContent = '';
      applyLocks();
      return;
    }
    const team = teamAt(match, settings.station);
    const alliance = allianceFromStation(settings.station);
    el.className = `match-info ${alliance || ''}`;
    el.hidden = false;
    const time = formatMatchTime(match.startTime);
    if (!team) {
      el.textContent = `Q${match.matchNumber} · ${stationLabel(settings.station)} · — · ${time}`;
      applyLocks();
      return;
    }
    const flags = [];
    if (team.noShow) flags.push('no show');
    if (team.surrogate) flags.push('surrogate');
    const flagText = flags.length ? ` · ${flags.join(', ')}` : '';
    const name = (team.teamName || '').trim();
    el.textContent = `Q${match.matchNumber} · ${stationLabel(settings.station)} · ${name} (#${team.teamNumber}) · ${time}${flagText}`;
    applyLocks();
  }

  function applyLocks() {
    const locked = isLockedByStation();
    const teamInput = $('#teamNumber');
    if (teamInput) {
      teamInput.readOnly = locked;
      teamInput.classList.toggle('locked', locked);
    }
    $$('.alliance').forEach((btn) => {
      btn.disabled = locked;
      btn.classList.toggle('locked', locked);
    });
  }

  function bindCounters() {
    $$('.counter').forEach((el) => {
      const key = el.dataset.key;
      $('.inc', el).addEventListener('click', () => {
        state[key] = (state[key] || 0) + 1;
        renderCounters();
        persistDraft();
      });
      $('.dec', el).addEventListener('click', () => {
        state[key] = Math.max(0, (state[key] || 0) - 1);
        renderCounters();
        persistDraft();
      });
    });
  }
  function bindAlliance() {
    $$('.alliance').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.alliance = btn.dataset.alliance;
        renderAlliance();
        persistDraft();
      });
    });
  }
  function bindInputs() {
    $('#scoutName').addEventListener('input', (e) => {
      state.scoutName = e.target.value;
      setScoutName(state.scoutName.trim());
      persistDraft();
    });
    $('#matchNumber').addEventListener('input', (e) => {
      state.matchNumber = e.target.value;
      renderEditBanner();
      renderMatchInfo();
      persistDraft();
    });
    // Auto-fill team/alliance from schedule once the match # is committed
    // (blur/Enter) — avoids overwriting on every keystroke as they type.
    $('#matchNumber').addEventListener('change', () => {
      if (applyScheduleToCurrent()) {
        renderInputs();
        renderAlliance();
        renderMatchInfo();
        persistDraft();
      }
    });
    $('#teamNumber').addEventListener('input', (e) => {
      state.teamNumber = e.target.value;
      renderEditBanner();
      persistDraft();
    });
    $('#notes').addEventListener('input', (e) => {
      state.notes = e.target.value;
      persistDraft();
    });
  }

  function resetForNextMatch() {
    const settings = loadSettings();
    const prev = parseInt(state.matchNumber, 10);
    state.matchNumber = settings.autoIncrement && Number.isFinite(prev) ? String(prev + 1) : '';
    state.teamNumber = '';
    state.alliance = null;
    state.notes = '';
    for (const k of COUNTER_KEYS) state[k] = 0;
    // After bumping the match #, re-fill team/alliance from the schedule so
    // the next match is mostly pre-populated.
    applyScheduleToCurrent();
    renderCounters();
    renderAlliance();
    renderInputs();
    renderEditBanner();
    renderMatchInfo();
    persistDraft();
  }

  function validate() {
    const settings = loadSettings();
    // Skip event check when editing — the entry already has its eventCode locked in.
    if (!editingId && !settings.defaultEvent) return 'Set event in Settings';
    if (!state.scoutName.trim()) return 'Enter scout name';
    const m = parseInt(state.matchNumber, 10);
    if (!Number.isFinite(m) || m <= 0) return 'Enter match number';
    const t = parseInt(state.teamNumber, 10);
    if (!Number.isFinite(t) || t <= 0) return 'Enter team number';
    if (state.alliance !== 'red' && state.alliance !== 'blue') return 'Pick alliance';
    return null;
  }

  function buildEntry() {
    const settings = loadSettings();
    return {
      id: (crypto.randomUUID && crypto.randomUUID()) || `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      deviceId: getDeviceId(),
      scoutName: state.scoutName.trim(),
      eventCode: settings.defaultEvent,
      matchNumber: parseInt(state.matchNumber, 10),
      alliance: state.alliance,
      teamNumber: parseInt(state.teamNumber, 10),
      autoShotsMade: state.autoShotsMade,
      autoShotsMissed: state.autoShotsMissed,
      teleopShotsMade: state.teleopShotsMade,
      teleopShotsMissed: state.teleopShotsMissed,
      notes: state.notes || '',
      synced: false,
    };
  }

  async function onSave() {
    const err = validate();
    if (err) return toast(err, 'error');

    if (editingId) {
      try {
        const existing = await getEntry(editingId);
        if (!existing) {
          exitEditMode();
          return toast('Entry not found', 'error');
        }
        if (existing.synced) {
          exitEditMode();
          return toast('Already synced — cannot edit', 'error');
        }
        const updated = {
          ...existing, // preserves id, deviceId, timestamp, eventCode, synced=false
          scoutName: state.scoutName.trim(),
          matchNumber: parseInt(state.matchNumber, 10),
          teamNumber: parseInt(state.teamNumber, 10),
          alliance: state.alliance,
          autoShotsMade: state.autoShotsMade,
          autoShotsMissed: state.autoShotsMissed,
          teleopShotsMade: state.teleopShotsMade,
          teleopShotsMissed: state.teleopShotsMissed,
          notes: state.notes || '',
        };
        await updateEntry(updated);
        toast('Updated', 'success');
        exitEditMode();
        resetForNextMatch();
        await refreshUnsyncedBadge();
      } catch (e) {
        console.error(e);
        toast('Update failed', 'error');
      }
      return;
    }

    const entry = buildEntry();
    try {
      await addEntry(entry);
      toast('Saved', 'success');
      resetForNextMatch();
      await refreshUnsyncedBadge();
      const settings = loadSettings();
      if (settings.autoSync && navigator.onLine && settings.endpointUrl) {
        syncAll({ silent: true });
      }
    } catch (e) {
      console.error(e);
      toast('Save failed', 'error');
    }
  }

  // ---------- Edit mode ----------
  function enterEditMode(entry) {
    editingId = entry.id;
    state.scoutName = entry.scoutName || '';
    state.matchNumber = String(entry.matchNumber);
    state.teamNumber = String(entry.teamNumber);
    state.alliance = entry.alliance;
    state.autoShotsMade = entry.autoShotsMade;
    state.autoShotsMissed = entry.autoShotsMissed;
    state.teleopShotsMade = entry.teleopShotsMade;
    state.teleopShotsMissed = entry.teleopShotsMissed;
    state.notes = entry.notes || '';
    renderInputs();
    renderCounters();
    renderAlliance();
    renderEditBanner();
    renderMatchInfo();
    $('#saveBtn').textContent = 'Update Entry';
    persistDraft();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function exitEditMode() {
    editingId = null;
    $('#saveBtn').textContent = 'Save Entry';
    renderEditBanner();
    persistDraft();
  }

  function cancelEdit() {
    exitEditMode();
    state.matchNumber = '';
    state.teamNumber = '';
    state.alliance = null;
    state.notes = '';
    for (const k of COUNTER_KEYS) state[k] = 0;
    renderInputs();
    renderCounters();
    renderAlliance();
    renderEditBanner();
    renderMatchInfo();
    persistDraft();
  }

  function renderEditBanner() {
    const el = $('#editBanner');
    if (!el) return;
    const label = $('.edit-label', el);
    const target = $('.edit-target', el);
    const cancelBtn = $('#cancelEditBtn');
    if (!label || !target || !cancelBtn) return;

    if (editingId) {
      label.textContent = 'Editing';
      const m = state.matchNumber || '?';
      const t = state.teamNumber || '?';
      target.textContent = `Match ${m} · Team ${t}`;
      cancelBtn.hidden = false;
    } else {
      label.textContent = 'New entry';
      if (state.matchNumber || state.teamNumber) {
        const m = state.matchNumber || '?';
        const t = state.teamNumber || '?';
        target.textContent = `Match ${m} · Team ${t}`;
      } else {
        target.textContent = '—';
      }
      cancelBtn.hidden = true;
    }
    el.hidden = false;
  }

  // ---------- Entries screen ----------
  function formatTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function renderEntryRow(e) {
    const row = document.createElement('div');
    row.className = `entry ${e.synced ? 'synced' : 'unsynced'} ${e.alliance || ''}`;

    const stripe = document.createElement('div');
    stripe.className = 'entry-stripe';

    const body = document.createElement('div');
    body.className = 'entry-body';

    const line1 = document.createElement('div');
    line1.className = 'entry-line1';
    const heading = document.createElement('span');
    heading.textContent = `M${e.matchNumber} · Team ${e.teamNumber} · ${(e.alliance || '').toUpperCase()}`;
    const status = document.createElement('span');
    status.className = `entry-status ${e.synced ? 'synced' : 'unsynced'}`;
    status.textContent = e.synced ? 'synced' : 'unsynced';
    line1.appendChild(heading);
    line1.appendChild(status);

    const line2 = document.createElement('div');
    line2.className = 'entry-line2';
    const autoTotal = (e.autoShotsMade || 0) + (e.autoShotsMissed || 0);
    const teleopTotal = (e.teleopShotsMade || 0) + (e.teleopShotsMissed || 0);
    line2.textContent = `Auto ${e.autoShotsMade || 0}/${autoTotal} · Teleop ${e.teleopShotsMade || 0}/${teleopTotal}`;

    const line3 = document.createElement('div');
    line3.className = 'entry-line3';
    line3.textContent = `${e.scoutName || '—'} · ${formatTime(e.timestamp)}${e.eventCode ? ' · ' + e.eventCode : ''}`;

    body.appendChild(line1);
    body.appendChild(line2);
    body.appendChild(line3);

    row.appendChild(stripe);
    row.appendChild(body);

    if (!e.synced) {
      body.addEventListener('click', () => {
        enterEditMode(e);
        closeEntriesScreen();
      });
      const del = document.createElement('button');
      del.className = 'entry-delete';
      del.setAttribute('aria-label', `Delete match ${e.matchNumber}`);
      del.textContent = '🗑';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Delete match ${e.matchNumber} entry?`)) return;
        try {
          await deleteEntry(e.id);
          if (editingId === e.id) exitEditMode();
          toast('Deleted', 'success');
          await refreshUnsyncedBadge();
          await openEntriesScreen();
        } catch (err) {
          console.error(err);
          toast('Delete failed', 'error');
        }
      });
      row.appendChild(del);
    } else {
      const spacer = document.createElement('div');
      spacer.style.width = '0';
      row.appendChild(spacer);
    }

    return row;
  }

  async function openEntriesScreen() {
    const screen = $('#entriesScreen');
    const list = $('#entriesList');
    screen.hidden = false;
    list.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'entries-empty';
    loading.textContent = 'Loading…';
    list.appendChild(loading);
    try {
      const entries = await getRecentEntries(200);
      list.innerHTML = '';
      if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'entries-empty';
        empty.textContent = 'No entries yet.';
        list.appendChild(empty);
        return;
      }
      for (const e of entries) list.appendChild(renderEntryRow(e));
    } catch (err) {
      console.error(err);
      list.innerHTML = '';
      const fail = document.createElement('div');
      fail.className = 'entries-empty';
      fail.textContent = 'Failed to load entries.';
      list.appendChild(fail);
    }
  }

  function closeEntriesScreen() {
    $('#entriesScreen').hidden = true;
  }

  // ---------- Schedule screen ----------
  function makeScheduleTeamSpan(team, userStation) {
    const span = document.createElement('span');
    span.className = 'schedule-team';
    if (!team) {
      span.textContent = '—';
      return span;
    }
    if (team.station === userStation) span.classList.add('me');
    if (team.noShow) span.classList.add('noshow');
    if (team.surrogate) span.classList.add('surrogate');
    const name = (team.teamName || '').trim();
    span.textContent = name ? `${team.displayTeamNumber} ${name}` : String(team.displayTeamNumber);
    return span;
  }

  function renderScheduleRow(match, now) {
    const settings = loadSettings();
    const userStation = settings.station;
    const userAlliance = userStation ? allianceFromStation(userStation) : null;
    const userOnThisMatch = !!(userStation && teamAt(match, userStation));
    const isPast = new Date(match.startTime).getTime() < now.getTime();

    const row = document.createElement('div');
    row.className = 'schedule-row';
    if (isPast) row.classList.add('past');
    if (userOnThisMatch && userAlliance) row.classList.add(userAlliance);

    const header = document.createElement('div');
    header.className = 'schedule-header';
    const title = document.createElement('span');
    title.className = 'schedule-title';
    title.textContent = `Q${match.matchNumber}`;
    const meta = document.createElement('span');
    meta.className = 'schedule-meta';
    meta.textContent = `${formatMatchTime(match.startTime)} · F${match.field}`;
    header.appendChild(title);
    header.appendChild(meta);

    const red = document.createElement('div');
    red.className = 'schedule-alliance schedule-red';
    red.appendChild(makeScheduleTeamSpan(match.teams.find((t) => t.station === 'Red1'), userStation));
    red.appendChild(makeScheduleTeamSpan(match.teams.find((t) => t.station === 'Red2'), userStation));

    const blue = document.createElement('div');
    blue.className = 'schedule-alliance schedule-blue';
    blue.appendChild(makeScheduleTeamSpan(match.teams.find((t) => t.station === 'Blue1'), userStation));
    blue.appendChild(makeScheduleTeamSpan(match.teams.find((t) => t.station === 'Blue2'), userStation));

    row.appendChild(header);
    row.appendChild(red);
    row.appendChild(blue);
    return row;
  }

  function openScheduleScreen() {
    const screen = $('#scheduleScreen');
    const list = $('#scheduleList');
    screen.hidden = false;
    list.innerHTML = '';
    if (!schedule.length) {
      const empty = document.createElement('div');
      empty.className = 'entries-empty';
      empty.textContent = 'No schedule available.';
      list.appendChild(empty);
      return;
    }
    const now = new Date();
    let firstUpcoming = null;
    for (const m of schedule) {
      const row = renderScheduleRow(m, now);
      if (!firstUpcoming && !row.classList.contains('past')) firstUpcoming = row;
      list.appendChild(row);
    }
    // Jump to the next-up match so scouts don't have to scroll past the past ones.
    if (firstUpcoming) {
      requestAnimationFrame(() => firstUpcoming.scrollIntoView({ block: 'start' }));
    }
  }

  function closeScheduleScreen() {
    $('#scheduleScreen').hidden = true;
  }

  // ---------- Toast / status ----------
  let toastTimer = null;
  function toast(msg, kind = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast ' + kind;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
  }

  function renderNetStatus() {
    const el = $('#netStatus');
    if (navigator.onLine) {
      el.textContent = 'online';
      el.classList.add('online'); el.classList.remove('offline');
    } else {
      el.textContent = 'offline';
      el.classList.add('offline'); el.classList.remove('online');
    }
  }

  async function refreshUnsyncedBadge() {
    try {
      const n = await getUnsyncedCount();
      const el = $('#unsyncedCount');
      el.textContent = `${n} unsynced`;
      el.classList.toggle('has', n > 0);
      $('#syncBtn').disabled = n === 0;
    } catch (e) {
      console.warn('badge refresh failed', e);
    }
  }

  // ---------- Settings dialog ----------
  function openSettings() {
    const s = loadSettings();
    $('#endpointUrl').value = s.endpointUrl || '';
    $('#defaultEvent').value = s.defaultEvent || '';
    $('#stationSelect').value = s.station || '';
    $('#deviceIdInput').value = getDeviceId();
    $('#autoSyncToggle').checked = !!s.autoSync;
    $('#autoIncrementToggle').checked = !!s.autoIncrement;
    $('#settingsDialog').hidden = false;
  }
  function closeSettings() { $('#settingsDialog').hidden = true; }
  function saveSettingsFromDialog() {
    const s = loadSettings();
    s.endpointUrl = $('#endpointUrl').value.trim();
    s.defaultEvent = $('#defaultEvent').value.trim();
    s.station = $('#stationSelect').value;
    s.autoSync = $('#autoSyncToggle').checked;
    s.autoIncrement = $('#autoIncrementToggle').checked;
    saveSettings(s);
    const newDev = $('#deviceIdInput').value.trim();
    if (newDev) localStorage.setItem(DEVICE_ID_KEY, newDev);
    // Picking/changing the station may change which team/alliance applies
    // to the current match — re-derive immediately so the form reflects it.
    if (applyScheduleToCurrent()) {
      renderInputs();
      renderAlliance();
    }
    renderEventLabel();
    renderMatchInfo();
    closeSettings();
    toast('Settings saved', 'success');
  }

  // ---------- Init ----------
  async function init() {
    // Repoint any tablet still carrying a previous event's saved settings before
    // anything reads them. Idempotent: no-op once a tablet is on this event.
    migrateSettings();

    bindCounters();
    bindAlliance();
    bindInputs();

    $('#saveBtn').addEventListener('click', onSave);
    $('#syncBtn').addEventListener('click', () => syncAll({ silent: false }));
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#eventSettingsBtn').addEventListener('click', openSettings);
    $('#settingsCancel').addEventListener('click', closeSettings);
    $('#settingsSave').addEventListener('click', saveSettingsFromDialog);
    $('#entriesBtn').addEventListener('click', openEntriesScreen);
    $('#entriesClose').addEventListener('click', closeEntriesScreen);
    $('#scheduleBtn').addEventListener('click', openScheduleScreen);
    $('#scheduleClose').addEventListener('click', closeScheduleScreen);
    $('#cancelEditBtn').addEventListener('click', cancelEdit);

    window.addEventListener('online', () => {
      renderNetStatus();
      const s = loadSettings();
      if (s.autoSync && s.endpointUrl) syncAll({ silent: true });
    });
    window.addEventListener('offline', renderNetStatus);

    const settings = loadSettings();
    state.scoutName = getScoutName();

    // Recover form contents from a prior session (e.g. accidental refresh while offline).
    const draft = loadDraft();
    if (draft && draft.state) {
      Object.assign(state, draft.state);
      if (draft.editingId) {
        editingId = draft.editingId;
        $('#saveBtn').textContent = 'Update Entry';
      }
    }

    // Schedule is fetched in parallel with the rest of init; auto-fill below
    // depends on it so we await before deriving the active match.
    await loadSchedule();

    // Time-based prefill: when a station is configured and there's no
    // in-progress draft/edit, pick the match closest to "now" and derive
    // the team + alliance for the tablet's station.
    if (!editingId && !state.matchNumber && schedule.length && settings.station) {
      const m = activeMatchByTime();
      if (m) {
        state.matchNumber = String(m.matchNumber);
        applyScheduleToCurrent();
        persistDraft();
      }
    }

    renderInputs();
    renderEventLabel();
    renderCounters();
    renderAlliance();
    renderEditBanner();
    renderMatchInfo();
    renderNetStatus();
    await refreshUnsyncedBadge();

    // Skip auto-sync when restoring an in-progress edit so the entry isn't synced
    // mid-edit (which would block the upcoming Update because it'd be marked synced).
    if (!editingId && settings.autoSync && navigator.onLine && settings.endpointUrl) {
      syncAll({ silent: true });
    }

    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('service-worker.js');
      } catch (e) {
        console.warn('SW registration failed', e);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
