#!/usr/bin/env node
/**
 * Files already-indexed tool sessions into the archive.
 *
 * From now on the synchronizer archives review runs as it indexes them, but
 * rows stored before that shipped are still sitting in the sidebar. This is the
 * one-off catch-up for them.
 *
 * Reversible: it only flips `isArchived`, so any session can be restored from
 * the archive view. Run with `--dry-run` first to see the count.
 *
 *   node scripts/archive-automated-sessions.mjs --dry-run
 *   node scripts/archive-automated-sessions.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const AUTOMATED_PROMPT_MARKERS = [
  /^Review this change for security vulnerabilities/i,
  /^You previously flagged these candidate vulnerabilities/i,
];
const AUTOMATED_ENTRYPOINTS = new Set(['sdk-py']);

/** Mirrors `automated-session.service.ts`; kept in sync by hand. */
function isAutomatedTranscript(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return false;
  }

  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (data?.type !== 'user' || data.isMeta === true) continue;
    if (!AUTOMATED_ENTRYPOINTS.has(data.entrypoint)) return false;

    const raw = data.message?.content;
    const text = typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ')
        : '';

    return AUTOMATED_PROMPT_MARKERS.some((marker) => marker.test(text.trim()));
  }

  return false;
}

const dryRun = process.argv.includes('--dry-run');
const databasePath = process.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli', 'auth.db');

if (!existsSync(databasePath)) {
  console.error(`База не найдена: ${databasePath}`);
  process.exit(1);
}

const db = new Database(databasePath, { readonly: dryRun });
const rows = db
  .prepare("SELECT session_id, custom_name, jsonl_path FROM sessions WHERE isArchived = 0 AND jsonl_path IS NOT NULL")
  .all();

/**
 * Rows whose transcript Claude Code has already pruned.
 *
 * The entrypoint marker lives in the transcript, so a deleted file leaves no
 * way to check it. For those the plugin's verbatim opening line is used as the
 * fallback signal — it is a fixed template, not something a human types as a
 * chat title, so it cannot catch a real conversation.
 */
function isOrphanedReviewRow(row) {
  if (!row.jsonl_path || existsSync(row.jsonl_path)) {
    return false;
  }

  return AUTOMATED_PROMPT_MARKERS.some((marker) => marker.test((row.custom_name || '').trim()));
}

const matched = rows.filter((row) => isAutomatedTranscript(row.jsonl_path) || isOrphanedReviewRow(row));

console.log(`База:              ${databasePath}`);
console.log(`Активных сеансов:  ${rows.length}`);
console.log(`Похожи на авто:    ${matched.length}`);

if (matched.length) {
  console.log('\nПримеры:');
  for (const row of matched.slice(0, 5)) {
    console.log(`  - ${(row.custom_name || '(без имени)').slice(0, 60)}`);
  }
}

if (dryRun) {
  console.log('\n--dry-run: ничего не изменено.');
  db.close();
  process.exit(0);
}

const update = db.prepare('UPDATE sessions SET isArchived = 1 WHERE session_id = ?');
const archiveAll = db.transaction((items) => {
  for (const item of items) update.run(item.session_id);
});
archiveAll(matched);
db.close();

console.log(`\nГотово: в архив убрано ${matched.length}. Вернуть можно из раздела «Архив».`);
