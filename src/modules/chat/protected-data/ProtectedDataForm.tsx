import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, KeyboardEvent, RefObject, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { PlusIcon, XIcon } from 'lucide-react';

import {
  MAX_PROTECTED_FIELDS,
  validateProtectedFields,
  type ProtectedDataIssue,
  type ProtectedDataProfile,
  type ProtectedField,
} from '@/modules/chat/protected-data/protected-data-client';
import { useProtectedDataCopy } from '@/modules/chat/protected-data/protected-data-copy';
import '@/modules/chat/protected-data/protected-data.css';

export type ProtectedDataFormProps = {
  anchorRef: RefObject<HTMLButtonElement | null>;
  /** Снимок на открытие; монтировать форму заново при смене черновика. */
  fields: readonly ProtectedField[];
  profile: ProtectedDataProfile;
  onAttach: (fields: ProtectedField[]) => void;
  onClose: () => void;
  disabled?: boolean;
};

const MOBILE_QUERY = '(max-width: 767px), (pointer: coarse) and (max-height: 500px)';
const ROW_SELECTOR = '[data-protected-row]';
const FOCUS_OUTLINE = 'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2';
const FOCUS_RING = `${FOCUS_OUTLINE} focus-visible:outline-ring`;
const ENTRY = `protected-data-entry h-10 w-full min-w-0 rounded-lg border border-muted-foreground/75 bg-background px-2.5 text-base text-foreground md:text-sm disabled:opacity-50 aria-[invalid=true]:border-red-600 dark:aria-[invalid=true]:border-red-400 ${FOCUS_RING}`;
const ICON_BUTTON = `protected-data-action protected-data-icon-button flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-50 ${FOCUS_RING}`;

function subscribeMobile(notify: () => void) {
  const media = window.matchMedia(MOBILE_QUERY);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
}

function entries(row: Element) {
  return {
    name: row.querySelector<HTMLInputElement>('input[data-protected-entry="name"]'),
    value: row.querySelector<HTMLInputElement>('input[data-protected-entry="value"]'),
  };
}

function stop(event: SyntheticEvent) {
  event.stopPropagation();
}

