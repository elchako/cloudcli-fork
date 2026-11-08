import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import ImageGenerationSettings from '@/modules/settings/tabs/ImageGenerationSettings';
import type { ImageGenerationSettings as Profiles } from '@/shared/imageGeneration';

const ENDPOINT = '/api/settings/image-generation';
const defaults = (): Profiles => ({ defaultProfile: 'standard', profiles: {
  draft: { model: 'gpt-image-2.6', quality: 'low' },
  standard: { model: 'gpt-image-2.6', quality: 'auto' },
  final: { model: 'gpt-image-2.6', quality: 'high' },
} });
let state: { settings: Profiles; models: { id: string; label: string; catalogProvider?: string }[] | null };
let writes: Profiles[];
let refreshes: number;
let fail: boolean;
const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  await i18n.changeLanguage('en');
  state = { settings: defaults(), models: [
    { id: 'gpt-image-2.6', label: 'GPT Image 2.6', catalogProvider: 'openai' },
    { id: 'gpt-image-2.6-flare', label: 'Flare', catalogProvider: 'openai' },
    { id: 'gpt-image-2.6-sunburst', label: 'Sunburst', catalogProvider: 'openai' },
  ] };
  writes = [];
  refreshes = 0;
  fail = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (!String(url).startsWith(ENDPOINT)) return json(404, {});
    if (fail) return json(503, { success: false });
    if (init.method === 'PUT') {
      const settings = JSON.parse(String(init.body)) as Profiles;
      writes.push(settings);
      state = { ...state, settings };
      return json(200, { success: true, settings });
    }
    if (String(url).includes('refresh=1')) refreshes++;
    return json(200, { success: true, ...state });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const loaded = () => screen.findByRole('combobox', { name: 'Default profile' });
const model = (profile: string) => within(screen.getByRole('group', { name: profile })).getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
const quality = (profile: string) => within(screen.getByRole('group', { name: profile })).getByRole('combobox', { name: 'Quality' }) as HTMLSelectElement;
const save = () => screen.getByRole('button', { name: 'Save profiles' }) as HTMLButtonElement;

describe('ImageGenerationSettings', () => {
  it('показывает независимые профили без выдуманных свойств Flare и Sunburst', async () => {
    render(<ImageGenerationSettings />);
    await loaded();
    expect(model('Draft').value).toBe('gpt-image-2.6');
    expect(quality('Draft').value).toBe('low');
    expect(quality('Final').value).toBe('high');
    expect(save().disabled).toBe(true);
    expect(screen.getByText(/not automatically labeled faster or better/)).toBeTruthy();
    expect(screen.getByText(/not a guarantee/)).toBeTruthy();
  });

  it('сохраняет выбор на сервере и восстанавливает на другом устройстве', async () => {
    const first = render(<ImageGenerationSettings />);
    await loaded();
    fireEvent.change(model('Final'), { target: { value: 'gpt-image-2.6-sunburst' } });
    fireEvent.change(quality('Final'), { target: { value: 'medium' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Default profile' }), { target: { value: 'draft' } });
    fireEvent.click(save());
    await screen.findByText('Image profiles saved');
    expect(writes.length).toBe(1);
    expect(writes[0].profiles.final).toEqual({ model: 'gpt-image-2.6-sunburst', quality: 'medium' });
    expect(localStorage.getItem('image-generation')).toBeNull();
    first.unmount();
    render(<ImageGenerationSettings />);
    expect((await loaded() as HTMLSelectElement).value).toBe('draft');
    expect(model('Final').value).toBe('gpt-image-2.6-sunburst');
  });

  it('обновляет каталог, не перезаписывая несохранённый выбор', async () => {
    render(<ImageGenerationSettings />);
    await loaded();
    fireEvent.change(model('Draft'), { target: { value: 'gpt-image-2.6-flare' } });
    state.models!.push({ id: 'gpt-image-9', label: 'New' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
    await screen.findAllByRole('option', { name: 'New (gpt-image-9)' });
    expect(model('Draft').value).toBe('gpt-image-2.6-flare');
    expect(refreshes).toBe(1);
    expect(writes).toEqual([]);
  });

  it('не заменяет исчезнувший ID и честно сообщает об отсутствии каталога', async () => {
    state.settings.profiles.final.model = 'gpt-image-removed';
    state.models = null;
    render(<ImageGenerationSettings />);
    await loaded();
    expect(model('Final').value).toBe('gpt-image-removed');
    expect(screen.getByText(/catalog is unavailable/)).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it('ошибка сохранения оставляет выбор и не сообщает об успехе', async () => {
    render(<ImageGenerationSettings />);
    await loaded();
    fireEvent.change(model('Final'), { target: { value: 'gpt-image-2.6-sunburst' } });
    fail = true;
    fireEvent.click(save());
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not save/);
    expect(model('Final').value).toBe('gpt-image-2.6-sunburst');
    expect(screen.queryByText('Image profiles saved')).toBeNull();
  });

  it('ошибку загрузки можно исправить повторной попыткой', async () => {
    fail = true;
    render(<ImageGenerationSettings />);
    await screen.findByRole('alert');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await loaded();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('русские подписи и нативные элементы доступны на тач', async () => {
    await i18n.changeLanguage('ru');
    render(<ImageGenerationSettings />);
    await screen.findByRole('combobox', { name: 'Режим по умолчанию' });
    expect(screen.getByRole('group', { name: 'Черновик' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Сохранить профили' }).className).toContain('min-h-11');
  });
});
