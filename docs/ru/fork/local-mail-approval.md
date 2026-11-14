---
title: "Локальное подтверждение Mail"
type: fork-change
sections: ["23"]
tags: [mail, elicitation, ed25519, безопасность, websocket]
description: "Opt-in подпись локального решения человека для mail-local: проверка challenge, привязка к авторизованному WebSocket и неизменяемому снимку письма, административная настройка и изолированные проверки."
updated: 2026-11-15
---

# Локальное подтверждение Mail

## §23. Подписанное решение человека, а не обычный SDK accept

**Состояние:** реализовано в отдельном рабочем дереве, не включено и не развёрнуто.
Коммит, отправка и включение выполняются отдельно после независимой проверки.

**Зачем:** SDK hooks могут вернуть или изменить `accept`. Такой ответ не
доказывает, что человек видел письмо и подтвердил именно его. Только backend
CloudCLI подписывает отдельное событие Ed25519 после ответа авторизованного WS.
Mail проверяет это событие самостоятельно; отправка письма не входит в CloudCLI.

**Слой:** сервер и форма разрешений. **Пересечение с upstream:** среднее, меняются
узкие стыки `onElicitation`, WS listener и выбор формы. Подписант, настройка и
тесты изолированы. **PR в upstream:** не отправлен, интеграция форка.

### Границы доверия и протокол v1

1. Обрабатывается `request.message` с префиксом
   `MAIL-MCP-LOCAL-APPROVAL-V1\n`. Допустим только закреплённый сервер
   `mail-local`, режим form и согласованная схема `confirm:boolean`, default false.
2. `server/shared/mail-approval/index.ts` проверяет подпись issuer, audience
   `cloudcli-local-mail`, разрешённую пару tenant/user/client с текущим CloudCLI
   user, SHA-256 полного preview и срок challenge (не более пяти минут).
   Challenge содержит nonce, draft/revision, preview_hash и eml_sha256.
3. Запись связывается с настоящим pending permission request id и app session id
   исходного рана. Snapshot для подписи хранится отдельно от копии UI.
4. Только замыкание `handleChatConnection`, созданное с user из authenticated
   upgrade request, принимает `chat.permission-response`. Проверяются открытый WS,
   исходный user, совпадающий sessionId и наличие этой Claude-сессии в БД.
   Идентификатор пользователя из WS JSON не используется.
5. Подпись создаётся только при `allow === true` и
   `updatedInput: {confirm: true}`. Дополнительные поля в updatedInput отвергаются.
   Решение одноразовое. Отказ, отмена, истечение срока и generic resolver ничего
   не подписывают; переданный клиентом или hooks token никогда не используется.
6. В `ElicitationResult.content.local_mail_decision` возвращается **строка
   canonical JSON подписанного envelope**, а не вложенный объект. Это важно:
   MCP ElicitResult допускает только примитивные поля. Рядом остаётся
   `confirm: true`. Mail разбирает строку и проверяет подпись через свой закрытый
   `local_send_decision`. Обычный `accept` не заменяет доказательство.

Подписываются UTF-8 bytes `mail-mcp:<purpose>:v1\0` плюс canonical payload:
рекурсивная сортировка ключей по Unicode code points, порядок массивов сохранён,
без пробелов, Unicode не преобразуется в ASCII. Purpose challenge:
`local-approval-challenge`; решения: `local-human-decision`. Подпись envelope
кодируется base64url с padding. Для чисел поддерживаются безопасные целые;
неоднозначное Python/JS представление дробных и слишком больших чисел отвергается.

Событие содержит `channel: cloudcli_native`, `decision: approve`, scope и hashes
исходного challenge, `challenge_nonce`, authenticated `cloudcli_user_id`,
`conversation_id`, `request_id`, одноразовый UUID `event_id`, время выпуска и
срок `min(now+60000, challenge.expires_at)`. Фиктивный user message не создаётся.

### Экран и конфиденциальность

Форма показывает **все поля** проверенного preview, включая From, To, Cc, Bcc,
Subject, полное тело и filename/size/SHA вложений. Строки выводятся как React
text, вложенные структуры как полный JSON text. Markdown, HTML, ссылки и
удалённые изображения не исполняются. Тело не обрезается, область прокручивается,
флажок изначально снят. Повторный клик не отправляет второе решение.

В UI передаётся только проверенный preview, без raw challenge и подписи.
Уведомление нейтральное, без письма и конверта. Ошибки проверки не раскрывают
содержимое challenge, ключи или путь закрытого ключа. Непочтовые elicitation
продолжают пользоваться прежней формой и преобразованием результата.

### Административная настройка, по умолчанию выключено

Подписант не создаёт ключи при запросе модели. Без
`CLOUDCLI_MAIL_APPROVAL_CONFIG` почтовый challenge отклоняется. Некорректный
явно заданный конфиг останавливает запуск с нейтральной ошибкой.

Отдельная административная команда, **не выполнять через модельный инструмент**:

```bash
node scripts/mail-approval-keygen.mjs \
  --private-key /absolute/admin-only/cloudcli-mail.pem \
  --public-key /absolute/admin-only/cloudcli-mail-public.json
```

Каталог должен существовать и быть защищён администратором. Команда создаёт новые
файлы исключительно через O_EXCL, не перезаписывает существующие и не печатает
ключи. Закрытый ключ: Ed25519 PKCS8 PEM, ровно 0600. Открытая часть JSON содержит
`key_id` и raw32 `public_key` в base64url; её администратор отдельно закрепляет в
Mail. Никакая регистрация MCP или настройка Mail автоматически не меняется.