function block(event: SyntheticEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function keepVisible(scroll: HTMLElement | null, target: Element | null) {
  if (!target || !scroll?.contains(target)) return;
  const area = scroll.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  if (item.bottom > area.bottom - 4) scroll.scrollTop += item.bottom - area.bottom + 4;
  else if (item.top < area.top + 4) scroll.scrollTop -= area.top - item.top + 4;
}

// GOLDJAXE fork (реестр §27): отдельная DOM-форма в портале, без значений в React state и атрибутах.
export function ProtectedDataForm({ anchorRef, fields, profile, onAttach, onClose, disabled }: ProtectedDataFormProps) {
  const copy = useProtectedDataCopy();
  const id = useId();
  const mobile = useSyncExternalStore(subscribeMobile, () => window.matchMedia(MOBILE_QUERY).matches, () => false);
  const [rows, setRows] = useState(() => Array.from({ length: Math.min(MAX_PROTECTED_FIELDS, Math.max(1, fields.length)) }, (_, i) => i));
  const [issue, setIssue] = useState<ProtectedDataIssue | null>(null);
  const nextId = useRef(MAX_PROTECTED_FIELDS);
  const initialFields = useRef<readonly ProtectedField[] | null>(fields);
  const pendingFocus = useRef<number | 'add' | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const attachRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const viewport = window.visualViewport;
    const margin = 12;
    const gap = 8;
    const anchor = anchorRef.current;
    let frame = 0;

    const position = () => {
      frame = 0;
      if (mobile) {
        if (viewport) {
          layer.style.setProperty('--protected-viewport-top', `${viewport.offsetTop}px`);
          layer.style.setProperty('--protected-viewport-left', `${viewport.offsetLeft}px`);
          layer.style.setProperty('--protected-viewport-width', `${viewport.width}px`);
          layer.style.setProperty('--protected-viewport-height', `${viewport.height}px`);
        }
        keepVisible(scrollRef.current, document.activeElement);
      } else if (anchor) {
        const rect = anchor.getBoundingClientRect();
        const width = Math.min(448, window.innerWidth - margin * 2);
        layer.style.setProperty('--protected-anchor-left', `${Math.max(margin, Math.min(rect.left, window.innerWidth - margin - width))}px`);
        layer.style.setProperty('--protected-anchor-width', `${width}px`);
        layer.style.setProperty('--protected-anchor-bottom', `${window.innerHeight - rect.top + gap}px`);
        layer.style.setProperty('--protected-anchor-space', `${Math.max(0, rect.top - gap - margin)}px`);
        layer.setAttribute('data-positioned', '');
      }
    };
    const update = () => {
      if (!frame) frame = window.requestAnimationFrame(position);
    };

    position();
    window.addEventListener('resize', update);
    if (mobile) {
      viewport?.addEventListener('resize', update);
      viewport?.addEventListener('scroll', update);
    } else {
      window.addEventListener('scroll', update, true);
    }
    const resize = !mobile && anchor && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (resize && anchor) {
      resize.observe(anchor);
      if (anchor.form) resize.observe(anchor.form);
    }
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      resize?.disconnect();
    };
  }, [anchorRef, mobile]);

  useLayoutEffect(() => {
    const initial = initialFields.current;
    const form = formRef.current;
    if (!initial || !form) return;
    initialFields.current = null;
    form.querySelectorAll(ROW_SELECTOR).forEach((row, index) => {
      if (!initial[index]) return;
      const { name, value } = entries(row);
      if (name) name.value = initial[index].name;
      if (value) value.value = initial[index].value;
    });
    // На телефоне не вызываем клавиатуру, пока пользователь сам не выберет поле.
    const first = !mobile && form.querySelector<HTMLInputElement>('input:enabled');
    (first || panelRef.current)?.focus({ preventScroll: true });
  }, [mobile]);

  useLayoutEffect(() => {
    const row = pendingFocus.current;
    if (row === null) return;
    pendingFocus.current = null;
    const target = row === 'add' ? addRef.current : document.getElementById(`${id}-${row}-name`);
    target?.focus({ preventScroll: true });
  }, [rows, id]);

  const clearInputs = useCallback((restoreFocus: boolean) => {
    const inputs = formRef.current?.querySelectorAll('input');
    inputs?.forEach((input) => {
      input.value = '';
      if (input === document.activeElement) input.blur();
    });
    if (restoreFocus) anchorRef.current?.focus({ preventScroll: true });
  }, [anchorRef]);

  const dismiss = useCallback((restoreFocus: boolean) => {
    clearInputs(restoreFocus);
    onClose();
  }, [clearInputs, onClose]);

  useEffect(() => {
    if (mobile) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !layerRef.current?.contains(target) && !anchorRef.current?.contains(target)) dismiss(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [anchorRef, dismiss, mobile]);

  const addRow = () => {
    if (disabled || rows.length >= MAX_PROTECTED_FIELDS) return;
    const row = nextId.current++;
    pendingFocus.current = row;
    setIssue(null);
    setRows([...rows, row]);
  };

  const removeRow = (index: number) => {
    if (disabled) return;
    pendingFocus.current = rows[index + 1] ?? rows[index - 1] ?? 'add';
    setIssue(null);
    setRows(rows.filter((_, i) => i !== index));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    block(event);
    if (disabled) return;
    const displayedRows = event.currentTarget.querySelectorAll(ROW_SELECTOR);
    const edited = Array.from(displayedRows, (row) => {
      const { name, value } = entries(row);
      return { name: name?.value ?? '', value: value?.value ?? '' };
    });
    const problem = validateProtectedFields(profile, edited);
    setIssue(problem);
    if (problem) {
      if ('row' in problem) entries(displayedRows[problem.row])[problem.field]?.focus({ preventScroll: true });
      return;
    }
    clearInputs(true);
    onAttach(edited);
  };

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    stop(event);
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss(true);
    } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      // Enter переключает поле, а не прикрепляет данные и не отправляет чат.
      event.preventDefault();
      const inputs = Array.from(formRef.current?.querySelectorAll<HTMLInputElement>('input:enabled') ?? []);
      (inputs[inputs.indexOf(event.target) + 1] ?? attachRef.current)?.focus({ preventScroll: true });
    } else if (mobile && event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:enabled, input:enabled'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      if (active === panelRef.current || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus({ preventScroll: true });
      }
    }
  };

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={layerRef} className="protected-data-layer" data-mobile={mobile ? '' : undefined}
      onClick={stop} onPointerDown={stop} onPaste={stop} onDragOver={block} onDrop={block}>
      {mobile && <div className="absolute inset-0 bg-black/30 dark:bg-black/50" aria-hidden="true" onClick={() => dismiss(true)} />}
      <div ref={panelRef} role="dialog" aria-modal={mobile || undefined} aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-hint`} tabIndex={-1} data-escape-layer=""
        className="protected-data-panel relative flex min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl outline-none"
        onKeyDown={handleKey} onKeyUp={stop}
        onFocus={(event) => keepVisible(scrollRef.current, event.target)}
        onBlur={(event) => {
          const target = event.relatedTarget;
          if (!mobile && target instanceof Node && target !== anchorRef.current && !event.currentTarget.contains(target)) dismiss(false);
        }}>
        <form ref={formRef} autoComplete="off" noValidate onSubmit={handleSubmit}
          onInput={(event) => { stop(event); if (issue) setIssue(null); }}
          className="flex min-h-0 flex-col">
          <div className="protected-data-inset shrink-0 px-4 pb-2 pt-2">
            {mobile && <div className="mx-auto mb-1.5 h-1 w-9 rounded-full bg-border" aria-hidden="true" />}
            <div className="flex items-center justify-between gap-2">
              <h2 id={`${id}-title`} className="text-lg font-semibold leading-tight">{copy.title}</h2>
              <button type="button" onClick={() => dismiss(true)} className={ICON_BUTTON} aria-label={copy.close}>
                <XIcon className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            <p id={`${id}-hint`} className="text-sm text-muted-foreground">{copy.privateHint}</p>
          </div>

          <div ref={scrollRef} className="protected-data-inset min-h-0 overflow-y-auto overscroll-contain px-4 pb-1">
            <div className="mb-3 space-y-0.5 border-b border-border pb-3 text-sm">
              <p className="break-words font-medium">{profile.label}</p>
              <p className="text-xs text-muted-foreground">{copy.readOnly}</p>
              {profile.requiredFields.length > 0 && (
                <p className="break-words text-xs text-muted-foreground">
                  {copy.required}: <span className="font-mono" dir="ltr">{profile.requiredFields.join(', ')}</span>
                </p>
              )}
            </div>

            {rows.length > 0 && (
              <div className="protected-data-row mb-1 text-xs font-semibold text-muted-foreground" aria-hidden="true">
                <span>{copy.name}</span><span>{copy.value}</span>
              </div>
            )}
            <div className="space-y-1.5">
              {rows.map((row, index) => {
                const invalid = issue && 'row' in issue && issue.row === index ? issue.field : null;
                return (
                  <div className="protected-data-row" key={row} data-protected-row="">
                    <input id={`${id}-${row}-name`} type="text" data-protected-entry="name" autoComplete="off"
                      autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" disabled={disabled}
                      aria-label={`${copy.name} ${index + 1}`} aria-invalid={invalid === 'name' || undefined}
                      aria-describedby={invalid === 'name' ? `${id}-error` : undefined} className={`${ENTRY} font-mono`} />
                    <input type="password" data-protected-entry="value" autoComplete="off"
                      autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint={index + 1 === rows.length ? 'done' : 'next'} disabled={disabled}
                      aria-label={`${copy.value} ${index + 1}`} aria-invalid={invalid === 'value' || undefined}
                      aria-describedby={invalid === 'value' ? `${id}-error` : undefined} className={ENTRY} />
                    <button type="button" className={ICON_BUTTON} aria-label={`${copy.removeField} ${index + 1}`}
                      onClick={() => removeRow(index)} disabled={disabled}>
                      <XIcon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
            <button ref={addRef} type="button" disabled={disabled || rows.length >= MAX_PROTECTED_FIELDS} onClick={addRow}
              className={`protected-data-action mt-1 flex min-h-8 items-center gap-2 rounded-lg px-1 text-sm font-semibold enabled:hover:bg-accent disabled:opacity-50 ${FOCUS_RING}`}>
              <PlusIcon className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
              {copy.add}
            </button>
          </div>

          <div className="protected-data-inset protected-data-footer shrink-0 px-4 pb-3 pt-1.5">
            {issue && <p id={`${id}-error`} role="alert" className="mb-2 text-xs text-red-700 dark:text-red-400">{copy.errors[issue.code]}</p>}
            <button ref={attachRef} type="submit" disabled={disabled || rows.length === 0}
              className={`protected-data-action min-h-10 w-full rounded-lg bg-primary px-3 py-2 text-base font-semibold text-primary-foreground enabled:hover:bg-primary/90 disabled:opacity-50 md:text-sm ${FOCUS_OUTLINE} focus-visible:outline-primary-foreground`}>
              {copy.attach}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
