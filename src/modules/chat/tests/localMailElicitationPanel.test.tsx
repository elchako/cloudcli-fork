import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { test } from 'vitest';

import { McpElicitationPanel } from '@/modules/chat/tools/InteractiveRenderers/McpElicitationPanel';
import type { PendingPermissionRequest } from '@/shared/types';

const body = '<script>alert("not HTML")</script>\n[не ссылка](https://example.test)\n**не Markdown**\n' + 'Полное тело.\n'.repeat(2000) + 'ПОСЛЕДНЯЯ СТРОКА';
const preview = {
  from: 'sender@example.test', to: ['to@example.test'], cc: ['cc@example.test'], bcc: ['blind@example.test'],
  subject: '<img src=x onerror=alert(1)>', body,
  attachments: [{ filename: '<a>файл.txt</a>', size: 42, sha256: 'f'.repeat(64) }],
};
const request: PendingPermissionRequest = {
  requestId: 'mail-local-1', sessionId: 'session', toolName: 'McpElicitation',
  input: { serverName: 'mail-local', message: 'Проверьте письмо.', localMailPreview: preview },
};

function panel() {
  const decisions: unknown[] = [];
  return { ...render(<McpElicitationPanel request={request} onDecision={(id, decision) => decisions.push({ id, decision })} />), decisions };
}

test('Mail показывает полный plain-text snapshot: Bcc, тело, filename/size/SHA, без HTML и Markdown', () => {
  const { getByTestId, container } = panel();
  const content = getByTestId('local-mail-preview').textContent!;
  assert.ok(content.includes('blind@example.test'));
  assert.ok(content.includes('sender@example.test'));
  assert.ok(content.includes('cc@example.test'));
  assert.ok(content.includes(body));
  assert.ok(content.includes('<img src=x onerror=alert(1)>'));
  assert.ok(content.includes('<a>файл.txt</a>'));
  assert.ok(content.includes('42'));
  assert.ok(content.includes('f'.repeat(64)));
  assert.equal(container.querySelector('script, img, a, strong') === null, true);
  assert.equal(content.includes('signature'), false);
});

test('Mail opt-in требует явный checkbox, возвращает confirm напрямую и подавляет повторные клики', () => {
  const { getByText, getByRole, decisions } = panel();
  const submit = getByText('Подтвердить отправку') as HTMLButtonElement;
  assert.equal(submit.disabled, true);
  fireEvent.click(submit);
  assert.equal(decisions.length, 0);
  fireEvent.click(getByRole('checkbox'));
  assert.equal(submit.disabled, false);
  fireEvent.click(submit);
  fireEvent.click(submit);
  fireEvent.click(getByText('Отказаться'));
  assert.deepEqual(decisions, [{ id: 'mail-local-1', decision: { allow: true, updatedInput: { confirm: true } } }]);
});

test('Mail отказ не добавляет confirm или поддельный user message', () => {
  const { getByText, decisions } = panel();
  fireEvent.click(getByText('Отказаться'));
  assert.deepEqual(decisions, [{ id: 'mail-local-1', decision: { allow: false } }]);
});
