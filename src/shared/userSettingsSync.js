/**
 * Per-user settings sync (localStorage <-> server DB).
 *
 * Upstream persists UI/composer preferences only in localStorage, so they are
 * lost on cache clear, relogin or origin/port change and never follow the user
 * across devices. This module mirrors a curated allowlist of localStorage keys
 * to a server-side `user_settings` blob:
 *   - on login: pull the DB blob and write it into localStorage BEFORE the app
 *     reads those keys, so existing consumers (theme, i18n, provider state, …)
 *     pick up the user's real values;
 *   - on change: push the current allowlisted keys back to the DB (debounced).
 *
 * This blob stays secret-free: it is plain JSON in SQLite, and the repository
 * strips key-like fields on the way in. Voice settings therefore do NOT live
 * here even though they are user preferences — they carry an apiKey, so they
 * get their own table with the key sealed by AES-256-GCM (see
 * `shared/voiceConfig` and `server/modules/database/repositories/voice-settings.ts`).
 * `hydrateVoiceConfig` is kicked off alongside the pull below so both stores
 * are ready at the same moment.
 *
 * Since 1.37.3 upstream keeps theme, language, UI preferences, permissions,
 * editor settings, the selected provider and project stars in its own per-user
 * store (`shared/userSettings`, `user_preferences`) and reads the old
 * localStorage keys only for a one-time migration. Those keys are left to it:
 * mirroring them here re-applied a frozen copy on every load, which reverted a
 * changed language and re-starred projects that had been un-starred. This module
 * covers only what upstream still keeps in localStorage alone.
 */

import { hydrateVoiceConfig } from '@/shared/voiceConfig';
import { api } from '@/shared/api';

// localStorage keys that are safe, non-secret UI/composer preferences.
// Keep this in sync with the settings the app reads from localStorage — and
// leave out whatever upstream's own preference store owns (see above).
export const SYNCED_SETTINGS_KEYS = [
  'claude-model',
  'cursor-model',
  'codex-model',
  'opencode-model',
  'claude-effort',
  'cursor-effort',
  'codex-effort',
  'opencode-effort',
  'file-tree-view-mode',
  'activeTab',
  'notificationSoundEnabled',
  // Where the user dragged the floating quick-settings handle.
  'quickSettingsHandlePosition',
  // Whether the quick-settings panel is pinned as a dock, and its open tab.
  'quickSettingsPanel',
  // The width the sidebar was dragged to.
  'sidebar-width',
  // "I dismissed the GitHub star badge" — an explicit choice, so it should not
  // come back on every new device or after a cache clear.
  'CLOUDCLI_HIDE_GITHUB_STAR',
];

// permissionMode-* keys are per-project; they are matched by prefix.
const PREFIX_SYNCED_KEYS = ['permissionMode-'];

const MIGRATION_DONE_KEY = 'user-settings-migrated';

function isSyncedKey(key) {
  if (SYNCED_SETTINGS_KEYS.includes(key)) {
    return true;
  }
  return PREFIX_SYNCED_KEYS.some((prefix) => key.startsWith(prefix));
}

/** Reads all currently-set allowlisted keys from localStorage into an object. */
export function readLocalSettings() {
  const out = {};
  try {
    for (const key of SYNCED_SETTINGS_KEYS) {
      const value = localStorage.getItem(key);
      if (value !== null) {
        out[key] = value;
      }
    }
    // Prefix keys need a full scan.
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && PREFIX_SYNCED_KEYS.some((p) => key.startsWith(p))) {
        out[key] = localStorage.getItem(key);
      }
    }
  } catch {
    // localStorage may be unavailable (privacy mode) — return what we have.
  }
  return out;
}

// Set while applying server-pulled settings to localStorage so the auto-sync
// patch below does not echo those writes straight back to the server.
let applyingServerSettings = false;

/** Writes a settings object (string values) into localStorage. */
function applyToLocalStorage(settings) {
  if (!settings || typeof settings !== 'object') {
    return;
  }
  applyingServerSettings = true;
  try {
    for (const [key, value] of Object.entries(settings)) {
      if (!isSyncedKey(key) || typeof value !== 'string') {
        continue;
      }
      localStorage.setItem(key, value);
    }
  } catch {
    // Ignore write failures.
  } finally {
    // Reset after the current task so React effects that react to these writes
    // still see the guard and don't echo the server values back as a fresh push.
    setTimeout(() => { applyingServerSettings = false; }, 0);
  }
}

