import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import SessionTitleModelSettings from '@/modules/settings/tabs/SessionTitleModelSettings';

type ModelSettings = { primaryModel: string; fallbackModel: string };
type Snapshot = {
  settings: ModelSettings;
  models: { id: string; label: string }[] | null;
  legacyModel: string | null;
};

const ENDPOINT = '/api/settings/session-title-models';
const PAIR = { primaryModel: 'text-primary', fallbackModel: 'text-fallback' };
let state: Snapshot;
let writes: ModelSettings[];
let loadFailure: boolean;
let saveFailure: boolean;

const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
});

beforeEach(async () => {
  await i18n.changeLanguage('en');
  state = {
    settings: { primaryModel: '', fallbackModel: '' },
    models: [
      { id: PAIR.primaryModel, label: 'Primary text' },
      { id: PAIR.fallbackModel, label: 'Fallback text' },
      { id: 'text-other', label: 'Another text' },
    ],
    legacyModel: 'legacy-haiku',
  };
  writes = [];
  loadFailure = false;
  saveFailure = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url !== ENDPOINT) return json(404, { success: false });
    if (init.method === 'PUT') {
      if (saveFailure) return json(503, { success: false });
      const settings = JSON.parse(String(init.body)) as ModelSettings;
      writes.push(settings);
      state = { ...state, settings, legacyModel: null };
      return json(200, { success: true, settings });
    }
    return loadFailure ? json(503, { success: false }) : json(200, { success: true, ...state });
  }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

const primary = () => screen.getByRole('combobox', { name: 'Primary model' }) as HTMLSelectElement;
const fallback = () => screen.getByRole('combobox', { name: 'Fallback model' }) as HTMLSelectElement;
const save = () => screen.getByRole('button', { name: 'Save models' }) as HTMLButtonElement;

async function loaded() {
  await screen.findByRole('combobox', { name: 'Primary model' });
}

// GOLDJAXE fork (реестр §4.9-тер): API-настройка, не зависимость от чата/голоса.
describe('SessionTitleModelSettings', () => {
  it('asks for an explicit pair and honestly identifies the temporary legacy model', async () => {
    render(<SessionTitleModelSettings />);
    await loaded();
    expect(primary().value).toBe('');
    expect(fallback().value).toBe('');
    expect(save().disabled).toBe(true);
    expect(screen.getByText(/Choose and save a primary and fallback model/)).toBeTruthy();
    expect(screen.getByText(/previous model legacy-haiku/)).toBeTruthy();
    expect(screen.getByText(/The API provides no prices/)).toBeTruthy();
  });

  it('saves only a complete distinct pair and restores it on another mount', async () => {
    const firstDevice = render(<SessionTitleModelSettings />);
    await loaded();
    fireEvent.change(primary(), { target: { value: PAIR.primaryModel } });
    expect(save().disabled).toBe(true);
    const duplicate = [...fallback().options].find((option) => option.value === PAIR.primaryModel);
    expect(duplicate?.disabled).toBe(true);
    fireEvent.change(fallback(), { target: { value: PAIR.fallbackModel } });
    fireEvent.click(save());
    await screen.findByText('Chat title models saved');
    expect(writes).toEqual([PAIR]);
    expect(localStorage.getItem('session-title-models')).toBeNull();
    firstDevice.unmount();
    render(<SessionTitleModelSettings />);
    await loaded();
    expect(primary().value).toBe(PAIR.primaryModel);
    expect(fallback().value).toBe(PAIR.fallbackModel);
    expect(save().disabled).toBe(true);
    expect(screen.queryByText(/previous model legacy-haiku/)).toBeNull();
  });

  it('keeps an unavailable saved ID visible rather than silently selecting another', async () => {
    state.settings = { ...PAIR, primaryModel: 'removed-primary' };
    state.legacyModel = null;
    render(<SessionTitleModelSettings />);
    await loaded();
    expect(primary().value).toBe('removed-primary');
    expect(primary().selectedOptions[0]?.text).toBe('removed-primary — unavailable');
    expect(fallback().value).toBe(PAIR.fallbackModel);
    expect(screen.getByText(/A saved model is no longer listed/)).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it('keeps saved choices when the API catalog is down', async () => {
    state = { settings: PAIR, models: null, legacyModel: null };
    render(<SessionTitleModelSettings />);
    await loaded();
    expect(primary().value).toBe(PAIR.primaryModel);
    expect(fallback().value).toBe(PAIR.fallbackModel);
    expect(screen.getByText(/The API catalog is unavailable/)).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it('reports an empty text catalog without claiming generation is configured', async () => {
    state.models = [];
    state.legacyModel = null;
    render(<SessionTitleModelSettings />);
    await loaded();
    expect(screen.getByText(/no available text models/)).toBeTruthy();
    expect(save().disabled).toBe(true);
    expect(primary().options.length).toBe(1);
  });

  it('retains the draft after a failed save and never reports a false success', async () => {
    state.settings = PAIR;
    saveFailure = true;
    render(<SessionTitleModelSettings />);
    await loaded();
    fireEvent.change(primary(), { target: { value: 'text-other' } });
    fireEvent.click(save());
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not save the models/);
    expect(primary().value).toBe('text-other');
    expect(state.settings).toEqual(PAIR);
    expect(screen.queryByText('Chat title models saved')).toBeNull();
    expect(save().disabled).toBe(false);
  });

  it('allows retrying a failed initial load', async () => {
    loadFailure = true;
    render(<SessionTitleModelSettings />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load model settings/);
    loadFailure = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await loaded();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(primary().disabled).toBe(false);
  });

  it('renders the dedicated setting in Russian', async () => {
    await i18n.changeLanguage('ru');
    render(<SessionTitleModelSettings />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Основная модель' })).toBeTruthy());
    expect(screen.getByText('Модель для названий чатов')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Резервная модель' })).toBeTruthy();
  });
});
