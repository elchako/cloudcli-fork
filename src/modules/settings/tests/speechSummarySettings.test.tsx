import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import SpeechSummarySettings from '@/modules/settings/tabs/SpeechSummarySettings';
import { api } from '@/shared/api';
import { resetSpeechSummaryStatusForTests } from '@/shared/speechSummary';
import type { SpeechSummaryModel } from '@/shared/speechSummary';
import { resetVoiceConfigCache, VOICE_CONFIG_DEFAULTS } from '@/shared/voiceConfig';
import type { VoiceConfig } from '@/shared/voiceConfig';

vi.mock('@/shared/api', () => ({ api: {
  getVoiceSettings: vi.fn(), updateVoiceSettings: vi.fn(),
  speechSummary: { status: vi.fn(), models: vi.fn(), summarize: vi.fn() },
} }));

// GOLDJAXE fork (реестр §4.16-тер): реальные cache/hook/loader, подменён только API.
let stored: VoiceConfig;
let writes: Partial<VoiceConfig>[];
let models: SpeechSummaryModel[] | null;
let source: string;
let saveFails: boolean;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const primary = () => screen.getByRole('combobox', { name: 'Primary summary model' }) as HTMLSelectElement;
const fallback = () => screen.getByRole('combobox', { name: 'Fallback summary model' }) as HTMLSelectElement;

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
  resetSpeechSummaryStatusForTests();
  resetVoiceConfigCache();
  stored = { ...VOICE_CONFIG_DEFAULTS, baseUrl: 'https://voice.test/v1', ttsModel: 'edge-tts', ttsVoice: 'voice-unchanged',
    speechSummaryModel: 'old-primary', speechSummaryFallbackModel: '', speechSummaryPrompt: 'Own instruction.' };
  writes = [];
  saveFails = false;
  source = 'api';
  models = [
    { id: 'old-primary', label: 'Primary API label', catalogProvider: 'anthropic' },
    { id: 'gpt-6.1-sol', label: 'GPT API label', catalogProvider: 'openai' },
    { id: 'new-text', label: 'Other API label', catalogProvider: 'custom-owner' },
  ];
  vi.mocked(api.getVoiceSettings).mockImplementation(async () => json({ voice: { ...stored, hasApiKey: false } }));
  vi.mocked(api.updateVoiceSettings).mockImplementation(async (patch) => {
    if (saveFails) return json({ error: { message: 'Save refused' } }, 503);
    writes.push(patch as Partial<VoiceConfig>);
    stored = { ...stored, ...patch as Partial<VoiceConfig> };
    return json({ success: true, voice: { ...stored, hasApiKey: false } });
  });
  vi.mocked(api.speechSummary.status).mockImplementation(async () => json({ available: true, enabled: true,
    model: stored.speechSummaryModel || 'legacy-default', defaultModel: 'legacy-default', defaultPrompt: 'Built-in instruction.', minChars: 700 }));
  vi.mocked(api.speechSummary.models).mockImplementation(async () => json({
    models: models?.map((model) => model.id) ?? [], modelOptions: models, source,
  }));
});

afterEach(async () => {
  resetVoiceConfigCache();
  await i18n.changeLanguage('en');
});

async function loaded() {
  await waitFor(() => expect(primary().value).toBe(stored.speechSummaryModel));
  await screen.findByRole('button', { name: 'Refresh model list' });
}

