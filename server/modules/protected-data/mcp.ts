import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { CHAT_DESTINATION_ID, DELIVERY_CHECK_ID, PROJECT_ENV_ID } from './apply-receiver.js';
import { chatDestinationPreview, parseChatDestination, type ConfirmDelivery } from './chat-destination.js';
import { PROTECTED_DATA_TTL_MS, validSelection, type ProtectedDataEnvelope, type ProtectedDataStatus } from './protocol.js';
import { protectedDataRelay, type ProtectedDataRunGrant } from './relay.js';

export const PROTECTED_DATA_MCP_SERVER = 'cloudcli-protected-data';
export const PROTECTED_DATA_TOOL_ID = `mcp__${PROTECTED_DATA_MCP_SERVER}__check_connection`;

const STATUS_TEXT: Record<ProtectedDataStatus, string> = {
  ok: 'Доступ к настроенному API подтверждён.',
  delivered: 'Согласованный HTTPS-получатель принял запрос (2xx). Это подтверждение доставки, не применения на стороне получателя.',
  received: 'Защищённый набор получен и проверен локально. Сетевых запросов не было.',
  applied: 'Защищённые данные применены выбранным получателем. Значения не раскрываются.',
  denied: 'Настроенный API отклонил авторизацию.',
  failed: 'Проверка не удалась; дополнительный ответ сервера недоступен.',
  invalid: 'Защищённый набор не прошёл проверку; значения не использованы.',
  expired: 'Срок действия защищённых данных истёк.',
  used: 'Защищённые данные больше недоступны для этой проверки.',
};

// GOLDJAXE fork (§27–§27.5): фиксированные действия не имеют аргументов;
// свободное назначение требует отдельного пользовательского подтверждения.
export function createProtectedDataMcp(
  { envelope, operation, destinationLabel, projectRoot, turnSignal }: ProtectedDataRunGrant,
  isCurrent: () => boolean,
  execute = protectedDataRelay.execute,
  confirmDelivery?: ConfirmDelivery,
) {
  const interactive = operation === 'env-apply' && envelope.target === CHAT_DESTINATION_ID;
  const deliveryOnly = operation === 'local-check' || (operation === 'env-apply' && envelope.target === DELIVERY_CHECK_ID);
  const applying = operation === 'apply' || (operation === 'env-apply' && !deliveryOnly);
  const toolName = interactive ? 'deliver_protected_fields' : applying ? 'apply_protected_field' : 'check_connection';
  const life = new AbortController();
  let pending: ProtectedDataEnvelope | undefined = envelope;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    pending = undefined;
    life.abort();
  }, Math.max(0, envelope.issuedAt + PROTECTED_DATA_TTL_MS - Date.now()));
  timer.unref();
  const revoke = () => {
    pending = undefined;
    life.abort();
    clearTimeout(timer);
  };

  const check = async () => {
    const data = pending;
    revoke();
    let status: ProtectedDataStatus = expired ? 'expired' : 'used';
    if (data && isCurrent()) {
      try {
        status = await execute(data, projectRoot);
      } catch {
        status = 'failed';
      }
    }
    const text = operation === 'env-apply' && envelope.target === PROJECT_ENV_ID && status === 'failed'
      ? 'Запись не подтверждена. Нужен существующий игнорируемый Git файл .env в корне проекта, режим 0600/0640, без ссылок и сложного синтаксиса. Не читай значения и не ослабляй права.'
      : applying && status === 'failed'
      ? 'Применение не подтверждено. Не повторяй его автоматически и не читай файл для проверки.'
      : STATUS_TEXT[status];
    return { content: [{ type: 'text' as const, text }], isError: !['ok', 'received', 'applied'].includes(status) };
  };

  // GOLDJAXE fork (§27.5): ни SDK allow, ни адрес из текста сами по себе не дают согласия.
  const reply = (text: string, isError = true) => ({ content: [{ type: 'text' as const, text }], isError });
  const deliver = async ({ destination: raw, fields }: { destination: string; fields: string[] }, extra: unknown) => {
    if (!pending || !isCurrent() || life.signal.aborted) return reply(STATUS_TEXT[expired ? 'expired' : 'used']);
    const destination = parseChatDestination(raw);
    const preview = destination && chatDestinationPreview(destination, projectRoot);
    if (!destination || !preview || !validSelection(fields, envelope.names)) return reply('Некорректное назначение или имена полей. Данные не отправлены.');
    const names = Object.freeze([...fields]);
    const data = pending;
    pending = undefined; // До первого await: только одна карточка и одна попытка на ход.
    const extraSignal = (extra as {signal?: unknown} | null)?.signal;
    const signal = AbortSignal.any([life.signal, AbortSignal.timeout(180_000), ...(turnSignal ? [turnSignal] : []),
      ...(extraSignal instanceof AbortSignal ? [extraSignal] : [])]);
    try {
      if (!confirmDelivery || signal.aborted || !await confirmDelivery(preview, names, signal) || signal.aborted || !isCurrent()) {
        return reply('Нет действующего подтверждения пользователя. Передача не начата.');
      }
      const status = await execute(data, projectRoot, { destination, names, signal });
      return status === 'applied' || status === 'delivered' ? reply(STATUS_TEXT[status], false)
        : reply('Доставка не подтверждена. Не повторяй автоматически, не читай значения и не перезапускай службу.');
    } catch { return reply('Доставка не подтверждена; значения и диагностический вывод не раскрываются.'); }
    finally { revoke(); }
  };

  return {
    revoke,
    toolId: `mcp__${PROTECTED_DATA_MCP_SERVER}__${toolName}`,
    server: createSdkMcpServer({
      name: PROTECTED_DATA_MCP_SERVER,
      version: '1.0.0',
      alwaysLoad: true,
      timeout: interactive ? 190_000 : 15_000,
      tools: interactive ? [tool(toolName, [
        `Прикреплены поля: ${envelope.names.join(', ')}. Предложи место доставки по поручению пользователя. Значения тебе не нужны.`,
        'Для VPS укажи ssh://[user@]DNS-или-IP[:port]/абсолютный/файл.env (существующий плоский systemd EnvironmentFile). Для проекта — project:путь/.env.',
        'Для HTTPS-получателя JSON укажи точный https://host/path: POST с объектом из полей, без перенаправлений. Не помещай секреты в адрес.',
        'Выбери только нужные имена. Уточни неоднозначный адрес, а не придумывай его. CloudCLI покажет человеку адрес и поля и дождётся отдельного согласия.',
        'Инструмент одноразовый: доставляет напрямую, без промежуточного локального файла. Не читай секрет и не проверяй запись чтением файла.',
      ].join(' '), { destination: z.string().min(1).max(2048), fields: z.array(z.string().max(32)).min(1).max(12) }, deliver)] : [tool(toolName, [
        `В этом сообщении предоставлены защищённые поля: ${envelope.names.join(', ')}.`,
        applying ? `Утверждённый получатель: ${JSON.stringify(destinationLabel)}. Вызови только если это назначение соответствует заданию. Локальный .env не заменяет файл на VPS. Не читай и не копируй файл для проверки.`
          : deliveryOnly
            ? 'Вызови только если пользователь просит локально проверить доставку защищённых полей. Сетевого запроса и проверки пароля в сервисе не будет.'
            : 'Вызови только если пользователь просит проверить подключение к настроенному API.',
        'Действие одноразовое, не принимает аргументов и возвращает только статус.',
        'Не пытайся читать значения или направлять их через другие инструменты.',
      ].join(' '), {}, check)],
    }),
  };
}
