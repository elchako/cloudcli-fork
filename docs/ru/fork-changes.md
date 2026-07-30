# Реестр правок форка — чем наша версия отличается от оригинала

> **Назначение.** Единый список всех отличий форка холдинга GOLDJAXE от upstream
> `siteboon/claudecodeui`. Ведётся, чтобы при обновлении оригинала **без
> расследования** понять, что и где мы меняли: как сливать конфликты и какие
> фичи предлагать к вливанию в upstream (PR).
>
> **Правило актуальности.** Любое изменение кода форка → строка/секция здесь **в
> том же коммите**. Это обязательное правило (`../../CLAUDE.md`, раздел «Важно при
> работе с кодом»). Устарел реестр — сломан весь смысл форка.

Форк-ветка: `feat/goldjaxe-improvements`. Upstream-remote: `origin =
github.com/siteboon/claudecodeui`. База последнего слияния — **upstream v1.37.0**
(коммит `264e094`).

---

## Как читать таблицу

- **Слой** — где живёт правка (frontend / server / модель / инфра / UI).
- **Файлы** — ключевые точки, куда смотреть при мерже.
- **Столкновение с upstream** — насколько правка рискует конфликтовать при
  обновлении оригинала: 🟢 изолирована (свой файл/своя строка) · 🟡 правит общий
  upstream-файл (следить при мерже) · 🔴 глубоко переплетена с ядром.
- **PR в upstream** — предлагали/стоит ли предлагать к вливанию в оригинал.

---

## 1. Модели Claude

### 1.1 Kimi K3 (1M контекст)
- **Слой:** модель · **Столкновение:** 🟡 · **PR:** нет (специфично для холдинга).
- **Что:** добавлена модель `kimi-k3[1m]` (Moonshot) в список моделей Claude.
  Когда выбрана `kimi-*` и задан `ANTHROPIC_AUTH_TOKEN`, но нет
  `ANTHROPIC_BASE_URL` — endpoint `https://api.moonshot.ai/anthropic`
  подставляется автоматически.
- **Файлы:** `server/modules/providers/list/claude/claude-models.provider.ts`
  (запись в `CLAUDE_FALLBACK_MODELS`), `.../claude-runtime.provider.js`
  (хук env в `mapCliOptionsToSDK`), `.env.example` (переменные Kimi).
- **Почему форк, не плагин:** список моделей захардкожен в ядре
  (`getSupportedModels()` отключён upstream), плагином не расширить.

### 1.2 Opus 5 в списке моделей
- **Слой:** модель · **Столкновение:** 🟡 · **PR:** нет.
- **Что:** `claude-opus-5` и `claude-opus-5[1m]` добавлены выше Opus 4.8; старый
  label `Opus` переименован в `Opus 4.8`.
- **Файлы:** `server/modules/providers/list/claude/claude-models.provider.ts`.
- **Мерж:** обе модельные правки живут в одном массиве `CLAUDE_FALLBACK_MODELS` —
  при обновлении upstream сверять этот массив целиком.

---

## 2. Чат и вложения

### 2.1 Нативный показ картинок в markdown-чате
- **Слой:** frontend · **Столкновение:** 🟢 · **PR:** кандидат.
- **Что:** markdown `![](/api/assets/...)` рендерится через `MarkdownImage` —
  blob-загрузка защищённых путей с JWT в заголовке (не в DOM/URL).
- **Файлы:** `src/components/chat/view/subcomponents/MarkdownImage.tsx`,
  `Markdown.tsx` (override `img`).

### 2.2 Прикрепление любых файлов (не только картинок)
- **Слой:** frontend + server · **Столкновение:** 🟡 · **PR:** кандидат.
- **Что:** к сообщению можно прикрепить любой файл; не-картинки доходят до агента
  как читаемый путь (блок `<files_input>`), а не base64. Проверка типа и лимита
  (20 МБ / 5 файлов) с уведомлением о превышении.
