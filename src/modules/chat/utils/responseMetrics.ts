// GOLDJAXE fork (реестр §26): общие компактные форматы для истории и текущего статуса.
export function formatResponseDuration(durationMs: number, language: string, precise = false): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';
  const ru = language.startsWith('ru');
  const [h, m, s] = ru ? ['ч', 'мин', 'с'] : ['h', 'm', 's'];
  const total = Math.floor(durationMs / 1000);
  if (precise && durationMs < 1000) {
    return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(durationMs)} ${ru ? 'мс' : 'ms'}`;
  }
  if (total >= 3600) {
    return `${Math.floor(total / 3600)} ${h} ${String(Math.floor(total / 60) % 60).padStart(2, '0')} ${m}${precise ? ` ${String(total % 60).padStart(2, '0')} ${s}` : ''}`;
  }
  if (total >= 60) return `${Math.floor(total / 60)} ${m} ${total % 60} ${s}`;
  return `${total} ${s}`;
}

export function formatGenerationSpeed(speed: number | undefined, language: string): string | null {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) return null;
  const format = new Intl.NumberFormat(language, { maximumFractionDigits: speed < 10 ? 1 : 0 });
  return speed < 0.1 ? `<${format.format(0.1)}` : format.format(speed);
}
