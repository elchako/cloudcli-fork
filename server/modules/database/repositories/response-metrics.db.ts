import { getConnection } from '@/modules/database/connection.js';
import type { ResponseMetrics } from '@/shared/types.js';

// GOLDJAXE fork (реестр §26): три ключа привязки — app session, transcript, строка.
export type PersistedResponseMetrics = {
  sessionId: string;
  providerSessionId: string | null;
  targetId?: string;
  anchorId?: string;
  metrics: ResponseMetrics;
};

type MetricsRow = { target_id: string; anchor_id: string; metrics_json: string };

export const responseMetricsDb = {
  save(record: PersistedResponseMetrics): void {
    getConnection().prepare(`
      INSERT INTO response_metrics (run_id, session_id, provider_session_id, target_id, anchor_id, metrics_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO NOTHING
    `).run(record.metrics.runId, record.sessionId, record.providerSessionId,
      record.targetId ?? null, record.anchorId ?? null, JSON.stringify(record.metrics));
  },

  listForTranscript(sessionId: string, providerSessionId: string): Array<{
    targetId: string; anchorId: string; metrics: ResponseMetrics;
  }> {
    const rows = getConnection().prepare(`
      SELECT target_id, anchor_id, metrics_json FROM response_metrics
      WHERE session_id = ? AND provider_session_id = ? AND target_id IS NOT NULL AND anchor_id IS NOT NULL
    `).all(sessionId, providerSessionId) as MetricsRow[];
    return rows.flatMap((row) => {
      try {
        return [{ targetId: row.target_id, anchorId: row.anchor_id, metrics: JSON.parse(row.metrics_json) as ResponseMetrics }];
      } catch {
        // Повреждённая запись не должна ломать чтение всей переписки.
        return [];
      }
    });
  },
};