- **Файлы:** `src/components/chat/utils/attachmentSupport.ts`,
  `src/components/chat/hooks/useChatComposerState.ts`,
  `server/shared/image-attachments.ts`,
  `server/modules/assets/services/image-assets.service.ts`,
  `server/modules/assets/assets.routes.ts` (форс-download не-картинок).
- **Trust boundary:** файл доходит до агента только если лежит в
  `~/.cloudcli/assets` или в cwd рана (`isAllowedImageSourcePath`). Не ослаблять.
- **Мерж-заметка (v1.37.0):** upstream ввёл свой `ComposerAttachment` (картинки +
  файловые плашки + зум/lightbox) — он поглотил наш прежний `ImageAttachment.tsx`
  (удалён). Наша логика допуска/лимита осталась в `useChatComposerState`.

### 2.3 Мобильный переключатель уровня рассуждений (effort)
- **Слой:** frontend · **Столкновение:** 🟢 (снят) · **PR:** решено upstream.
- **Статус:** наш инлайн-фикс **удалён при мерже v1.37.0** как дубль. Upstream
  вынес меню в `ComposerModelMenu`/`ComposerPermissionMenu`, а тач-баг выбора
  решён в `useComposerMenuAnchor` (`menuRef.contains`). Оставлено как история —
  если upstream снова сломает тач-выбор в портал-меню, смотреть сюда.

---

## 3. Настройки пользователя в БД (per-user)

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
- **Без секретов:** голосовой apiKey (`voiceConfig`) **не** синхронизируется —
  at-rest шифрования в серверном хранилище НЕТ, ключ остаётся device-local.
- **Мерж (v1.37.0):** upstream отрефакторил `server/routes/settings.js` в
  DI-модуль `server/modules/settings/*`; наши эндпоинты `user-settings` перенесены
  туда (service+module+routes) + тест `settings.service.test.ts`.

---

## 4. UI / мобильная версия

### 4.1 Убраны кнопки «Сообщить о проблеме» и «Присоединиться к сообществу»
- **Слой:** UI · **Столкновение:** 🟡 · **PR:** нет (наше решение).
- **Что:** удалены из сайдбара (footer развёрнутый/мобильный + свёрнутые иконки).
- **Файлы:** `src/components/sidebar/view/subcomponents/SidebarFooter.tsx`,
  `SidebarCollapsed.tsx`. Discord-ссылки на вкладках «О программе»/«Версия»
  оставлены (спрятаны в настройках, не мешают).

### 4.2 Кнопка меню в шапке не сливается с лентой вкладок (мобила)
- **Слой:** UI · **Столкновение:** 🟡 · **PR:** кандидат.
- **Что:** на узком экране лента вкладок/плагинов подъезжала вплотную к
  кнопке-гамбургеру. Кнопка вынесена в отдельную нескрываемую зону с вертикальным
  разделителем и отступом справа.
- **Файлы:** `src/components/main-content/view/subcomponents/MainContentHeader.tsx`.

### 4.3 Убрана справочная подсказка в футере композера
- **Слой:** UI · **Столкновение:** 🟡 · **PR:** нет (наше решение).
- **Что:** справочный текст в правой части футера чата (`submitHint`:
  «Ctrl/Shift+Enter • Tab для смены режима • / для команд») наезжал на левые
  иконки (скрепка, микрофон, индикатор токенов, команды) при недостатке ширины.
  Подсказка удалена — сочетания клавиш продолжают работать без неё. Убран также
  ставший ненужным проп `sendByCtrlEnter` у `ChatComposer` (логика отправки
  осталась в `useChatComposerState`, куда проп идёт отдельно).
- **Файлы:** `src/components/chat/view/subcomponents/ChatComposer.tsx`,
  `src/components/chat/view/ChatInterface.tsx`. i18n-ключи `input.hintText.*`
  в `src/i18n/locales/*/chat.json` оставлены (не мешают).

