import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';

const socket = vi.hoisted(() => ({ sendMessage: vi.fn(), isConnected: true }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => socket }));
const destinationPreview = `HTTPS POST · JSON с выбранными полями → https://example.test/${'path'.repeat(150)}/end`;
const request = { requestId: 'delivery-123', sessionId: 's', toolName: 'CloudCLIProtectedDelivery', input: { destinationPreview, names: ['KEY', 'TOKEN'] } };
const renderBanner = (override = request) => render(<PermissionRequestsBanner pendingPermissionRequests={[override]}
  handlePermissionDecision={() => assert.fail('Общий resolver не должен вызываться')}
  handleGrantToolPermission={() => assert.fail('Не запоминать разрешение')} />);

for (const allow of [false, true]) {
  test(`точный адрес, имена и одно решение ${allow}`, () => {
    socket.sendMessage.mockClear();
    const view = renderBanner();
    assert.equal(view.getByText(destinationPreview).textContent, destinationPreview);
    assert.ok(view.getByText('KEY') && view.getByText('TOKEN'));
    assert.equal(view.getAllByRole('button').length, 2);
    const button = view.getByRole('button', { name: allow ? 'Передать один раз' : 'Отказать' });
    fireEvent.click(button); fireEvent.click(button);
    assert.deepEqual(socket.sendMessage.mock.calls, [[{ type: 'chat.protected-delivery-decision', sessionId: 's', requestId: 'delivery-123', allow }]]);
  });
}

test('неполный снимок запрещает согласие; одно имя инструмента SDK не имитирует карточку', () => {
  const view = renderBanner({ ...request, input: { names: [], destinationPreview } });
  assert.equal((view.getByRole('button', { name: 'Передать один раз' }) as HTMLButtonElement).disabled, true);
  view.unmount();
  const ordinary = renderBanner({ ...request, requestId: 'ordinary-sdk-id' });
  assert.equal(ordinary.queryByRole('button', { name: 'Передать один раз' }) === null, true);
});
