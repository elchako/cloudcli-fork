import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

import { PROTECTED_DATA_TTL_MS, type ProtectedDataEnvelope, type ProtectedDataStatus } from './protocol.js';
import { protectedDataRelay, type ProtectedDataRunGrant } from './relay.js';

export const PROTECTED_DATA_MCP_SERVER = 'cloudcli-protected-data';
export const PROTECTED_DATA_TOOL_ID = `mcp__${PROTECTED_DATA_MCP_SERVER}__check_connection`;

const STATUS_TEXT: Record<ProtectedDataStatus, string> = {
  ok: 'Доступ к настроенному API подтверждён.',
  received: 'Защищённый набор получен и проверен локально. Сетевых запросов не было.',
  applied: 'Защищённое поле применено настроенным получателем. Его значение не раскрывается.',
  denied: 'Настроенный API отклонил авторизацию.',
  failed: 'Проверка не удалась; дополнительный ответ сервера недоступен.',
  invalid: 'Защищённый набор не прошёл проверку; значения не использованы.',
  expired: 'Срок действия защищённых данных истёк.',
  used: 'Защищённые данные больше недоступны для этой проверки.',
};

// GOLDJAXE fork (реестр §27): модель предлагает только фиксированное действие;
// инструмент не получает URL, имя пользователя, произвольные аргументы или вывод API.
export function createProtectedDataMcp(
  { envelope, operation, destinationLabel }: ProtectedDataRunGrant,
  isCurrent: () => boolean,
  execute = protectedDataRelay.execute,
) {
  const applying = operation === 'apply';
  const toolName = applying ? 'apply_protected_field' : 'check_connection';
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
    const text = applying && status === 'failed'
      ? 'Применение не подтверждено. Не повторяй его автоматически и не читай файл для проверки.'
      : STATUS_TEXT[status];
    return { content: [{ type: 'text' as const, text }], isError: !['ok', 'received', 'applied'].includes(status) };
  };

  return {
    revoke,
    toolId: `mcp__${PROTECTED_DATA_MCP_SERVER}__${toolName}`,
    server: createSdkMcpServer({
      name: PROTECTED_DATA_MCP_SERVER,
      version: '1.0.0',
      alwaysLoad: true,
      timeout: 15_000,
      tools: [tool(toolName, [
        `В этом сообщении предоставлены защищённые поля: ${envelope.names.join(', ')}.`,
        applying ? `Утверждённый получатель: ${JSON.stringify(destinationLabel)}. Вызови только по просьбе применить поле у этого получателя. Не проверяй запись чтением файла.`
          : operation === 'local-check'
            ? 'Вызови только если пользователь просит локально проверить доставку защищённых полей. Сетевого запроса и проверки пароля в сервисе не будет.'
            : 'Вызови только если пользователь просит проверить подключение к настроенному API.',
        'Действие одноразовое, не принимает аргументов и возвращает только статус.',
        'Не пытайся читать значения или направлять их через другие инструменты.',
      ].join(' '), {}, check)],
    }),
  };
}
