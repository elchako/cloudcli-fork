import { useRef, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtectedDataChip } from '@/modules/chat/protected-data/ProtectedDataChip';
import { ProtectedDataForm } from '@/modules/chat/protected-data/ProtectedDataForm';
import type { ProtectedDataProfile, ProtectedField } from '@/modules/chat/protected-data/protected-data-client';

let language = 'en';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { resolvedLanguage: language } }) }));

const profile: ProtectedDataProfile = {
  revision: '1'.repeat(64), publicKey: 'AAAA', label: 'Test profile', requiredFields: ['TOKEN'], urlField: 'URL',
};
const existing = [
  { name: 'URL', value: 'https://example.invalid/private-path' },
  { name: 'TOKEN', value: 'synthetic-test-token' },
];

function renderEditor(fields: readonly ProtectedField[] = [], disabled = false, selectedProfile = profile) {
  const onAttach = vi.fn();
  const onClose = vi.fn();
  const composerSubmit = vi.fn();
  const composerKeyDown = vi.fn();
  const composerPaste = vi.fn();
  const composerDrop = vi.fn();
  function Harness() {
    const anchorRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(true);
    return (
      <form aria-label="Composer" onSubmit={composerSubmit} onKeyDown={composerKeyDown}
        onPaste={composerPaste} onDrop={composerDrop}>
        <button ref={anchorRef} type="button" onClick={() => setOpen((value) => !value)}>Lock</button>
        <textarea aria-label="Chat input" />
        {open && <ProtectedDataForm anchorRef={anchorRef} profile={selectedProfile} fields={fields} disabled={disabled}
          onAttach={(edited) => { onAttach(edited); setOpen(false); }}
          onClose={() => { onClose(); setOpen(false); }} />}
      </form>
    );
  }
  render(<Harness />);
  return { onAttach, onClose, composerSubmit, composerKeyDown, composerPaste, composerDrop };
}

const getInput = (label: string) => screen.getByLabelText<HTMLInputElement>(label);

beforeEach(() => { language = 'en'; });
afterEach(() => vi.unstubAllGlobals());