describe('SpeechSummarySettings', () => {
  it('показывает прежний primary и все текстовые семейства, группируя только по API', async () => {
    render(<SpeechSummarySettings />);
    await loaded();
    expect(primary().value).toBe('old-primary');
    expect(fallback().value).toBe('');
    expect(screen.getByText(/recommend a small, fast model/)).toBeTruthy();
    expect(primary().querySelector('optgroup[label="OpenAI"]')).toBeTruthy();
    expect(primary().querySelector('optgroup[label="custom-owner"]')).toBeTruthy();
    expect([...primary().options].some((option) => option.text === 'GPT API label (gpt-6.1-sol)')).toBe(true);
    expect(writes).toEqual([]);
  });

  it('сохраняет только резерв и восстанавливает пару после перемонтирования', async () => {
    const first = render(<SpeechSummarySettings />);
    await loaded();
    expect([...fallback().options].find((option) => option.value === 'old-primary')?.disabled).toBe(true);
    fireEvent.change(fallback(), { target: { value: 'gpt-6.1-sol' } });
    await screen.findByText('Saved');
    expect(writes).toEqual([{ speechSummaryFallbackModel: 'gpt-6.1-sol' }]);
    expect(stored.speechSummaryModel).toBe('old-primary');
    expect(stored.speechSummaryPrompt).toBe('Own instruction.');
    expect(stored.ttsModel).toBe('edge-tts');
    expect(stored.ttsVoice).toBe('voice-unchanged');
    expect([...primary().options].find((option) => option.value === 'gpt-6.1-sol')?.disabled).toBe(true);
    first.unmount();
    resetVoiceConfigCache();
    render(<SpeechSummarySettings />);
    await loaded();
    expect(fallback().value).toBe('gpt-6.1-sol');
  });

  it('прежний server default не заменяется первой записью, резерв автоматически не выбирается', async () => {
    stored.speechSummaryModel = '';
    render(<SpeechSummarySettings />);
    await loaded();
    expect(primary().value).toBe('');
    expect(primary().selectedOptions[0]?.text).toBe('Default — legacy-default');
    expect(fallback().value).toBe('');
    expect(writes).toEqual([]);
  });

  it('refresh сохраняет отсутствующий выбранный ID и показывает предупреждение', async () => {
    render(<SpeechSummarySettings />);
    await loaded();
    models = models!.filter((model) => model.id !== 'old-primary');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh model list' }));
    await screen.findByText(/A selected model is no longer in the API catalog/);
    expect(vi.mocked(api.speechSummary.models)).toHaveBeenLastCalledWith(true);
    expect(primary().value).toBe('old-primary');
    expect(primary().selectedOptions[0]?.text).toBe('old-primary');
    expect(writes).toEqual([]);
  });

  it('недоступный каталог не стирает пару; обновление доступно и без каталога', async () => {
    stored.speechSummaryFallbackModel = 'kept-fallback';
    models = null;
    render(<SpeechSummarySettings />);
    await loaded();
    await screen.findByText(/The API catalog is unavailable/);
    expect(primary().value).toBe('old-primary');
    expect(fallback().value).toBe('kept-fallback');
    expect(writes).toEqual([]);
  });

  it('устаревший список помечается, пустой список отличается от сбоя', async () => {
    source = 'api-cache';
    const first = render(<SpeechSummarySettings />);
    await loaded();
    expect(screen.getByText(/Showing the last known list/)).toBeTruthy();
    first.unmount();
    source = 'api'; models = [];
    render(<SpeechSummarySettings />);
    await loaded();
    expect(screen.getByText(/currently has no text models/)).toBeTruthy();
    expect(primary().value).toBe('old-primary');
  });

  it('ошибка сохранения видна, успешное сообщение не выдаётся и сохранённая пара остаётся', async () => {
    saveFails = true;
    render(<SpeechSummarySettings />);
    await loaded();
    fireEvent.change(fallback(), { target: { value: 'gpt-6.1-sol' } });
    expect((await screen.findByRole('alert')).textContent).toBe('Save refused');
    expect(stored.speechSummaryFallbackModel).toBe('');
    expect(fallback().value).toBe('');
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('основную можно заменить отдельно, не меняя резерв, инструкцию или TTS', async () => {
    stored.speechSummaryFallbackModel = 'gpt-6.1-sol';
    render(<SpeechSummarySettings />);
    await loaded();
    fireEvent.change(primary(), { target: { value: 'new-text' } });
    await screen.findByText('Saved');
    expect(writes).toEqual([{ speechSummaryModel: 'new-text' }]);
    expect(fallback().value).toBe('gpt-6.1-sol');
    expect(stored.speechSummaryPrompt).toBe('Own instruction.');
    expect(stored.ttsVoice).toBe('voice-unchanged');
  });

  it('русская локализация пары, refresh и честной рекомендации', async () => {
    await i18n.changeLanguage('ru');
    render(<SpeechSummarySettings />);
    await screen.findByRole('combobox', { name: 'Основная модель сводки' });
    expect(screen.getByRole('combobox', { name: 'Резервная модель сводки' })).toBeTruthy();
    await screen.findByRole('button', { name: 'Обновить список моделей' });
    expect(screen.getByText(/Рекомендуем небольшую быструю модель, но выбор за вами/)).toBeTruthy();
  });
});
