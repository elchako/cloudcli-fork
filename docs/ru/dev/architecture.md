---
title: Архитектура форка
type: dev
tags: [архитектура, карта-репозитория, провайдеры, claude-agent-sdk, авторизация, jwt, настройки, эндпоинты, голос, indexeddb]
description: "Карта репозитория CloudCLI (src/ и server/), откуда берутся сессии и что хранит своя БД, провайдер Claude и каталог моделей, ключевые механизмы форка и их эндпоинты: версии CLI, библиотека моделей, генерация картинок, чтение вне проекта, навигатор, очередь надиктовок, авторизация, настройки и секреты."
updated: 2026-11-09
---

# Архитектура форка

Полная официальная карта — `docs/upstream/development/01-architecture.md`
([зеркало upstream](../upstream-mirror.md), на английском). Здесь — рабочая
выжимка по репозиторию форка и ссылки на подробные страницы реестра.

## Что где хранится

**Провайдер по умолчанию — Claude Code** (`claude-agent-sdk`). CloudCLI не
дублирует его состояние: сессии читаются из того же `~/.claude/projects/*.jsonl`,
что и у нативного Claude Code. Своя БД CloudCLI (`~/.cloudcli/auth.db`) хранит
только учётки, токены, per-user настройки и уведомления.

Стек: **TypeScript + React + Vite** (клиент), **Node.js + Express + WebSocket**
(сервер), **better-sqlite3** (БД). Лицензия — AGPL-3.0-or-later.

## Две зоны

| Зона | Что внутри |
|---|---|
| `src/` | Клиент: React-компоненты, хуки, контексты, i18n, утилиты. Сборка Vite → `dist/`. |
| `server/` | Сервер: Express-роуты, WebSocket, провайдеры CLI-агентов, БД, сервисы. Сборка tsc → `dist-server/`. |

### Клиент — `src/`

| Каталог | Ответственность |
|---|---|
| `modules/` | Доменные модули (с 1.37.3 вместо `components/`): `chat/` (`composer/`, `transcript/`, `tools/`, `hooks/`), `sidebar/`, `project-workspace/` (шапка, вкладки), `auth/`, `settings/`, `file-tree/`, `code-editor/`, `shell/`, `i18n/` (i18next) и др. |
| `shared/` | Общий код: `api.ts` (fetch-обёртки + JWT), `authToken.ts`, `userSettings.ts` (per-user настройки апстрима в БД: тема, язык, UI-настройки, права…), `userSettingsSync.js` (наш мост для того, чего там нет), `voiceConfig.ts`, `context/` (`ThemeContext`, `WebSocketContext` и др.), `ui/`, `types.ts`. |

### Сервер — `server/`

| Каталог | Ответственность |
|---|---|
| `index.ts` | Точка входа: монтирование роутов, middleware, WebSocket, статика. |
| `routes/` | REST-роуты (`settings.js`, `agent.js`, `git.js`, `commands.js` и др.). |
| `modules/` | Доменные модули: `assets/` (вложения), `database/` (схема, репозитории, миграции), `providers/` (список моделей и синхронизация сессий по провайдерам), `websocket/` (чат-шлюз), `image-generation/` (наш встроенный MCP-инструмент `generate_image`). |
| `services/` | Сервисы (уведомления, vapid и пр.). |
| `middleware/` | `auth.js` (JWT), валидация API-ключа. |
| `shared/` | Общий код сервера: `image-attachments.ts` (доставка вложений провайдерам), `secret-box.ts` (шифрование секретов) и др. |
| `modules/providers/list/claude/claude-runtime.provider.ts` | Провайдер Claude Code: сборка промпта, опции SDK, стриминг (с v1.37.6 — TypeScript). |

## Большие списки sidebar

`SidebarProjectList` виртуализирует больше 60 проектов через `react-virtuoso`:
видимое окно плюс 200px, переменная высота раскрытых групп, ключ `projectId`.
`SidebarContent` передаёт внутренний scroll-root существующего `ScrollArea`.
Данные, порядок, поиск и серверная пагинация не меняются; маленькие списки
рендерятся как раньше. Причина и замеры — [производительность sidebar](../fork/sidebar-performance.md).