describe('форма защищённых данных §27', () => {
  it('показывает локальный режим и не требует имён API', () => {
    const fields = [{ name: 'LABEL', value: 'synthetic-value' }];
    const { onAttach } = renderEditor(fields, false, {
      revision: profile.revision, publicKey: profile.publicKey, label: 'Local profile',
      operation: 'local-check', requiredFields: [],
    });
    expect(screen.getByText('Delivery check · no network')).toBeTruthy();
    expect(screen.queryByText(/Required fields/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Attach to message' }));
    expect(onAttach).toHaveBeenCalledExactlyOnceWith(fields);
  });

  it('отдельной формой принимает локальный черновик, не запускает события композера', () => {
    const { onAttach, onClose, composerKeyDown, composerSubmit, composerPaste, composerDrop } = renderEditor(existing);
    const dialog = screen.getByRole('dialog');
    expect(screen.getByRole('form', { name: 'Composer' }).contains(dialog)).toBe(false);
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    expect(dialog.querySelector('form')?.getAttribute('autocomplete')).toBe('off');
    expect(dialog.textContent).toContain('Test profile');
    expect(dialog.textContent).toContain('Connection check · read-only');
    expect(dialog.textContent).toContain('Required fields: TOKEN');
    const name = getInput('Name 1');
    const url = getInput('Value 1');
    expect(document.activeElement).toBe(name);
    expect(name.value).toBe('URL');
    expect(name.autocomplete).toBe('off');
    expect(url.type).toBe('password');
    expect(url.autocomplete).toBe('off');
    expect(url.value).toBe(existing[0].value);
    expect(dialog.innerHTML).not.toContain(existing[0].value);
    expect(dialog.innerHTML).not.toContain(existing[1].value);
    expect(Array.from(new FormData(dialog.querySelector('form') ?? undefined))).toEqual([]);

    fireEvent.pointerDown(name);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(name, { key: 'Enter', ctrlKey: true });
    expect(document.activeElement).toBe(url);
    fireEvent.paste(url);
    fireEvent.drop(url);
    const newToken = 'synthetic-edited-value';
    fireEvent.input(getInput('Value 2'), { target: { value: newToken } });
    expect(onAttach).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Attach to message' }));
    expect(onAttach).toHaveBeenCalledExactlyOnceWith([existing[0], { name: 'TOKEN', value: newToken }]);
    expect(existing[1].value).toBe('synthetic-test-token');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Lock' }));
    expect(url.value).toBe('');
    for (const callback of [onClose, composerKeyDown, composerSubmit, composerPaste, composerDrop]) {
      expect(callback).not.toHaveBeenCalled();
    }
  });

  it('показывает ошибки без значений, сохраняет только нужные строки и держит лимит 12', () => {
    const { onAttach } = renderEditor(existing);
    const add = screen.getByRole('button', { name: 'Add field' }) as HTMLButtonElement;
    for (let i = 0; i < 10; i++) fireEvent.click(add);
    expect(add.disabled).toBe(true);
    expect(document.activeElement).toBe(getInput('Name 12'));
    for (let i = 12; i > 2; i--) fireEvent.click(screen.getByRole('button', { name: `Remove field ${i}` }));
    expect(add.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove field 1' }));
    expect(getInput('Name 1').value).toBe('TOKEN');
    expect(getInput('Value 1').value).toBe('synthetic-test-token');
    fireEvent.click(add);
    const invalidAlias = 'bad name / private-path';
    fireEvent.input(getInput('Name 2'), { target: { value: invalidAlias } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach to message' }));
    expect(onAttach).not.toHaveBeenCalled();
    expect(getInput('Name 2').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).not.toContain(invalidAlias);
    expect(screen.getByRole('alert').textContent).not.toContain(existing[1].value);
    expect(document.activeElement).toBe(getInput('Name 2'));
  });

  it('отменяет изменения на Escape и не мешает клику за пределами десктопного окна', () => {
    const { onClose, onAttach, composerKeyDown } = renderEditor(existing);
    const name = getInput('Name 1');
    fireEvent.input(name, { target: { value: 'OTHER' } });
    fireEvent.keyDown(name, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAttach).not.toHaveBeenCalled();
    expect(composerKeyDown).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Lock' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    expect(getInput('Name 1').value).toBe('URL');
    fireEvent.pointerDown(getInput('Chat input'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('не открывает клавиатуру при показе нижней панели, ограничивает Tab и учитывает visualViewport', async () => {
    language = 'ru-RU';
    vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
      matches: true, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }));
    const viewport = Object.assign(new EventTarget(), { offsetTop: 0, offsetLeft: 0, width: 390, height: 844 });
    vi.stubGlobal('visualViewport', viewport);
    renderEditor(existing);
    const dialog = screen.getByRole('dialog', { name: 'Защищённые данные' });
    const close = screen.getByRole('button', { name: 'Закрыть' });
    const attach = screen.getByRole('button', { name: 'Прикрепить к сообщению' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);
    expect(dialog.textContent).toContain('Проверка подключения · только чтение');
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(attach);
    fireEvent.keyDown(attach, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    viewport.height = 328;
    viewport.offsetTop = 20;
    viewport.dispatchEvent(new Event('resize'));
    await waitFor(() => {
      expect(dialog.parentElement?.style.getPropertyValue('--protected-viewport-height')).toBe('328px');
      expect(dialog.parentElement?.style.getPropertyValue('--protected-viewport-top')).toBe('20px');
    });
  });

  it('блокирует изменения, но оставляет закрытие', () => {
    const { onClose, onAttach } = renderEditor(existing, true);
    expect(getInput('Name 1').disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Add field' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Remove field 1' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Attach to message' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAttach).not.toHaveBeenCalled();
  });
});

describe('чип защищённых данных §27', () => {
  it('показывает только локализованное количество и отдельные действия', () => {
    language = 'ru';
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const { rerender } = render(<ProtectedDataChip count={2} onEdit={onEdit} onRemove={onRemove} />);
    expect(screen.getByText('2 поля')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Изменить защищённые данные: 2 поля' }));
    fireEvent.click(screen.getByRole('button', { name: 'Удалить защищённые данные' }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledOnce();
    rerender(<ProtectedDataChip count={12} onEdit={onEdit} onRemove={onRemove} disabled />);
    expect(screen.getByText('12 полей')).toBeTruthy();
    expect(screen.getAllByRole<HTMLButtonElement>('button').every((button) => button.disabled)).toBe(true);
    rerender(<ProtectedDataChip count={0} onEdit={onEdit} onRemove={onRemove} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
