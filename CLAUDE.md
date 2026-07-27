# CLAUDE.md

Этот файл — руководство для Claude Code (claude.ai/code) и других ИИ-ассистентов
при работе с кодом в этом репозитории.

> Пиши лаконично на русском (комментарии, коммиты, ответы). Английский — только
> для технических идентификаторов, команд и путей.

## Что это

**CloudCLI** (`@cloudcli-ai/cloudcli`, апстрим-бренд `siteboon/claudecodeui`) —
веб-интерфейс к CLI-агентам **Claude Code**, **Cursor CLI** и **Codex**. Поднимает
локальный сервер (по умолчанию порт 3001), к которому подключаешься с
ноутбука/телефона/другой машины: чат с агентом, файловый браузер, git, встроенный
терминал, управление сессиями, планировщик, интеграция с браузером через MCP.

Это **форк холдинга GOLDJAXE** поверх `siteboon/claudecodeui`. Наш основной
сценарий — единая удалённая рабочая среда, доступ преимущественно **с телефона по
Tailscale**. Ветка доработок — `feat/goldjaxe-improvements`. Подробности форка,
его целей и правил доработки — в `GOLDJAXE-FORK.md`.

**Провайдер по умолчанию — Claude Code** (`claude-agent-sdk`). CloudCLI не
дублирует его состояние: сессии читаются из того же `~/.claude/projects/*.jsonl`,
что и нативный Claude Code. Своя БД CloudCLI (`~/.cloudcli/auth.db`) хранит только
учётки, токены, per-user настройки и уведомления.

Стек: **TypeScript + React + Vite** (клиент), **Node.js + Express + WebSocket**
(сервер), **better-sqlite3** (БД). Лицензия — AGPL-3.0-or-later.

## Команды

```bash
# Разработка (клиент :5173 + сервер :3001 одновременно)
npm run dev

# По отдельности
npm run client            # только Vite dev-сервер
npm run server:dev        # только Express/WS через tsx
npm run server:dev-watch  # то же с авто-перезапуском

# Сборка (клиент → dist/, сервер → dist-server/)
npm run build             # = build:client + build:server
npm run build:client      # vite build
npm run build:server      # tsc -p server/tsconfig.json + tsc-alias

# Прод-запуск собранного
npm run start             # build + node dist-server/server/index.js
npm run server            # только запуск уже собранного dist-server

# Проверки (гонять перед каждым коммитом)
npm run typecheck         # tsc --noEmit для client И server
npm run lint              # eslint src/ server/
npm run lint:fix          # eslint --fix

# Тесты — на node:test, ЗАПУСКАТЬ через tsx (нужен для алиасов @/):
npx tsx --tsconfig server/tsconfig.json --test <path/to/*.test.ts>
# ⚠️ Отдельного `npm test` НЕТ. Тестовые файлы — server/**/tests/*.test.ts.

# Desktop-компаньон (Electron) — обычно не нужен для веб-сценария
npm run desktop:dev
```

**Node.js:** `.nvmrc` просит v22; в нашей среде стоит v24 и он совместим для
сборки vite/react и запуска сервера. Апстрим требует Node ≥ 22.

**Установка апстрима у конечного пользователя** (не для разработки форка) —
`npx @cloudcli-ai/cloudcli` или `npm i -g @cloudcli-ai/cloudcli && cloudcli`.

**Husky/lint-staged** активны: pre-commit гоняет eslint по staged-файлам.

## Архитектура

Полная официальная карта — `docs/upstream/development/01-architecture.md`
(апстрим, EN). Ниже — рабочая выжимка по репозиторию.

**Две зоны:**

| Зона | Что внутри |
|---|---|
| `src/` | Клиент: React-компоненты, хуки, контексты, i18n, утилиты. Сборка Vite → `dist/`. |
| `server/` | Сервер: Express-роуты, WebSocket, провайдеры CLI-агентов, БД, сервисы. Сборка tsc → `dist-server/`. |

**Клиент — `src/`:**

| Каталог | Ответственность |
|---|---|
| `components/` | React-компоненты по доменам: `chat/` (композер, рендер сообщений, вложения), `auth/`, `settings/`, `file-tree/`, `code-editor/`, `sidebar/`, `shell/`. |
| `contexts/` | React-контексты: `ThemeContext`, `WebSocketContext`, `PaletteOpsContext` и др. |
| `hooks/` | Общие хуки (например `useSessionProtection`). |
| `i18n/` | Локализация (i18next). Язык хранится в localStorage-ключе `userLanguage`. |
| `utils/` | `api.js` (fetch-обёртки + JWT), `userSettingsSync.js` (синхро настроек с БД) и пр. |
| `stores/`, `lib/`, `types/`, `constants/`, `shared/` | Состояние, библиотеки, типы, константы, общий UI. |

**Сервер — `server/`:**

| Каталог | Ответственность |
|---|---|
| `index.js` | Точка входа: монтирование роутов, middleware, WebSocket, статика. |
| `routes/` | REST-роуты (`settings.js`, `agent.js`, `git.js`, `commands.js` и др.). |
| `modules/` | Доменные модули: `assets/` (вложения), `database/` (схема, репозитории, миграции), `providers/` (список моделей и синхро сессий по провайдерам), `websocket/` (чат-шлюз). |
| `services/` | Сервисы (уведомления, vapid и пр.). |
| `middleware/` | `auth.js` (JWT), валидация API-ключа. |
| `shared/` | Общий код сервера: `image-attachments.ts` (доставка вложений провайдерам) и др. |
| `claude-sdk.js` | Провайдер Claude Code: сборка промпта, опции SDK, стриминг. |

