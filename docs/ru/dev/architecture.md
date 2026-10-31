---
title: Архитектура форка
type: dev
tags: [архитектура, карта-репозитория, провайдеры, claude-agent-sdk, авторизация, jwt, настройки, эндпоинты]
description: "Карта репозитория CloudCLI (src/ и server/), откуда берутся сессии и что хранит своя БД, провайдер Claude и каталог моделей, ключевые механизмы форка и их эндпоинты: версии CLI, библиотека моделей, генерация картинок, чтение вне проекта, навигатор, авторизация, настройки и секреты."
updated: 2026-10-31
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

## Провайдер Claude и каталог моделей

Значение выбранной модели (`value` из `CLAUDE_PREDEFINED_MODELS` в
`server/modules/providers/list/claude/claude-models.provider.ts`) передаётся в
`claude-agent-sdk` как `model` **напрямую**. Поэтому это должен быть алиас или
ID, который понимает Claude Code (`sonnet`, `claude-opus-5-5`, суффикс `[1m]`
для 1M-контекста). `getSupportedModels()` апстрим отключил, так что новые модели
сами не появляются — их дописывают в массив вручную
([модели](../fork/models.md)).

Исключение — GPT через шлюз CLIProxyAPI (`gpt-6-astra`, `gpt-6.1-sol`): шлюз
игнорирует `effort`, поэтому выбранный уровень уходит суффиксом в id
(`gpt-6-astra(max)`, `withGatewayEffortSuffix`); в БД и UI модель хранится без
суффикса. Окно контекста этих моделей задаёт env
`CLAUDE_CODE_MAX_CONTEXT_TOKENS=930000` — подробно и почему не 1M —
[GPT через шлюз](../fork/gpt-gateway.md).

## Runtime и версии CLI

С upstream v1.37.6 `buildClaudeSdkEnv` сохраняет окружение хоста, включает
`CLAUDE_CODE_ARTIFACT=1` по умолчанию (явный `0` сохраняется) и задаёт потолок
ожидания фоновой работы. В настройках показываются версии установленных CLI:
`GET /api/providers/:provider/cli`; ручное обновление —
`POST /api/providers/:provider/cli/update`, во время работы провайдера оно
запрещено. Это обновление самого CLI, не кода форка и не зависимостей SDK
([слияние v1.37.6](../fork/merge-v1.37.6.md)).

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
→ картинка в карточке инструмента. Флаги: `CLOUDCLI_IMAGE_GEN=off`,
`CLOUDCLI_IMAGE_MODEL` (по умолчанию `gpt-image-2.5`)
([генерация картинок](../fork/image-generation.md)).

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

Секреты в `user_settings` не пишутся. Ключ API голоса хранится отдельно и
шифруется AES-256-GCM (`sealSecret` из `server/shared/secret-box.ts`; мастер-ключ
лежит рядом с БД, так что от кражи диска это не защищает). Остальные значения
`user_credentials` хранятся открытым текстом
([голосовой ввод](../fork/voice.md)).

## Связанные страницы

- [Разработка: команды, тесты, проверки](development.md) — как собирать и проверять
- [Реестр правок форка](../fork-changes.md) — все отличия от оригинала по темам
- [Деплой форка на ноуте mx-linux](../deploy.md) — откуда работает боевой инстанс
- [Зеркало документации upstream](../upstream-mirror.md) — официальная документация
