---
title: "Настройки пользователя в БД"
type: fork-change
sections: [§3]
tags: [настройки, user_settings, localstorage, user_preferences, синхронизация]
description: "Per-user настройки в таблице user_settings (userSettingsSync.js) для того, что апстрим держит только в localStorage: allowlist ключей, граница с user_preferences апстрима, без секретов."
updated: 2026-11-08
---

# Настройки пользователя в БД

> Раздел реестра §3. Часть [реестра правок форка](../fork-changes.md): номер § — постоянный адрес правки, по нему на эту страницу ссылаются код и коммиты.

## §3 Настройки пользователя в БД (per-user)

- **Слой:** server + frontend · **Столкновение:** 🟡/🔴 · **PR:** сильный кандидат.
- **Что:** upstream хранит UI/композер-настройки только в `localStorage` (теряются
  при чистке кэша, релогине, смене origin; не следуют за пользователем между
  устройствами). Форк зеркалит allowlist ключей `localStorage` в серверный blob
  `user_settings` (per-user): на входе — pull из БД в localStorage до чтения
  настроек приложением; на любое изменение — debounced push обратно в БД.
- **Файлы:**
  - БД: `server/modules/database/schema.ts` (таблица `user_settings`),
    `server/modules/database/repositories/user-settings.ts`.
  - API: `server/modules/settings/settings.{service,module,routes}.ts`
    (эндпоинты `GET/PUT /api/settings/user-settings`).
  - Frontend: `src/utils/userSettingsSync.js` (ядро синхро + автосинк),
    `src/components/auth/context/AuthContext.tsx` (запуск pull + автосинка),
    `src/utils/api.js` (`getUserSettings`/`updateUserSettings`).
- **Автосинк (важно):** push в БД идёт на **любое** изменение синхронизируемого
  ключа (`startUserSettingsAutoSync`: подписка на `ui-preferences:sync` + native
  `storage` + патч `localStorage.setItem`), а не только по кнопке «Сохранить».
  Guard `applyingServerSettings` гасит эхо при применении серверных настроек.
- **Что синхронизируется:** allowlist `SYNCED_SETTINGS_KEYS` в `userSettingsSync.js`
  (провайдер/модель/effort, язык, тема, `uiPreferences`, настройки редактора кода,
  режим дерева файлов, `starredProjects`, `permissionMode-*` по префиксу и др.).
- **Без секретов:** blob `user_settings` намеренно остаётся без секретов —
  репозиторий вырезает ключеподобные поля (`FORBIDDEN_KEYS`). Голосовой apiKey
  живёт в отдельной шифрованной таблице, см. [§3-бис](voice.md).
- **Мерж (v1.37.0):** upstream отрефакторил `server/routes/settings.js` в
  DI-модуль `server/modules/settings/*`; наши эндпоинты `user-settings` перенесены
  туда (service+module+routes) + тест `settings.service.test.ts`.
- **Мерж (v1.37.4): часть ключей отдана апстриму.** С 1.37.3 апстрим сам хранит
  per-user в БД тему, язык, UI-настройки, права, настройки редактора,
  выбранного провайдера и звёзды проектов (`shared/userSettings`,
  `user_preferences`), а старые localStorage-ключи читает только для разовой
  миграции. Наш sync продолжал гонять эти ключи — и при каждой загрузке
  возвращал **замороженную** копию из нашего блоба: откатывал выбранный язык
  (`i18n.changeLanguage(<старый>)` → апстрим записывал его обратно в свою БД),
  мигал темой и не знал режима «как в системе» (#1393), а `starredProjects`
  апстрим принимал за legacy-звёзды и заново ставил снятые звёзды. Теперь:
  - из `SYNCED_SETTINGS_KEYS` убраны `theme`, `userLanguage`, `uiPreferences`,
    `tasks-enabled`, `selected-provider`, `claude-settings`,
    `cursor-tools-settings`, `codex-settings`, `codeEditor*`, `starredProjects`;
  - добавлены новые localStorage-ключи 1.37.4: `sidebar-width` (ширина
    сайдбара, #1189) и `quickSettingsPanel` (док и вкладка быстрых настроек,
    #1371) — инвариант «других несинхронизируемых настроек не осталось» ([§3-бис](voice.md))
    сохранён;
  - удалены ставшие мёртвыми `applyLiveEffects` (язык/тема), событие
    `cloudcli:settings-applied` и обработчик темы в `ThemeContext.tsx` (файл
    теперь идентичен апстриму), слушатель `ui-preferences:sync` (апстрим его
    больше не шлёт), `AUTO_DEFAULT_KEYS`;
  - старые значения в уже сохранённых блобах безвредны: `applyToLocalStorage`
    пропускает всё, чего нет в allowlist.
  Проверено вживую на тестовом инстансе с засеянным «старым» блобом
  (`userLanguage: en`, `theme: dark`): язык, выбранный после этого, переживает
  перезагрузку, тема не перебивается, модель из нашего блоба подхватывается.
  **Правило на будущее:** ключ, которым владеет `shared/userSettings`, в наш
  allowlist не добавлять.

### Модели названий чатов: прямое хранение без localStorage (§4.9-тер)

Не-секретный ключ `session-title-models` (`primaryModel`, `fallbackModel`) также
хранится в `user_settings`, но через отдельный валидирующий
`GET/PUT /api/settings/session-title-models`. Это серверная настройка генератора,
а не legacy-настройка браузера: в `SYNCED_SETTINGS_KEYS` и `user_preferences`
её нет. Частичный merge сохраняет остальные ключи, другой браузер читает ту же
пару из БД. Политика каталога, резервирования и legacy — в
[§4.9-тер](session-titles.md#49-тер-независимая-основная-и-резервная-модели-названий-2026-11-08).

## Связанные страницы

- [Голосовой ввод: настройки, микрофон, диктовка](voice.md) — настройки голоса и хранение ключа (§3-бис)
- [Слияние upstream v1.37.4 (2026-10-09)](merge-v1.37.4.md) — двойная синхронизация с хранилищем апстрима (§14.3)
- [Долгая сессия входа и мигание splash](auth-session.md) — вход и токен, с которыми работает синхронизация