Пример **не-секретного** JSON конфига, значения условные:

```json
{
  "private_key_path": "/absolute/admin-only/cloudcli-mail.pem",
  "key_id": "cloudcli-local-human",
  "authorities": [
    {
      "tenant_id": "tenant-example",
      "user_id": "mail-user-example",
      "client_id": "client-example",
      "cloudcli_user_id": "1",
      "challenge_public_keys": {
        "issuer-key-id": "RAW32_PUBLIC_KEY_BASE64URL"
      }
    }
  ]
}
```

`cloudcli_user_id` записывается строкой. Конфиг и закрытый ключ должны принадлежать
UID процесса; symlink не допускаются. Конфиг нельзя оставлять доступным на запись
группе или остальным, рекомендуются права 0600. Файл ключа проверяется на том же
открытом inode. Затем администратор задаёт путь через
`CLOUDCLI_MAIL_APPROVAL_CONFIG=/absolute/admin-only/config.json` в окружении
backend и отдельно согласует перезапуск. Значения загружаются при старте,
смена ключа или authority требует перезапуска. В этой доработке реальные конфиги,
службы и MCP registry не менялись.

### Ограничения и проверки

Приёмка 15.11.2026: 56 серверных тестов и 21 клиентский прошли; typecheck без
ошибок, lint без ошибок (46 существующих предупреждений вне этой доработки),
полная сборка клиента и сервера прошла только в рабочем дереве. В автономном
браузерном стенде проверены светлая и тёмная темы при 390×844, видимость Bcc,
полного тела и вложений, отсутствие горизонтальной прокрутки и подтверждение
касанием. Временный сервер остановлен, файлы стенда удалены. Реальная отправка
Mail и работающий CloudCLI не проверялись и не перезапускались.

- Загрузчик ключа рассчитан на Unix UID и права POSIX; включение этого механизма
  на Windows не поддержано.
- Это доказательство авторизованного WS-события, не аппаратная аттестация
  физического нажатия. Украденный JWT, скомпрометированный браузер или backend
  находятся за этой границей доверия.
- 0600 не изолирует ключ от произвольного кода того же Unix UID. Если агенту
  доступны Bash/чтение от UID backend, аппаратной/OS-изоляции от такого кода нет.
  Для локального Mail-стенда это входит в ранее принятый S-22 риск: учётка и её
  процессы равны администратору. Это не разрешение обещать такую границу в проде;
  там нужна отдельная граница исполнения или запрет доступа к ключу. Один лишь
  путь env и отключение hooks не заменяют такую изоляцию.
- Реестр nonce находится в памяти процесса до срока challenge, максимум 10000
  ещё действующих challenge; после рестарта CloudCLI долговременную одноразовость
  обеспечивает Mail. Потерянное или просроченное подтверждение получают заново,
  старый token не восстанавливается из клиента.
- Реальные Mail/SMTP, модели, служба CloudCLI и пользовательские ключи не
  использовались. Интеграционный тест использует настоящий loopback WS и
  синтетический authenticated upgrade; SDK-ран подменён потоком без модели.

Из корня **отдельного рабочего дерева**, для каждого запуска новые HOME и БД:

```bash
H=$(mktemp -d)
env -i PATH="$PATH" HOME="$H" DATABASE_PATH="$H/auth.db" \
  node_modules/.bin/tsx --tsconfig server/tsconfig.json --test --test-concurrency=4 \
  server/shared/mail-approval/tests/*.test.ts \
  server/modules/providers/tests/claude-elicitation.test.ts \
  server/modules/providers/tests/claude-merge-runtime.regression.test.ts \
  server/modules/websocket/tests/chat-background-subscribe.test.ts

H=$(mktemp -d)
env -i PATH="$PATH" HOME="$H" DATABASE_PATH="$H/auth.db" NODE_ENV=test \
  node_modules/.bin/vitest run \
  src/modules/chat/tests/localMailElicitationPanel.test.tsx \
  src/modules/chat/tests/mcpElicitationPanel.test.tsx

H=$(mktemp -d)
env -i PATH="$PATH" HOME="$H" DATABASE_PATH="$H/auth.db" npm run typecheck
env -i PATH="$PATH" HOME="$H" DATABASE_PATH="$H/auth.db" npm run lint
env -i PATH="$PATH" HOME="$H" DATABASE_PATH="$H/auth.db" npm run build
```

### Ключевые файлы

- `server/shared/mail-approval/`: проверка issuer, приватный реестр и подписант,
  модульные и интеграционные тесты.
- `server/modules/providers/list/claude/claude-runtime.provider.ts`: отдельная
  ветка onElicitation, срок ожидания, нейтральное уведомление и возврат token.
- `server/modules/websocket/services/chat-websocket.service.ts`: authenticated
  WS boundary, проверка сессии перед обычным resolver.
- `src/modules/chat/tools/InteractiveRenderers/McpElicitationPanel.tsx`: отдельная
  plain-text форма Mail, прежняя форма остальных серверов сохранена.
- `src/modules/chat/hooks/useChatComposerState.ts`: sessionId в permission-response.
- `scripts/mail-approval-keygen.mjs`: явное создание ключей администратором.
- `.oxlintrc.json`: только добавление entrypoint в список shared-модулей,
  правила границ не ослаблены.

## Связанные страницы

- [Реестр правок](../fork-changes.md)
- [Архитектура](../dev/architecture.md)
- [Изолированные проверки](../dev/development.md)