## Провайдер Claude и каталог моделей

С 2026-11-08 адаптер Claude читает `GET /v1/models` подключённого API теми же
серверными credentials, что использует CLI (env → `~/.claude/settings.json`).
`claude-api-models.ts` держит кэш 5 минут, объединяет одновременные обращения и
отдаёт последний успешный список, пока обновляет его в фоне. `small-model.ts`
обходит страницы в одном endpoint; для шлюзов сначала запрашивает обычные ID
через Bearer без `anthropic-version`, затем при необходимости использует
Anthropic-протокол. Ключ не передаётся в браузер и не копируется в БД.

`GET /api/providers/claude/models?refresh=1` явно перечитывает каталог; обычный
маршрут возвращает прежнюю структуру с необязательным `SOURCE`:
`api` / `api-cache` / `fallback`. Кнопка обновления — в библиотеке моделей.
`CLAUDE_PREDEFINED_MODELS` теперь запасной список и метаданные известных моделей,
а не ограничение обнаружения; штатный SDK `default` сохранён. Ручные модели
объединяются в `provider-models.service.ts`, их имя/effort имеют приоритет при
совпадении ID с API ([API-каталог](../fork/api-models.md)).

Поле `owned_by` API передаётся в `OPTIONS[].catalogProvider` (необязательная
строка до 128 символов). Общая `groupModelsByCatalogProvider` группирует меню,
библиотеку и общий выбор моделей по этой метке, а не по префиксу ID. Например,
Gemini и Claude с `owned_by=antigravity` остаются вместе. `LLMProvider` при выборе
не меняется: API-группы внутри Claude Code запускаются через прежнюю интеграцию.
Ручные описания того же ID наследуют метку только из текущего API, без записи в
БД; при отсутствии метаданных сохраняется плоский список ([§22.1](../fork/api-models.md)).

Выбранный `value` передаётся в `claude-agent-sdk` как `model` без замены ID.
Исключение — подтверждённый gateway-транспорт effort: уровень добавляется
суффиксом (`gpt-6-astra(max)`, `gemini-4-argon-high(low)`).
`OPTIONS[].effort.transport` различает `sdk` и `model-suffix`; дополнительные
уровни шлюза не передаются валидатору effort CLI. `reasoningStatus` различает
`unknown` и `unsupported`. Явные `capabilities.reasoning`/`thinking.levels` API
имеют приоритет; `claude-model-reasoning.ts` хранит только подтверждённые
запасные метаданные, не список доступности. Синтетический Codex-client каталог
не используется; неизвестным моделям уровни не выдумываются ([§22.2](../fork/api-models.md)).
Совместимость с масками `claude-fable-5-dd-*` сохранена для метаданных и
сопоставления контекста. Старые сеансы не мигрируют на другую модель.
`CLAUDE_CODE_MAX_CONTEXT_TOKENS=930000` остаётся прежним
([GPT через шлюз](../fork/gpt-gateway.md)).

Для `catalogProvider=antigravity` SDK-ран получает закрытый loopback-транспорт
`claude-antigravity-transport.ts`. Он заменяет только точную служебную SDK identity
в system-блоке конкретного Antigravity-запроса на нейтральную identity CloudCLI.
Нативный preset, история/snapshot, tools, model, effort и beta-параметры сохранены;
другие модели проходят без преобразования. Ключ не хранится и не логируется,
цель фиксирована исходным API endpoint, редиректы запрещены, SSE передаётся потоком.
Listener закрывается в `queryClaudeSDK.finally` ([§22.3](../fork/api-models.md)).
Адрес адаптера задаётся и в spawn `options.env`, и в приоритетном
`options.settings.env.ANTHROPIC_BASE_URL`: иначе CLI повторно применяет env из
пользовательских/проектных настроек и может отправить запрос напрямую в шлюз.
Остальные inline settings и вложенный env сохраняются, `settingSources`
остаётся `['project','user','local']`; файлы настроек пользователя не меняются.

