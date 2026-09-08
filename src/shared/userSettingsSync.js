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
 */

import { hydrateVoiceConfig, resetVoiceConfigCache } from '@/shared/voiceConfig';

import { api } from '@/shared/api';

// localStorage keys that are safe, non-secret UI/composer preferences.
// Keep this in sync with the settings the app reads from localStorage.
export const SYNCED_SETTINGS_KEYS = [
  'selected-provider',
  'claude-model',
  'cursor-model',
  'codex-model',
  'opencode-model',
  'claude-effort',
  'cursor-effort',
  'codex-effort',
  'opencode-effort',
  'userLanguage',
  'theme',
  'uiPreferences',
  'codeEditorWordWrap',
  'codeEditorShowMinimap',
  'codeEditorLineNumbers',
  'codeEditorFontSize',
  'claude-settings',
  'cursor-tools-settings',
  'codex-settings',
  'file-tree-view-mode',
  'activeTab',
  'tasks-enabled',
  'notificationSoundEnabled',
  'starredProjects',
  // Where the user dragged the floating quick-settings handle.
  'quickSettingsHandlePosition',
  // "I dismissed the GitHub star badge" — an explicit choice, so it should not
  // come back on every new device or after a cache clear.
  'CLOUDCLI_HIDE_GITHUB_STAR',
];

// permissionMode-* keys are per-project; they are matched by prefix.
const PREFIX_SYNCED_KEYS = ['permissionMode-'];

const MIGRATION_DONE_KEY = 'user-settings-migrated';

// Keys that app code writes to localStorage automatically on first load (i18n
// language detector, ThemeContext system-preference fallback) even without an
// explicit user choice. They are excluded from the one-time migration so a
// default doesn't get fossilized as a cross-device preference; an explicit
// later change is still captured by pushLocalSettingsToServer.
const AUTO_DEFAULT_KEYS = ['userLanguage', 'theme'];

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
    // (e.g. useUiPreferences re-emitting `ui-preferences:sync`) still see the
    // guard and don't echo the server values back as a fresh push.
    setTimeout(() => { applyingServerSettings = false; }, 0);
  }
}

/**
 * Applies live effects for settings that are read synchronously at app start
 * (theme, i18n language) so pulling them from the DB on a reload does not
 * require a full page refresh or leave a visible mismatch.
 *
 * Theme is NOT applied by touching the DOM class directly — ThemeContext owns
 * `isDarkMode` in React state, and a direct classList change would be reverted
 * by its next render. Instead we dispatch `cloudcli:settings-applied`, which
 * ThemeContext listens for and adopts into its state (the source of truth).
 * i18n is its own source of truth, so `changeLanguage` is called directly.
 */
async function applyLiveEffects(settings) {
  if (!settings || typeof settings !== 'object') {
    return;
  }

  // Language: switch i18n if it differs from the current one.
  //
  // Imported lazily on purpose. `@/modules/i18n` configures i18next at module
  // load and reads the preference mirror to do it, so a static import here
  // would pull that read into every module that merely imports this file.
  if (typeof settings.userLanguage === 'string') {
    try {
      const { i18n } = await import('@/modules/i18n');
      if (i18n && i18n.language !== settings.userLanguage) {
        await i18n.changeLanguage(settings.userLanguage);
      }
    } catch {
      // i18n not available — ignore.
    }
  }

  // Theme (and any other React-owned setting): notify context providers to
  // re-read localStorage and sync their state.
  try {
    window.dispatchEvent(new Event('cloudcli:settings-applied'));
  } catch {
    // Non-DOM environment — ignore.
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
      applyToLocalStorage(settings);
      await applyLiveEffects(settings);
      return;
    }

    // Empty server blob. Migrate existing local settings up exactly once: the
    // migration flag guards against re-running (e.g. if the blob is later
    // cleared), which would otherwise re-seed auto-written defaults.
    if (hasMigrated()) {
      return;
    }

    // Exclude auto-written defaults from the one-time migration: i18n writes
    // `userLanguage` and ThemeContext writes `theme` on first load even when the
    // user never chose them, so migrating them would fossilize a default as an
    // explicit cross-device choice. A later explicit change is captured by push.
    const local = readLocalSettings();
    for (const key of AUTO_DEFAULT_KEYS) {
      delete local[key];
    }
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

// UI-preferences hook (useUiPreferences) fires this on every toggle change; the
// quick-settings panel (raw params, thinking, Ctrl+Enter, voice) writes only
// through that hook, so without listening here its changes never reach the DB.
const UI_PREFERENCES_SYNC_EVENT = 'ui-preferences:sync';
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
 * Covers three change sources:
 *   - `ui-preferences:sync` — the quick-settings panel and any useUiPreferences
 *     consumer (same-tab, since they don't emit a native `storage` event);
 *   - native `storage` — settings changed in another tab of the same origin;
 *   - direct localStorage writes are patched below so single-key writers
 *     (model/effort/provider selectors) also trigger a push without each having
 *     to import this module.
 */
export function startUserSettingsAutoSync() {
  if (autoSyncInstalled || typeof window === 'undefined') {
    return () => {};
  }
  autoSyncInstalled = true;

  const handleUiPrefsSync = () => schedulePush();
  const handleStorage = (event) => {
    if (event.key && isSyncedKey(event.key)) {
      schedulePush();
    }
  };

  window.addEventListener(UI_PREFERENCES_SYNC_EVENT, handleUiPrefsSync);
  window.addEventListener('storage', handleStorage);

  // Same-tab localStorage.setItem does not emit a `storage` event, so patch it
  // to schedule a push whenever an allowlisted key changes. This catches the
  // single-key writers (selected-provider, *-model, *-effort, editor prefs,
  // file-tree mode, …) that write localStorage directly without a custom event.
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
    window.removeEventListener(UI_PREFERENCES_SYNC_EVENT, handleUiPrefsSync);
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