**Провайдер Claude по умолчанию.** Значение выбранной модели (`value` из
`CLAUDE_FALLBACK_MODELS` в `server/modules/providers/list/claude/claude-models.provider.ts`)
передаётся в `claude-agent-sdk` как `model` **напрямую** — то есть это должен быть
алиас или ID, который понимает Claude Code (`opus`, `sonnet`, `claude-opus-5`,
суффикс `[1m]` для 1M-контекста).

**Аутентификация.** JWT (`JWT_SECRET` в БД `app_config`), payload `{userId,
username}`. Middleware `authenticateToken` принимает токен из заголовка
`Authorization: Bearer` **или** из query `?token=` (для EventSource/`<img>`,
которые не ставят заголовки). Первый вход при пустой БД — `POST /api/auth/register`.

**Настройки пользователя.** Апстрим хранит UI-настройки в localStorage; наш форк
дублирует их в БД (`user_settings`) через `src/utils/userSettingsSync.js`, чтобы
они переживали очистку кэша/релогин/смену устройства. Секреты (voice apiKey)
в этот JSON НЕ пишутся.

## Наши доработки (форк)

Реализованы поверх апстрима (см. `GOLDJAXE-FORK.md` и git-историю ветки):

1. **Нативный показ картинок в чате** — markdown `![](/api/assets/...)`
   рендерится через `MarkdownImage` (blob-загрузка защищённых путей, JWT в
   заголовке, не в DOM).
2. **Прикрепление любых файлов** — не только картинки; не-картинки доходят до
   агента как читаемый путь (блок `<files_input>`), а не base64.
3. **Мобильный переключатель effort** — фикс гонки `pointerdown` в портал-меню.
4. **Настройки в БД** — per-user `user_settings`, синхро localStorage↔БД.
5. **Opus 5 в списке моделей** — список моделей захардкожен, добавлены
   `claude-opus-5` и `claude-opus-5[1m]`.

## Важно при работе с кодом

- **Источник истины — код**, доки местами отстают (особенно `docs/upstream/`
   зеркалит внешний сайт на момент забора). Имена флагов/полей/эндпоинтов сверяй с
   кодом, не выдумывай.
- **Не менять `raw`-контракты апстрима без нужды.** Мы форк и хотим уметь
   вливать обновления апстрима с минимумом конфликтов ([[GOLDJAXE-FORK.md]]).
   Правки по возможности локальны и снабжены комментарием, зачем.
- **Список моделей захардкожен.** `getSupportedModels()` в
   `claude-models.provider.ts` отключён апстримом → новые модели не появляются
   автоматически, их дописывают в `CLAUDE_FALLBACK_MODELS` вручную. `value` модели
   уходит в SDK как есть — используй алиас/ID, понятный Claude Code.
- **Токен в query.** Ресурсы, которые нельзя запросить с заголовком (`<img>`,
   EventSource), берут JWT из `?token=`. Это штатно (см. `middleware/auth.js`);
   не считать дырой.
- **Вложения — единый trust boundary.** Файл доходит до агента только если лежит
   в `~/.cloudcli/assets` или в cwd рана (`isAllowedImageSourcePath` в
   `server/shared/image-attachments.ts`). Не ослабляй эту проверку. Не-картинки
   отдаются с `Content-Disposition: attachment` (не рендерить инлайн).
- **Настройки в БД без секретов.** В `user_settings` — только не-секретные
   UI-настройки. Секреты (voice apiKey) остаются device-local либо идут в
   `user_credentials`. Внимание: at-rest шифрования в форке НЕТ — не обещай его.
- **Портальные меню и мобильный тач.** Меню, отрендеренные через `createPortal`,
   с закрытием по `document`-listener на `pointerdown` ОБЯЗАНЫ гасить всплытие на
   пунктах (`stopPropagation`), а listener — оставаться bubble-фазным, иначе на
   touch выбор не срабатывает (см. комментарий в `ChatComposer.tsx`).
- **Проверяй себя всеми инструментами.** Перед коммитом: `npm run typecheck`,
   `npm run lint` (0 ошибок; предупреждения апстрима — базовые, их не плодить),
   при правках сервера — `npm run build` и профильные `node:test`. Для UI/тач-
   специфики — проверка в браузере (мобильный вьюпорт) на локальном инстансе
   (отдельный `SERVER_PORT`/`DATABASE_PATH`, рабочий :3301 не трогать).
- **Тесты — через tsx.** `npx tsx --tsconfig server/tsconfig.json --test <file>`.
   Алиасы `@/` без tsx не резолвятся. Новую серверную логику покрывай тестом
   рядом (`server/**/tests/*.test.ts`).
- **Документацию держи актуальной — в том же изменении, не «потом».** Карта:
  - `docs/upstream/` — ЗЕРКАЛО официальной доки (EN). Правим осторожно: это база
    для перевода на русский. Наши пометки — отдельными блоками/файлами.
  - `docs/ru/` — наш перевод и дополнения на русском (по мере готовности).
  - изменил поведение фичи → соответствующая страница в `docs/ru/` (и пометка,
    если расходится с апстримом);
  - новая модель/флаг/эндпоинт → отрази в CLAUDE.md (раздел «Архитектура»/
    «Наши доработки») и в профильной странице `docs/`;
  - новая крупная доработка форка → строка в «Наши доработки» здесь и в
    `GOLDJAXE-FORK.md`.
- **Git.** Коммиты по-русски, префиксы `feat/fix/docs/refactor/chore`. Заканчивай
   commit-сообщение строкой `Co-Authored-By: Claude Opus 4.8 (1M context)
   <noreply@anthropic.com>`. PR в апстрим `siteboon/claudecodeui` — по политике
   гибрид «форк+PR».
