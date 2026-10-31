---
title: "Слияние upstream v1.37.3"
type: fork-merge
sections: [§8, §8.1, §8.2, §8.3, §8.4, §8.5]
tags: [upstream, слияние, v1.37.3, oxlint, src-modules]
description: "Слияние upstream v1.37.3: переезд src/components → src/modules, куда переехали наши файлы, что upstream сделал сам, что восстановили вручную, тесты."
updated: 2026-10-31
---

# Слияние upstream v1.37.3

> Разделы реестра §8, §8.1, §8.2, §8.3, §8.4, §8.5. Часть [реестра правок форка](../fork-changes.md): номер § — постоянный адрес правки, по нему на эту страницу ссылаются код и коммиты.

> Релиз 1.37.3 — самый крупный по структуре за всё время форка: 734 файла,
> `src/components/**` → `src/modules/**`, `src/shared/view/ui` → `src/shared/ui`,
> `src/utils/api.js` → `src/shared/api.ts` (TypeScript), eslint → **oxlint**
> (`.oxlintrc.json`), добавлен **vitest** (`npm test`, `npx vitest run`).
> 28 конфликтов, разрешены вручную.

## §8.1 Куда переехали наши файлы

| Было (наш путь до 1.37.3) | Стало |
|---|---|
| `src/utils/api.js` | `src/shared/api.ts` (наши 4 правки перенесены) |
| `src/utils/userSettingsSync.js` | `src/shared/userSettingsSync.js` |
| `src/hooks/useVoiceConfig.ts` | логика → `src/shared/voiceConfig.ts`, хук → `src/modules/settings/hooks/useVoiceConfig.ts` |
| `src/lib/voiceApi.ts` | поглощён `src/shared/api.ts` (наши правки применены поверх) |
| `src/components/sidebar/**` | `src/modules/sidebar/**` |
| `src/components/chat/**` | `src/modules/chat/{composer,transcript,hooks,utils}/**` |

## §8.2 Что upstream сделал сам (наши задачи закрыты оригиналом)

- **Меню «три точки» в «Разговорах»** и общий компонент строки сессии:
  `src/modules/sidebar/SessionOptions.tsx` (rename / copy id / fork / archive)
  используется и списком проектов, и списком разговоров. Наш пункт
  «Перегенерировать название» добавлен **в этот общий компонент** — поэтому он
  теперь есть в обоих списках. **Риск:** 🟡 — правим upstream-файл.
- **Индикатор «в работе» в «Разговорах»** — `Loader2` + амбер-точка «нужно
  внимание» уже в `SidebarRecentConversations.tsx`. Свою версию не писали.
- **Настройки в localStorage → БД:** upstream ввёл свой механизм
  (`shared/userSettings`, `user_preferences`, `hydrateUserPreferences`).
  Наш `userSettingsSync` **пока сохранён параллельно** — контуры разные
  (наш покрывает и voice/секреты). Кандидат на схлопывание в отдельной задаче.

## §8.3 Правки, которые пришлось восстановить вручную

- **Фикс 401** (`shared/api.ts`): upstream снова сбрасывает сессию по одному
  заголовку `X-Auth-Error`. Наше условие `token && status === 401` возвращено,
  иначе повторяется регресс «логин при каждом обновлении». Покрыто тестами
  `src/shared/tests/authenticatedFetch.test.ts` (в т.ч. 502 и «нет токена»).
  **Риск:** 🔴 — ядро авторизации, проверять каждый мерж.
- **Автоархив служебных сеансов** (`sessions.db.ts`): upstream независимо чинил
  тот же `isArchived` (PR #1220 — «архив переживает рескан»). Логики объединены:
  наше правило (служебная сессия остаётся архивной) применяется первым, затем
  upstream-овское. **Риск:** 🔴.
- **Voice: ленивое раскрытие ключа** — `revealVoiceApiKey()` в
  `transcribeVoice`/`synthesizeVoice`, подпись конфига без `apiKey`.
  Upstream-версия ушла бы к кастомному backend без ключа.
- **`canCaptureMic()`** (`useVoiceAvailable.ts`) — upstream удалил; возвращено,
  иначе на телефоне по HTTP кнопка микрофона всегда падает.
- **Fallback `local-media`** (`CodeEditorMediaPreview.tsx`) — upstream оставил
  только проектный эндпоинт; вернули цепочку кандидатов для файлов вне корня
  проекта (скриншоты в `/tmp`).

## §8.4 Мелкие правки, вызванные новой структурой

- `.oxlintrc.json` — `server/shared/secret-box.ts` внесён в
  `backend-shared-utils` (иначе `boundaries/no-unknown`).
- `src/modules/code-editor/index.ts` — экспортирует `getPreviewKind`: чат
  обращается к нему через barrel (`boundaries/dependencies`).
- `src/shared/userSettingsSync.js` — `@/modules/i18n` теперь грузится
  **динамически**. Статический импорт тянул инициализацию i18next (а с ней
  чтение стора настроек) в каждый модуль, который импортировал этот файл.
- `src/shared/voiceConfig.ts` ↔ `src/shared/api.ts` — циклический импорт,
  безопасный: обращения к `api` только внутри async-функций.

## §8.5 Тесты

- Клиентские (vitest): **398 прошли**. Прогонять `NODE_ENV=test npx vitest run` —
  в среде выставлен `NODE_ENV=production`, из-за него React грузится в
  production-сборке и `act()` не работает (367 ложных падений).
- Упавшие серверные тесты (`claude-cli-path`, `conversation search`) проверены на
  чистом `v1.37.3` — падают и там. Не наши регрессы.
- Наши тесты (заголовки сессий, secret-box, вложения): **37 прошли**.

## Связанные страницы

- [Как вливать upstream](upstream-merge.md) — порядок слияния
- [Слияние upstream v1.37.4 (2026-10-09)](merge-v1.37.4.md) — следующее слияние
