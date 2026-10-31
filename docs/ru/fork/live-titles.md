---
title: "Живые названия сеанса: шапка, вкладка, push"
type: fork-change
sections: [§12.1, §12.2]
tags: [сеансы, заголовки, websocket, session_upserted, push, уведомления]
description: "Переименование сеанса сразу видно везде: fullTitle в событии session_upserted обновляет шапку открытого чата, title вкладки и подсказку, а push-уведомление берёт имя из БД в момент отправки."
updated: 2026-10-31
---

# Живые названия сеанса: шапка, вкладка, push

> Разделы реестра §12.1, §12.2. Часть [реестра правок форка](../fork-changes.md): номер § — постоянный адрес правки, по нему на эту страницу ссылаются код и коммиты.

## §12.1 Заголовок открытого чата и tooltip обновляются в момент переименования

- **Слой:** server + frontend · **Столкновение:** 🟡 (общий wire-формат
  `session_upserted` и обработчик в `useProjectsState`) · **PR:** кандидат.
- **Симптом:** ИИ-переименование обновляло только строку в сайдбаре. Заголовок
  **открытого** чата (шапка + title вкладки браузера) менялся лишь после
  перезагрузки страницы или ухода в другой чат и обратно, а tooltip на
  десктопе показывал только короткую тему без исходного запроса — до ручной
  регенерации, которая возвращала `fullTitle` в REST-ответе.
- **Причина:** событие `session_upserted` не несло `fullTitle`, обработчик на
  клиенте трогал `selectedSession` только при смене алиаса
  (provider-id → app-id), а `scheduleTitle` в синхронизаторе писал заголовок в
  БД молча — live-обновление сайдбара случайно работало лишь потому, что ран
  продолжал писать транскрипт и watcher слал очередной дельта-апдейт.
- **Решение:** (1) `SessionUpsertedEvent.session` дополнен полем
  `fullTitle` (string|null — истина БД, включая явный null после ручного
  rename); (2) `scheduleTitle`, `renameSessionById` и
  `regenerateSessionTitleById` сразу рассылают `broadcastSessionUpserted` —
  второй клиент (телефон/десктоп) видит смену имени мгновенно;
  (3) обработчик в `useProjectsState` точечно мержит `summary`/`fullTitle`/
  `lastActivity` в `selectedSession` по совпадению любого из alias-id —
  спред всего payload'а нарочно не используем: он бы затирал живой
  `messageCount` нулём из события. Пустой `summary` в событии заголовок не
  обнуляет (та же защита, что в сайдбаре); отсутствующий ключ `fullTitle`
  (оптимистичная регистрация) не затирает известное значение, а явный null
  затирает — это правда после ручного rename.
- **Ловушка при реализации:** статический импорт broadcast-сервиса из
  синхронизатора замкнул цикл модулей (synchronizer → broadcast → projects →
  provider registry → synchronizer) и уронил инициализацию провайдеров
  (TDZ, `Cannot access 'ClaudeSessionSynchronizer' before initialization`) —
  поймано тестом архивации, лечится ленивым `await import()` внутри
  `scheduleTitle` с поясняющим комментарием.
- **Файлы:** `server/shared/types.ts`,
  `server/modules/websocket/services/session-upsert-broadcast.service.ts`,
  `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts`,
  `server/modules/providers/services/sessions.service.ts`,
  `src/modules/project-workspace/hooks/useProjectsState.ts`; тест
  `src/modules/project-workspace/tests/projectsStateSelectedTitle.test.ts` (3).

## §12.2 Push-уведомление называет сессию актуальным именем

- **Слой:** server · **Столкновение:** 🟡 (общий файл уведомлений) ·
  **PR:** кандидат.
- **Симптом:** пуш о завершении рана приходил со старым названием сессии
  (сырым обрезком первого запроса), хотя ИИ-заголовок уже сгенерирован.
- **Причина:** `resolveSessionName` в оркестраторе уведомлений безоговорочно
  предпочитал `meta.sessionName` — снапшот имени на момент **старта** рана,
  а переименование происходит в его середине.
- **Решение:** порядок развёрнут — сначала `custom_name` из БД на момент
  отправки (свежий), `meta.sessionName` остаётся фолбэком для сессий без
  строки в индексе. Сработало для всех кодов уведомлений разом
  (`run.stopped`, `run.background_completed`, `run.failed`, permission).
- **Файлы:**
  `server/modules/notifications/services/notification-orchestrator.service.js`.

## Связанные страницы

- [Сеансы: выделение активного и ИИ-названия](session-titles.md) — откуда берётся название
- [Мобильная шапка в одну строку](mobile-header.md) — заголовок чата в мобильной шапке
- [Пины чатов и живая вкладка «Разговоры»](pins.md) — то же событие обновляет список «Разговоров»
