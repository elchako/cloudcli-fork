import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { test } from 'vitest';

import { McpElicitationPanel } from '@/modules/chat/tools/InteractiveRenderers/McpElicitationPanel';
import type { PendingPermissionRequest } from '@/shared/types';

const body = '<script>alert("not HTML")</script>\r\n[не ссылка](https://example.test)\r\n**не Markdown**\r\n' + 'Полное тело.\r\n'.repeat(2000) + 'ПОСЛЕДНЯЯ СТРОКА';
const preview = {
  draft_id: 'INTERNAL-DRAFT', revision: 5, from: 'sender@example.test', to: ['to@example.test'],
  cc: ['cc@example.test'], bcc: ['blind@example.test', 'last-blind@example.test'],
  subject: '<img src=x onerror=alert(1)>', body,
  attachments: Array.from({ length: 12 }, (_, index) => ({ order: index, filename: `<a>файл-${index}.txt</a>`, size_bytes: 42 + index,
    mime_type: 'text/plain', disposition: 'attachment', content_id: null, sha256: 'f'.repeat(64) })),
  eml_sha256: 'e'.repeat(64), send_security_version: 3, send_config_hash: 'a'.repeat(64), expires_at: 999,
  execution_epoch: 'PRIVATE-EPOCH', nonce: 'PRIVATE-NONCE',
};
const request: PendingPermissionRequest = {
  requestId: 'mail-local-1', sessionId: 'session', toolName: 'McpElicitation',
  input: { serverName: 'mail-local', message: 'Проверьте письмо.', localMailPreview: preview },
};

function panel(value = request) {
  const decisions: unknown[] = [];
  return { ...render(<McpElicitationPanel request={value} onDecision={(id, decision) => decisions.push({ id, decision })} />), decisions };
}

test('Mail показывает русские поля, полный текст/получателей/все файлы без JSON и технической кухни', () => {
  const { getByTestId, getByText, container } = panel();
  const content = getByTestId('local-mail-preview').textContent!;
  for (const label of ['От', 'Кому', 'Копия', 'Скрытая копия', 'Тема', 'Текст письма', 'Вложения']) assert.ok(getByText(label));
  for (const value of ['sender@example.test', 'to@example.test', 'cc@example.test', 'blind@example.test', 'last-blind@example.test',
    body, '<img src=x onerror=alert(1)>', '<a>файл-0.txt</a>', '<a>файл-11.txt</a>', '42 байт', '53 байт']) assert.ok(content.includes(value));
  for (const hidden of ['INTERNAL-DRAFT', 'PRIVATE-EPOCH', 'PRIVATE-NONCE', 'draft_id', 'expires_at', 'send_config_hash', 'mime_type', 'sha256', 'f'.repeat(64), 'e'.repeat(64), 'a'.repeat(64), '{', '["']) assert.equal(content.includes(hidden), false);
  assert.equal(container.querySelector('script, img, a, strong, input[type="checkbox"]') === null, true);
});

test('SHA/MIME доступны отдельно в свёрнутых сведениях о вложениях, не в письме', () => {
  const { container, getByText } = panel();
  const details = container.querySelector('details')!;
  assert.equal(details.open, false);
  assert.ok(getByText('Технические сведения о вложениях'));
  assert.ok(details.textContent!.includes('text/plain'));
  assert.ok(details.textContent!.includes('f'.repeat(64)));
});

test('один явный клик Отправить письмо передаёт confirm:true и подавляет повторные клики', () => {
  const { getByText, decisions } = panel();
  const submit = getByText('Отправить письмо') as HTMLButtonElement;
  assert.equal(submit.disabled, false);
  assert.equal(decisions.length, 0);
  fireEvent.click(submit);
  fireEvent.click(submit);
  fireEvent.click(getByText('Отмена'));
  assert.deepEqual(decisions, [{ id: 'mail-local-1', decision: { allow: true, updatedInput: { confirm: true } } }]);
});

test('Отмена не добавляет confirm или поддельный user message', () => {
  const { getByText, decisions } = panel();
  fireEvent.click(getByText('Отмена'));
  assert.deepEqual(decisions, [{ id: 'mail-local-1', decision: { allow: false } }]);
});

test('нет вложений и пустые Cc/Bcc отображаются понятно', () => {
  const { getByText, getAllByText } = panel({ ...request, input: { localMailPreview: { ...preview, cc: [], bcc: [], attachments: [] } } });
  assert.ok(getByText('Нет вложений'));
  assert.equal(getAllByText('Не указано').length, 2);
});

test('непонятная форма preview не может скрыть получателей и разрешить отправку', () => {
  const { getByText, getByRole, decisions } = panel({ ...request, input: { localMailPreview: { ...preview, bcc: [{ email: 'hidden@example.test' }] } } });
  assert.ok(getByRole('alert'));
  assert.equal((getByText('Отправить письмо') as HTMLButtonElement).disabled, true);
  fireEvent.click(getByText('Отправить письмо'));
  assert.equal(decisions.length, 0);
});