## Модели для названий чатов

`session-title-models.service.ts` хранит явную пару `primaryModel`/`fallbackModel`
в `user_settings["session-title-models"]`. Авторизованные
`GET/PUT /api/settings/session-title-models` обслуживают отдельную настройку
во «Внешнем виде»; данные не дублируются в `userSettingsSync`/localStorage.
Текстовые кандидаты берутся из `claudeApiModelCatalog`, распознаваемые image-ID
отфильтрованы; цена неизвестна и не ранжируется. `session-title.service.ts`
пробует основной и резервный ID, сохраняя один совместимый thinking retry,
очередь, сырой fallback и защиту ручных имён. Минимальный effort передаётся только
для подтверждённых метаданных/транспорта; неизвестным моделям уровни не выдумываются.
Фоновые названия используют первого активного пользователя single-user инстанса,
ручная регенерация — ID авторизованного пользователя
([§4.9-тер](../fork/session-titles.md)).

## Runtime и версии CLI

С upstream v1.37.6 `buildClaudeSdkEnv` сохраняет окружение хоста, включает
`CLAUDE_CODE_ARTIFACT=1` по умолчанию (явный `0` сохраняется) и задаёт потолок
ожидания фоновой работы. В настройках показываются версии установленных CLI:
`GET /api/providers/:provider/cli`; ручное обновление —
`POST /api/providers/:provider/cli/update`, во время работы провайдера оно
запрещено. Это обновление самого CLI, не кода форка и не зависимостей SDK
([слияние v1.37.6](../fork/merge-v1.37.6.md)).

## Управление выполняющимся ответом (v1.37.8)

- `chat.steer` (`{ sessionId, messageId, content, options? }`) принимает уточнение
  в уже работающий Claude-ран. Runtime добавляет сообщение с `priority: 'next'`
  и включает `extraArgs: { 'replay-user-messages': null }`; подтверждение —
  `chat_steer_accepted`, доставка подтверждается эхом пользовательского сообщения.
- `chat.side_question` запускает побочный вопрос в отдельной сессии своего
  провайдера; основной transcript не меняется. Удаление карточки —
  `DELETE /api/providers/sessions/:sessionId/side-questions/:sideQuestionId`.
  Клиент сверяется с `supportsSteering` / `supportsSideQuestions`
  из матрицы возможностей, а не предполагает поддержку всеми провайдерами.
- MCP elicitation приходит через SDK `onElicitation` и показывается отдельной
  панелью разрешений. Его нельзя незаметно отклонять на сервере.
- Состояние отправки — `useChatComposerState`, выбор — `ComposerSendMenu`.
  Черновики/вложения по `draftScope` сохранены и для steer
  ([сохранность вложений](../fork/attachments.md), [чат](../chat.md)).

SDK Claude обновлён до 0.3.311, Codex CLI/SDK — 0.166.0. Это зависимости
CloudCLI; ручной CLI updater по-прежнему отдельное действие.

## Пользовательские модели

Библиотека моделей дополняет встроенный список записями из `provider_models`.
Добавление — через интерфейс или `POST /api/providers/:provider/models` с
`{ model: название, id: ID }`. Это только название, ID и effort, не отдельный
адрес API или ключ: если источник настроен в общем шлюзе, менять
`CLAUDE_PREDEFINED_MODELS` не нужно ([свои модели](../fork/custom-models.md)).

## Генерация картинок

