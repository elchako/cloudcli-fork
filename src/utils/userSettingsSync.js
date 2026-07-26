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
 * Secrets are never synced. `voiceConfig` holds an apiKey in plaintext and the
 * server store has no at-rest encryption, so the whole key is intentionally
 * excluded from the allowlist and stays device-local.
 */

import i18n from '../i18n/config';
import { api } from './api';

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
  'codeEditorMinimap',
  'codeEditorLineNumbers',
  'codeEditorFontSize',
  'claude-settings',
  'cursor-tools-settings',
  'codex-settings',
  'file-tree-view-mode',
  'activeTab',
  'tasks-enabled',
  'notificationSoundEnabled',
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

/** Writes a settings object (string values) into localStorage. */
function applyToLocalStorage(settings) {
  if (!settings || typeof settings !== 'object') {
    return;
  }
  try {
    for (const [key, value] of Object.entries(settings)) {
      if (!isSyncedKey(key) || typeof value !== 'string') {
        continue;
      }
      localStorage.setItem(key, value);
    }
  } catch {
    // Ignore write failures.
  }
}

/**
 * Applies live effects for settings that are read synchronously at app start
 * (theme class on <html>, i18n language) so pulling them from the DB on a
 * reload does not require a full page refresh or leave a visible mismatch.
 */
async function applyLiveEffects(settings) {
  if (!settings || typeof settings !== 'object') {
    return;
  }

  // Theme: toggle the `dark` class the same way ThemeContext does.
  if (typeof settings.theme === 'string') {
    try {
      const root = document.documentElement;
      if (settings.theme === 'dark') {
        root.classList.add('dark');
      } else if (settings.theme === 'light') {
        root.classList.remove('dark');
      }
    } catch {
      // Non-DOM environment — ignore.
    }
  }

  // Language: switch i18n if it differs from the current one.
  if (typeof settings.userLanguage === 'string') {
    try {
      if (i18n && i18n.language !== settings.userLanguage) {
        await i18n.changeLanguage(settings.userLanguage);
      }
    } catch {
      // i18n not available — ignore.
    }
  }
}

/**
 * Pulls the user's settings from the DB and applies them to localStorage.
 * On first login (empty DB blob) it migrates existing localStorage values up to
 * the server so nothing is lost. Call once right after authentication, and
 * before the settings-reading UI mounts.
 */
export async function loadUserSettingsIntoLocalStorage() {
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

    // Empty server blob: one-time migration of existing local settings up.
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

function markMigrated() {
  try {
    localStorage.setItem(MIGRATION_DONE_KEY, '1');
  } catch {
    // Ignore.
  }
}

export { isSyncedKey };
