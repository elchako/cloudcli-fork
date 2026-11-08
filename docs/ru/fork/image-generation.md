---
title: "Генерация картинок в чате: устройство и ограничения"
type: fork-change
sections: [§13, §13.1, §13.2, §13.3]
tags: [картинки, generate_image, mcp, gpt-image, шлюз, профили]
description: "Встроенный generate_image через шлюз: пользовательские профили с моделью API и качеством, файлы, границы безопасности и ограничение с GPT-моделью в чате."
updated: 2026-11-09
---

# Генерация картинок в чате: устройство и ограничения

> Разделы реестра §13, §13.1, §13.2, §13.3. Часть [реестра правок форка](../fork-changes.md): номер § — постоянный адрес правки, по нему на эту страницу ссылаются код и коммиты.

Пользовательская инструкция — [`images.md`](../images.md).

## §13.1 Встроенный инструмент `generate_image`

- **Слой:** server + frontend · **Столкновение:** 🟢 (свой модуль) + 🟡 (по
  несколько строк в `claude-runtime.provider.ts`, `toolConfigs.ts`,
  `toolGrouping.ts`, `package.json`) · **PR:** кандидат после обобщения
  (сейчас завязан на OpenAI-совместимый `/v1/images` шлюза).
- **Что:** каждый Claude-ран, запущенный из CloudCLI, получает MCP-инструмент
  `mcp__cloudcli-images__generate_image`. Агент (любая модель) вызывает его по
  просьбе «нарисуй/сгенерируй/сделай иконку…»; сервер шлёт запрос в
  `/v1/images/generations` того же шлюза (`ANTHROPIC_BASE_URL` + токен из env
  или `~/.claude/settings.json`), PNG кладётся в `~/.cloudcli/assets`, а
  карточка инструмента в чате сразу показывает картинку (markdown
  `![](/api/assets/images/…)` → `MarkdownImage`, blob с JWT в заголовке).
  Правка/вариации: путь прошлой картинки или вложения передаётся в
  `input_images` → `/v1/images/edits` (проверено: «сделай тот же значок на белом
  фоне» — модель сама подставила путь прошлого результата).
- **Как устроено:** in-process MCP-сервер SDK (`createSdkMcpServer` + `tool`,
  схема на zod) — без регистрации в `~/.claude.json` и без отдельного процесса;
  создаётся на каждый ран только если шлюз настроен. `alwaysLoad`, чтобы
  инструмент не прятался за ToolSearch; предразрешён в `allowedTools` (пишет
  только в assets), запрет через `disallowedTools` по-прежнему работает. Таймаут
  запроса 5 мин (high-качество и правки идут дольше минуты). Сбой создания
  инструмента (например, несовместимый zod после обновления SDK) только убирает
  инструмент из рана и пишет warning — сам чат не падает.
- **Trust boundary:** `input_images` — только PNG/JPEG/WebP до 20 МБ из cwd рана
  или `~/.cloudcli/assets` (`isAllowedImageSourcePath`, после `realpath` — симлинк
  наружу не пройдёт). Не ослаблять.
- **UI:** строка «Image / <промпт>» (одной строкой, без переноса посреди слов) и
  раскрытая карточка «Generated image» — из текста результата берётся только
  строка с картинкой, подсказки для модели не показываются. Подряд идущие вызовы
  **не группируются** (`NEVER_GROUPED_TOOLS`), иначе «3 варианта логотипа»
  спрятались бы в свёрнутую группу. Картинки переживают перезагрузку — результат
  лежит в транскрипте, файл в assets. Проверено на 1440×900 и 390×844.
- **Настройки:** `CLOUDCLI_IMAGE_GEN=off` — выключить; `CLOUDCLI_IMAGE_MODEL` —
  модель картинок (по умолчанию `gpt-image-2.5`; шлюз также знает
  `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2`, `gpt-image-1.5`,
  `grok-imagine-image*`). Без `ANTHROPIC_BASE_URL` инструмента нет вовсе.
- **Файлы:** `server/modules/image-generation/` (новый:
  `image-generation.service.ts`, `image-generation.mcp.ts`, `index.ts`, тест
  `tests/image-generation.service.test.ts` — 11),
  `server/modules/providers/list/claude/claude-runtime.provider.ts`
  (подключение в `queryClaudeSDK`), `src/modules/chat/tools/configs/toolConfigs.ts`
  (карточка), `src/modules/chat/utils/toolGrouping.ts` (исключение из групп),
  тесты `src/modules/chat/tests/imageToolConfig.test.ts` (4) и
  `toolGrouping.test.ts` (+1), `package.json`/`package-lock.json` (`zod` —
  был peer-зависимостью SDK, теперь прямая, версия та же 4.3.6), `.env.example`.
- **Мерж:** `NEVER_GROUPED_TOOLS` и ключ карточки завязаны на имя
  `mcp__cloudcli-images__generate_image` — при переименовании сервера/инструмента
  менять в трёх местах (mcp.ts, toolConfigs.ts, toolGrouping.ts).