Если задан шлюз (`ANTHROPIC_BASE_URL` в env или `~/.claude/settings.json`),
каждый Claude-ран получает in-process MCP-инструмент
`mcp__cloudcli-images__generate_image` (`server/modules/image-generation/`):
`/v1/images/generations` и `/v1/images/edits` шлюза → PNG в `~/.cloudcli/assets`
→ картинка в карточке инструмента с запрошенными моделью, режимом, качеством
и временем. `image-generation-settings.service.ts` хранит в
`user_settings["image-generation"]` три профиля `draft`/`standard`/`final`
(модель GPT Image + quality) и `defaultProfile`. Авторизованные
`GET/PUT /api/settings/image-generation`, `GET ?refresh=1` и
`ImageGenerationSettings.tsx` обслуживают выбор из общего API-каталога.
Профиль читается при каждом вызове инструмента; `userId` приходит из рана,
не от модели. Маски CLIProxyAPI нормализуются в настоящие image-ID, неподдержанные
семейства не обещаются. Ошибка не переключает модель автоматически.
Флаги: `CLOUDCLI_IMAGE_GEN=off`, `CLOUDCLI_IMAGE_MODEL` — только default до
сохранения, иначе `gpt-image-2.6`. Настройки работают без перезапуска
([генерация картинок](../fork/image-generation.md), §13.3).

## Чтение файлов вне проекта

Просмотрщик (редактор, превью медиа, дерево файлов) читает весь workspace-root
(`WORKSPACES_ROOT`, по умолчанию домашняя папка) и «корни на чтение»: встроенные
апстрима (`/tmp`, `os.tmpdir()`, `~/.claude/projects`) плюс `CLOUDCLI_READ_ROOTS`
(`getExtraReadRoots`, `server/shared/utils.ts`; разделитель как в `PATH`).
Проверка идёт по realpath. Запасной `local-media` использует корни на чтение, не
весь workspace-root. Запись вне проекта и передача вложений вне assets/cwd
запрещены ([файлы вне проекта](../fork/file-viewer.md)).

## Навигатор по вопросам

Оглавление справа в ленте строится из
`GET /api/providers/sessions/:sessionId/prompts` (`session-prompts.service.ts`),
а не из загруженного. Состояние — `usePromptNavigator`, вид —
`ChatPromptNavigator` ([навигатор](../fork/prompt-navigator.md)).

## Очередь надиктовок

Диктовка пишется в IndexedDB `cloudcli-voice-outbox` по чанку в секунду
(`src/shared/voiceOutbox.ts`: хранилище, замки Web Locks между вкладками).
У записи есть владелец: очередь видит только записи вошедшего пользователя,
явный выход из аккаунта стирает его записи. Не дошла до распознавания — остаётся в очереди, а
`voiceDelivery.ts` досылает её фоном: на `online`, при возврате на вкладку,
при открытии страницы и раз в 20 с. Политика повторов и таймаут — там же.
Попытка несёт заголовок `Idempotency-Key` с id записи, сервер diktor по нему не
распознаёт аудио дважды. Своих эндпоинтов нет: запрос идёт тем же
`transcribeVoice` ([очередь надиктовок](../fork/voice.md)).

## Озвучка ответов

Кнопка «прочитать вслух» ведёт в один на всё приложение плеер
`src/modules/chat/utils/voicePlayer.ts`: он живёт вне React, поэтому смена чата
не обрывает звук. Запрос — `synthesizeVoice` (`src/shared/api.ts`): на свой
Base URL браузер ходит напрямую (`/audio/speech`), без него — через прокси
`POST /api/voice/tts`. Ответ `audio/mpeg` играется потоком через
`MediaSource` с первого куска; без `MediaSource` — целым файлом. Готовый файл
кэшируется по тексту и настройкам голоса (до 24 записей).
Бэкенд холдинга — diktor с Edge TTS ([озвучка](../fork/voice.md)).