### 4.4 Микрофон скрыт вне защищённого контекста (HTTPS/localhost)
- **Слой:** frontend · **Столкновение:** 🟢 · **PR:** кандидат (баг апстрима).
- **Симптом:** на телефоне по `http://100.64.0.27:3302` тап по микрофону падал с
  `Cannot read properties of undefined (reading 'getUserMedia')`.
- **Причина:** `navigator.mediaDevices` браузер отдаёт только в **secure context**
  (HTTPS либо localhost). Plain HTTP на Tailscale/LAN-IP таковым не является, и
  `navigator.mediaDevices` там `undefined`. Замер headless-Chrome по CDP на самом
  origin: `{origin:"http://100.64.0.27:3301", secure:false, md:"undefined",
  gum:"undefined"}`.
- **Апстрим болен тем же.** Проверено сравнением: `useVoiceInput.ts`,
  `useVoiceAvailable.ts`, `VoiceInputButton.tsx` и гейт в `ChatComposer.tsx`
  (строки 202/392) на момент v1.37.0 (`264e094`) **идентичны** нашим — гейт
  `useVoiceAvailable` апстримовский, не наш. Кнопка показывается по `voiceEnabled`
  + доступности бэкенда, **без** проверки самого API захвата.
- **Грабли диагностики:** «на 3301 микрофон есть, значит дело в форке» — ложный
  вывод. На 3301 крутится npm-пакет `@cloudcli-ai/cloudcli` **той же версии
  1.37.0** с той же строкой `mediaDevices.getUserMedia({audio:{echoCancellation:!0,
  noiseSuppression:!0}})`. Кнопка там видна, но нерабочая — по тапу та же ошибка.
  **Наличие иконки ≠ работающий микрофон.** Сравнивать инстансы нужно замером
  `isSecureContext`/`mediaDevices` на origin, а не наличием кнопки в UI.
- **Фикс:** (1) `useVoiceAvailable` дополнительно гейтит показ на `canCaptureMic()`
  (`typeof navigator.mediaDevices?.getUserMedia === 'function'`) — нет API захвата →
  кнопки нет (не ложное обещание). (2) `useVoiceInput.start` — fail-fast с понятным
  текстом «Microphone needs a secure connection (HTTPS or localhost).», если запись
  всё же запустят иным путём (напр. главной Send-кнопкой).
- **Файлы:** `src/components/chat/hooks/useVoiceAvailable.ts`,
  `src/components/chat/hooks/useVoiceInput.ts`.
- **Как включить голос на телефоне:** см. `deploy.md` → «Голосовой ввод с телефона».
  Рабочее решение холдинга — Chrome-флаг *Insecure origins treated as secure*
  (Tailscale Serve **не подходит**: у нас Headscale, сертификаты не выдаёт).

---

## 5. Инфраструктура и деплой

- **Локальный автозапуск:** сервис systemd `cloudcli-fork.service` (user-scope)
  на ноуте `mx-linux`, порт **3302**, автостарт при входе в систему. См.
  `docs/ru/deploy.md`.
- **Порты/БД:** форк — `SERVER_PORT=3302`; рабочий инстанс Артёма — 3301 (не
  трогать). БД по умолчанию `~/.cloudcli/auth.db` (общая; при необходимости
  изоляции — свой `DATABASE_PATH`).
- **Доступ:** с телефона по Tailscale (`http://100.64.0.27:3302`).

---

## Регламент ведения (коротко)

1. Изменил код → допиши/поправь секцию здесь **тем же коммитом**.
2. Новая крупная фича → отдельная секция + строка в
   `../../GOLDJAXE-FORK.md` (roadmap) и `../../CLAUDE.md` («Наши доработки»).
3. Правка снята/поглощена upstream при мерже → не удаляй молча: поменяй статус
   (как в 2.3), чтобы история слияний оставалась прослеживаемой.
4. Проставляй «Столкновение с upstream» и «PR» — это то, ради чего реестр и нужен.
