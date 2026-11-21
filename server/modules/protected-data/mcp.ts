import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

import { PROTECTED_DATA_TTL_MS, type ProtectedDataEnvelope, type ProtectedDataStatus } from './protocol.js';
import { protectedDataRelay, type ProtectedDataRunGrant } from './relay.js';

export const PROTECTED_DATA_MCP_SERVER = 'cloudcli-protected-data';
export const PROTECTED_DATA_TOOL_ID = `mcp__${PROTECTED_DATA_MCP_SERVER}__check_connection`;

const STATUS_TEXT: Record<ProtectedDataStatus, string> = {
  ok: 'Доступ к настроенному API подтверждён.',
  received: 'Защищённый набор получен и проверен локально. Сетевых запросов не было.',
  denied: 'Настроенный API отклонил авторизацию.',
  failed: 'Проверка не удалась; дополнительный ответ сервера недоступен.',
  invalid: 'Защищённый набор не прошёл проверку; значения не использованы.',
  expired: 'Срок действия защищённых данных истёк.',
  used: 'Защищённые данные больше недоступны для этой проверки.',
};

// GOLDJAXE fork (реестр §27): модель предлагает только фиксированное действие;
// инструмент не получает URL, имя пользователя, произвольные аргументы или вывод API.
export function createProtectedDataMcp(
  { envelope, operation }: ProtectedDataRunGrant,
  isCurrent: () => boolean,
  execute = protectedDataRelay.execute,
) {
  let pending: ProtectedDataEnvelope | undefined = envelope;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    pending = undefined;
  }, Math.max(0, envelope.issuedAt + PROTECTED_DATA_TTL_MS - Date.now()));
  timer.unref();
  const revoke = () => {
    pending = undefined;
    clearTimeout(timer);
  };

  const check = async () => {
    const data = pending;
    revoke();
    let status: ProtectedDataStatus = expired ? 'expired' : 'used';
    if (data && isCurrent()) {
      try {
        status = await execute(data);
      } catch {
        status = 'failed';
      }
    }
    return { content: [{ type: 'text' as const, text: STATUS_TEXT[status] }], isError: status !== 'ok' && status !== 'received' };
  };

  return {
    revoke,
    server: createSdkMcpServer({
      name: PROTECTED_DATA_MCP_SERVER,
      version: '1.0.0',
      alwaysLoad: true,
      timeout: 15_000,
      tools: [tool('check_connection', [
        `В этом сообщении предоставлены защищённые поля: ${envelope.names.join(', ')}.`,
        operation === 'local-check'
          ? 'Вызови только если пользователь просит локально проверить доставку защищённых полей. Сетевого запроса и проверки пароля в сервисе не будет.'
          : 'Вызови только если пользователь просит проверить подключение к настроенному API.',
        'Это одноразовая проверка. Она не принимает аргументов и возвращает только статус.',
        'Не пытайся читать значения или направлять их через другие инструменты.',
      ].join(' '), {}, check)],
    }),
  };
}