Перед синтезом `prepareSpokenText` (`src/shared/speechSummary.ts`) может
подменить текст сводкой: `POST /api/speech-summary` (модуль
`server/modules/speech-summary/`) пересказывает длинный ответ основной, затем
резервной текстовой моделью подключённого API. `GET /api/speech-summary/status`
и `GET /api/speech-summary/models?refresh=1` обслуживают экран настроек.
`models` сохраняет старый массив ID, `modelOptions`/`source` дают подписи и
состояние общего `claudeApiModelCatalog`; ограничения Claude больше нет.
Режим, инструкция, основная и резервная модели — `speech_summary`,
`speech_summary_prompt`, `speech_summary_model`, `speech_summary_fallback_model`
в `voice_settings`. Старый primary сохранён; резерв пуст до явного выбора.
Общий дедлайн — 30 с, резерву оставлено 12 с; отмена не запускает резерв.
Если сводка не получилась, TTS получает полный исходник, а
`VoiceSnapshot.notice` показывает отдельное уведомление, включая replay-кэш.
Env: `CLOUDCLI_SPEECH_SUMMARY=off` — выключить, `CLOUDCLI_SPEECH_SUMMARY_MODEL`
— default вместо `claude-haiku-5-5` (собственный выбор важнее).
Транспорт общий с ИИ-названиями — `small-model.ts`, политика каталога,
подтверждённого effort и thinking retry — `background-models.ts`. Общие
потребители получают каталог через лёгкий публичный
`providers/model-catalog.ts`, не через `providers/index.ts`: общий barrel
инициализирует registry/runtime и создаёт обратный ESM-цикл с инструментами.
Lint разрешает этому entrypoint только три конкретные реализации каталога.
Неизвестным моделям параметры рассуждений не угадываются
([сводка вслух](../fork/speech-summary.md), §4.16-тер).

## Браузер и уведомления (v1.37.8)

Browser-панель upstream принимает ручные клики и ввод; MCP дополнен
`browser_upload_file`. Это фоновые браузерные сессии CloudCLI, не видимый Chrome
на рабочем столе: личный вход пользователя выполняется по прежнему правилу
видимого Chrome/CDP.

Опциональный канал уведомлений `webhook` хранит URL и состояние в
`notification_channel_endpoints`. Маршруты: `GET`/`PUT`/`DELETE`
`/api/notifications/webhook`, `POST`/`DELETE`
`/api/notifications/webhook/secret`, `POST /api/notifications/webhook/test`.
В форке ключ подписи шифруется через `sealSecret`; протокол подписи upstream не
меняется. События не содержат текстов запросов и ответов. Без настроенного
канала ничего не отправляется ([webhook](../fork/webhook-notifications.md)).

## Аутентификация

JWT (`JWT_SECRET` в БД, таблица `app_config`), payload `{userId, username}`.
Middleware `authenticateToken` принимает токен из заголовка
`Authorization: Bearer` **или** из query `?token=`: так его получают `<img>` и
EventSource, которые не умеют ставить заголовки. Это штатно, не дыра. Первый вход
при пустой БД — `POST /api/auth/register`. Срок жизни токена и разлогин —
[долгая сессия входа](../fork/auth-session.md).

## Настройки пользователя и секреты

С 1.37.3 апстрим сам хранит per-user в БД тему, язык, UI-настройки, права,
настройки редактора, выбранного провайдера и звёзды проектов (`user_preferences`,
клиент — `src/shared/userSettings.ts`). Наш `src/shared/userSettingsSync.js`
(таблица `user_settings`) покрывает только то, что апстрим держит лишь в
localStorage: модель и effort по провайдерам, режимы прав, вкладку, вид дерева
файлов, ширину сайдбара, док и ручку быстрых настроек
([настройки в БД](../fork/user-settings.md)).

Секреты в `user_settings` не пишутся. Ключ API голоса и ключ подписи webhook
шифруются AES-256-GCM (`sealSecret` из `server/shared/secret-box.ts`; мастер-ключ
лежит рядом с БД, так что от кражи диска это не защищает). Остальные значения
`user_credentials` хранятся открытым текстом
([голосовой ввод](../fork/voice.md), [webhook](../fork/webhook-notifications.md)).

## Связанные страницы

- [Разработка: команды, тесты, проверки](development.md) — как собирать и проверять
- [Реестр правок форка](../fork-changes.md) — все отличия от оригинала по темам
- [Деплой форка на ноуте mx-linux](../deploy.md) — откуда работает боевой инстанс
- [Зеркало документации upstream](../upstream-mirror.md) — официальная документация