/**
 * Pulls the user's settings from the DB and applies them to localStorage.
 * On first login (empty DB blob) it migrates existing localStorage values up to
 * the server so nothing is lost. Call once right after authentication, and
 * before the settings-reading UI mounts.
 */
export async function loadUserSettingsIntoLocalStorage() {
  // Voice config lives in its own table (it carries an encrypted secret), but it
  // must be ready at the same moment as the rest of the settings — the mic
  // button and read-aloud read it synchronously. Fetched in parallel; a failure
  // here must not block the main settings pull.
  void hydrateVoiceConfig();

  try {
    const response = await api.getUserSettings();
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    const settings = data && data.settings ? data.settings : {};

    const hasServerSettings = Object.keys(settings).length > 0;
    if (hasServerSettings) {
      // Keys upstream's store now owns may still sit in an older blob; the
      // allowlist filter in applyToLocalStorage leaves them alone.
      applyToLocalStorage(settings);
      return;
    }

    // Empty server blob. Migrate existing local settings up exactly once: the
    // migration flag guards against re-running (e.g. if the blob is later
    // cleared), which would otherwise re-seed auto-written defaults.
    if (hasMigrated()) {
      return;
    }

    const local = readLocalSettings();
    if (Object.keys(local).length > 0) {
      await api.updateUserSettings(local, { merge: false });
    }
    markMigrated();
  } catch {
    // Network/DB error — app still works from localStorage.
  }
}

/**
 * Pushes the current allowlisted localStorage keys to the DB. Uses a MERGE (not
 * replace): keys absent from localStorage at push time (not yet initialized,
 * or cleared) must not delete their stored counterparts — otherwise a flush
 * fired while some keys are missing would wipe them from the DB. Debounce this
 * at the call site (e.g. on a storage change) to avoid excessive writes.
 */
export async function pushLocalSettingsToServer() {
  try {
    const local = readLocalSettings();
    if (Object.keys(local).length === 0) {
      return;
    }
    await api.updateUserSettings(local, { merge: true });
  } catch {
    // Ignore — a later push will retry.
  }
}

const AUTOSYNC_DEBOUNCE_MS = 800;

let autoSyncInstalled = false;
let pushTimer = null;

function schedulePush() {
  // Don't bounce server-pulled settings back to the server.
  if (applyingServerSettings) {
    return;
  }
  if (pushTimer) {
    clearTimeout(pushTimer);
  }
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushLocalSettingsToServer();
  }, AUTOSYNC_DEBOUNCE_MS);
}

/**
 * Installs listeners that mirror every allowlisted settings change up to the DB,
 * not just the ones made through the big Settings modal's Save button. Debounced
 * so a burst of toggles collapses into one write. Idempotent — safe to call on
 * each login. Returns a teardown function.
 *
 * Covers two change sources:
 *   - native `storage` — settings changed in another tab of the same origin;
 *   - direct localStorage writes are patched below so single-key writers
 *     (model/effort selectors, permission modes, …) also trigger a push without
 *     each having to import this module.
 */
export function startUserSettingsAutoSync() {
  if (autoSyncInstalled || typeof window === 'undefined') {
    return () => {};
  }
  autoSyncInstalled = true;

  const handleStorage = (event) => {
    if (event.key && isSyncedKey(event.key)) {
      schedulePush();
    }
  };

  window.addEventListener('storage', handleStorage);

  // Same-tab localStorage.setItem does not emit a `storage` event, so patch it
  // to schedule a push whenever an allowlisted key changes. This catches the
  // single-key writers (*-model, *-effort, permission modes, file-tree mode, …)
  // that write localStorage directly without a custom event.
  const originalSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    originalSetItem(key, value);
    try {
      if (isSyncedKey(key)) {
        schedulePush();
      }
    } catch {
      // Never let sync bookkeeping break a real write.
    }
  };

  return () => {
    window.removeEventListener('storage', handleStorage);
    localStorage.setItem = originalSetItem;
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
    autoSyncInstalled = false;
  };
}

function markMigrated() {
  try {
    localStorage.setItem(MIGRATION_DONE_KEY, '1');
  } catch {
    // Ignore.
  }
}

function hasMigrated() {
  try {
    return localStorage.getItem(MIGRATION_DONE_KEY) === '1';
  } catch {
    return false;
  }
}