- **Мерж-заметка (v1.37.4).** Апстрим сам исключил из группировки `Workflow`
  (#1347) — его условие и наш `NEVER_GROUPED_TOOLS` стоят рядом в
  `isGroupableToolMessage`. Картинка в карточке теперь рисуется апстримовским
  `MarkdownImage` с нашей веткой `/api/` ([§2.1](chat-images.md)). Проверка шлюза
  (`createImageGenerationMcpServer`, чтение `~/.claude/settings.json`)
  запускается в начале рана параллельно с остальными подготовительными
  запросами, а не после них — старт рана не удлиняется.

## §13.2 Известное ограничение: с GPT-моделью в чате картинка часто теряется

- **Симптом:** чат на GPT-6 Astra/6.1 Sol на просьбу «нарисуй» отвечает пустым
  ходом (Claude CLI дописывает «Your previous response had no visible output»),
  потом «Готово.» — картинки нет, ~45 с потрачено.
- **Причина (на стороне шлюза):** CLIProxyAPI сам подмешивает в каждый
  GPT-запрос встроенный инструмент `image_generation`
  (`gpt-image-2-codex`) — видно в ответе `/v1/responses` даже без своих tools.
  GPT-6 предпочитает его нашему `generate_image` (замер на полном запросе
  Claude CLI: наш инструмент выбран в 1 из 4; явная инструкция в описании и
  системном промпте — тоже 1 из 4). Картинка генерируется, но в Anthropic-формате
  ей нет места, и шлюз её выбрасывает.
- **Что делать:** картинки просить у Claude-модели (Sonnet 5.5 / Opus 5.5 /
  Fable 5.1) — у них встроенного генератора нет, вызов стабилен. Полноценное
  исправление — в шлюзе: не подмешивать `image_generation` в запросы,
  пришедшие через `/v1/messages`, либо переводить `image_generation_call` в
  ответ. Со стороны CloudCLI не лечится.

## §13.3 Настраиваемые профили моделей изображений

- **Слой:** server + frontend · **Столкновение:** 🟢 (свои модули/экран) + 🟡
  (Settings DI/router, `claude-runtime.provider.ts`, карточка инструмента) ·
  **PR:** не отправлен, форковый API-контракт.
- **Что и зачем:** вместо вшитой единственной модели пользователь выбирает
  `draft`/`standard`/`final`: у каждого свой ID GPT Image и quality, плюс
  `defaultProfile`. Одну модель можно назначить нескольким режимам. Качество
  не выдаётся за обещание скорости/цены, Flare/Sunburst не ранжируются по имени.
- **Хранение/API:** `user_settings["image-generation"]`, без секретов,
  localStorage и двойного sync. `GET/PUT /api/settings/image-generation`
  обслуживаются под авторизацией; `GET ?refresh=1` обновляет общий API-каталог.
  Список от `claudeApiModelCatalog` ограничен поддерживаемым GPT Image;
  маски CLIProxyAPI превращаются в настоящие ID только для `/images`.
- **Исполнение:** `userId` берётся из авторизации рана, не из tool arguments.
  Профиль читается заново при каждом вызове `generate_image`; необязательный
  `profile` выбирает режим, без него — пользовательский default. Явное
  `quality` сохраняет совместимость и переопределяет качество профиля.
  Ошибка выбранной модели не запускает резерв или повышение режима.
- **Defaults:** до сохранения используется `CLOUDCLI_IMAGE_MODEL` либо
  `gpt-image-2.6`, качества low/auto/high. Указанные в §13.1 значения 2.5 —
  история первоначальной версии, заменены этим разделом. Исчезнувшие ID не
  сбрасываются, новые ID требуют наличия в каталоге. При недоступном каталоге
  сохранённый ID разрешён; при подтверждённом отсутствии — понятная ошибка.
- **Карточка:** транскрипт содержит структурированную строку `Image settings:`;
  UI валидирует её и показывает запрошенные модель/режим/качество, время и
  отдельно модель, сообщённую API (если есть). Старые результаты по-прежнему
  отображаются; внутренние подсказки и произвольный Markdown API скрыты.
- **Ключевые файлы:** `server/modules/image-generation/image-generation.config.ts`,
  `image-generation-settings.service.ts`, `image-generation.service.ts`,
  `image-generation.mcp.ts`, лёгкий публичный `providers/model-catalog.ts`
  (без ESM-цикла registry/runtime) и его точечные lint-boundaries,
  `server/modules/settings/settings.{service,module,routes}.ts`,
  `src/shared/imageGeneration.ts`, `ImageGenerationSettings.tsx`,
  `AppearanceSettingsTab.tsx`, `toolConfigs.ts`, RU/EN локализации. Рядом
  серверные тесты настроек/транспорта, клиентские тесты формы и карточки.
- **Не меняется:** `isAllowedImageSourcePath`, realpath, лимиты референсов,
  authenticated assets route и исключение инструмента из группировки.
  Nano Banana и другие протоколы/семейства пока не подключены. Известное
  ограничение hosted image tool у GPT (§13.2) этой правкой не устранено.

## Связанные страницы

- [Картинки прямо в чате](../images.md) — пользовательская инструкция
- [Картинки в markdown-чате](chat-images.md) — как картинка показывается в ленте
- [GPT через шлюз CLIProxyAPI: effort и окно контекста](gpt-gateway.md) — GPT-модели шлюза
