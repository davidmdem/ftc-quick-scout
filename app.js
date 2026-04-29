// FTC Scouting PWA — local-first capture with Google Sheet sync.
(() => {
  const DB_NAME = 'ftc-scouting';
  const DB_VERSION = 1;
  const STORE = 'entries';

  const SETTINGS_KEY = 'ftc-scouting:settings';
  const DEVICE_ID_KEY = 'ftc-scouting:deviceId';
  const SCOUT_NAME_KEY = 'ftc-scouting:scoutName';

  // Paste the Apps Script /exec URL here once and commit. All tablets that
  // load the hosted app will pick it up automatically. Per-tablet Settings
  // can still override; clearing the override falls back to this default.
  const DEFAULT_ENDPOINT = 'https://script.google.com/macros/s/AKfycbxswZjTaTSFYGw971fFJ_mFmMuzdALdwDInD2rhe8WZ_WUuu6xR9oyeaGTB8zBfn1Ww/exec';

  const COUNTER_KEYS = ['autoShotsMade', 'autoShotsMissed', 'teleopShotsMade', 'teleopShotsMissed'];

  // ---------- Settings & device id ----------
  function loadSettings() {
    const defaults = {
      endpointUrl: DEFAULT_ENDPOINT,
      defaultEvent: 'FTCCMP1',
      autoSync: true,
      autoIncrement: false,
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

  // ---------- UI state ----------
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
  }

  function bindCounters() {
    $$('.counter').forEach((el) => {
      const key = el.dataset.key;
      $('.inc', el).addEventListener('click', () => {
        state[key] = (state[key] || 0) + 1;
        renderCounters();
      });
      $('.dec', el).addEventListener('click', () => {
        state[key] = Math.max(0, (state[key] || 0) - 1);
        renderCounters();
      });
    });
  }
  function bindAlliance() {
    $$('.alliance').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.alliance = btn.dataset.alliance;
        renderAlliance();
      });
    });
  }
  function bindInputs() {
    $('#scoutName').addEventListener('input', (e) => {
      state.scoutName = e.target.value;
      setScoutName(state.scoutName.trim());
    });
    $('#matchNumber').addEventListener('input', (e) => state.matchNumber = e.target.value);
    $('#teamNumber').addEventListener('input', (e) => state.teamNumber = e.target.value);
    $('#notes').addEventListener('input', (e) => state.notes = e.target.value);
  }

  function resetForNextMatch() {
    const settings = loadSettings();
    const prev = parseInt(state.matchNumber, 10);
    state.matchNumber = settings.autoIncrement && Number.isFinite(prev) ? String(prev + 1) : '';
    state.teamNumber = '';
    state.alliance = null;
    state.notes = '';
    for (const k of COUNTER_KEYS) state[k] = 0;
    renderCounters();
    renderAlliance();
    renderInputs();
  }

  function validate() {
    const settings = loadSettings();
    if (!settings.defaultEvent) return 'Set event in Settings';
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
    s.autoSync = $('#autoSyncToggle').checked;
    s.autoIncrement = $('#autoIncrementToggle').checked;
    saveSettings(s);
    const newDev = $('#deviceIdInput').value.trim();
    if (newDev) localStorage.setItem(DEVICE_ID_KEY, newDev);
    renderEventLabel();
    closeSettings();
    toast('Settings saved', 'success');
  }

  // ---------- Init ----------
  async function init() {
    bindCounters();
    bindAlliance();
    bindInputs();

    $('#saveBtn').addEventListener('click', onSave);
    $('#syncBtn').addEventListener('click', () => syncAll({ silent: false }));
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#eventSettingsBtn').addEventListener('click', openSettings);
    $('#settingsCancel').addEventListener('click', closeSettings);
    $('#settingsSave').addEventListener('click', saveSettingsFromDialog);

    window.addEventListener('online', () => {
      renderNetStatus();
      const s = loadSettings();
      if (s.autoSync && s.endpointUrl) syncAll({ silent: true });
    });
    window.addEventListener('offline', renderNetStatus);

    const settings = loadSettings();
    state.scoutName = getScoutName();
    renderInputs();
    renderEventLabel();
    renderCounters();
    renderAlliance();
    renderNetStatus();
    await refreshUnsyncedBadge();

    if (settings.autoSync && navigator.onLine && settings.endpointUrl) {
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
