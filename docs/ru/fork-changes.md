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
github.com/siteboon/claudecodeui`. База последнего слияния — **upstream v1.37.2**
(коммит `677b7ba`).

> **Известный дефект апстрима (не наш).** Тест `conversation search streams title
> matches before transcript results` (`server/modules/providers/tests/provider.routes.test.ts`)
> падает и на чистом `v1.37.2` — проверено отдельным worktree на теге без наших
> правок. Не чинить под видом регрессии слияния; кандидат в issue апстриму.

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
- **Мерж-заметка (v1.37.2):** конфликт в `markdownComponents` — наш override
  `img` соседствовал с нашим же простым `pre`. Upstream переписал `pre` (ищет
  дочерний `CodeBlock` и рендерит его с `forceBlock`, т.к. react-markdown v9+
  больше не передаёт флаг `inline`). Взят апстримовский `pre` + наш `img`:
  наш `pre` был обычным passthrough и апстримовский его строго перекрывает.

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
- **Без секретов:** blob `user_settings` намеренно остаётся без секретов —
  репозиторий вырезает ключеподобные поля (`FORBIDDEN_KEYS`). Голосовой apiKey
  живёт в отдельной шифрованной таблице, см. §3-бис.
- **Мерж (v1.37.0):** upstream отрефакторил `server/routes/settings.js` в
  DI-модуль `server/modules/settings/*`; наши эндпоинты `user-settings` перенесены
  туда (service+module+routes) + тест `settings.service.test.ts`.

---

## 3-бис. Настройки голоса в БД + шифрование секретов (AES-256-GCM)

- **Слой:** server + frontend + БД · **Столкновение:** 🟡 · **PR:** кандидат
  (шифрование — сильный кандидат, апстриму его не хватает как примитива).
- **Симптом:** настройки Voice (STT/TTS) — URL, apiKey, модели, голос, формат —
  жили **только** в `localStorage`. Чистка кэша браузера стирала всю настройку,
  на новом устройстве всё вводилось заново.
- **Почему не решалось прежним механизмом:** §3 синхронизирует allowlist
  localStorage → `user_settings`, но `voiceConfig` туда сознательно не включали:
  в blob нельзя класть секреты, а **шифрования в проекте не было вообще**
  (`createCipheriv` не встречался ни разу). Таблица `user_credentials` тоже
  хранит значения открытым текстом — комментарий в схеме про «секреты живут
  здесь» описывал намерение, а не реальность (исправлен).
- **Что сделано:**
  1. **Примитив шифрования** — `server/shared/secret-box.ts`: AES-256-GCM,
     конверт `gcm.v1.<base64(iv|tag|ciphertext)>`. Мастер-ключ берётся из
     `CLOUDCLI_SECRET_KEY` (32 байта base64/hex) либо генерируется в
     `<каталог БД>/secret.key` с правами **0600**. Ключ лежит рядом с `auth.db`
     намеренно: шифротекст и ключ обязаны переезжать вместе, иначе смена
     `DATABASE_PATH` тихо осиротит все секреты.
  2. **Таблица `voice_settings`** (per-user) — `voice-settings.ts`. Поля
     `base_url/stt_model/tts_model/tts_voice/tts_format` открыто,
     `api_key_encrypted` — конверт. Обновление частичное и атомарное
     (транзакция): сохранение одного поля не стирает ключ.
  3. **API** — `GET/PUT /api/settings/voice-settings`. По умолчанию ответ несёт
     только `hasApiKey`; сырой ключ отдаётся **лишь** по явному
     `?revealApiKey=true`.
  4. **Клиент** — `useVoiceConfig` переписан на серверное хранилище с memory-кэшем
     (его читает `voiceApi` синхронно при сборке запроса), одноразовой миграцией
     старого `localStorage`-блоба наверх и сбросом кэша на выходе из аккаунта.
- **Граничный случай, определивший конструкцию:** когда задан свой `baseUrl`,
  браузер ходит в бэкенд голоса **напрямую** — серверный прокси намеренно
  игнорирует клиентские URL, чтобы не стать SSRF-плечом
  (`voice.module.ts`: «frontend-configured custom backends are called by the
  browser»). Поэтому для прямых вызовов ключ всё же нужен в браузере: он
  подтягивается лениво через `revealVoiceApiKey()` и живёт **только в памяти**,
  обратно в `localStorage` не пишется. На прокси-пути ключ не отправляется
  вовсе — сервер сам подставляет сохранённый (`parseVoiceOverrides`:
  заголовки в приоритете, БД — запасной вариант).
- **Модель угроз (честно):** защищает файл БД, а не хост. У кого доступ к
  `~/.cloudcli/`, у того и ключ, и база. Смысл в том, что apiKey перестал лежать
  открытым текстом в файле, который попадает в бэкапы, синхронизируется между
  машинами и передаётся при разборе проблем с БД.
- **Файлы:** `server/shared/secret-box.ts` (новый),
  `server/shared/tests/secret-box.test.ts` (новый, 8 тестов),
  `server/modules/database/repositories/voice-settings.ts` (новый),
  `server/modules/database/repositories/tests/voice-settings.test.ts` (новый,
  7 тестов на настоящей БД), `server/modules/database/{schema,migrations,index}.ts`,
  `server/modules/settings/settings.{service,module,routes}.ts`,
  `server/modules/voice/voice.{routes,module}.ts`,
  `src/hooks/useVoiceConfig.ts`, `src/lib/voiceApi.ts`, `src/utils/api.js`,
  `src/utils/userSettingsSync.js`, `src/components/auth/context/AuthContext.tsx`,
  `src/components/settings/view/tabs/VoiceSettingsTab.tsx`,
  `src/i18n/locales/en/settings.json`, `eslint.config.js` (secret-box в
  allowlist `backend-shared-utils` — иначе `boundaries/no-unknown`).
- **Заодно синхронизируются:** `quickSettingsHandlePosition` (позиция плавающей
  ручки) и `CLOUDCLI_HIDE_GITHUB_STAR` (скрытая плашка GitHub) — раньше
  терялись при чистке кэша. Полная сверка ключей `localStorage` показала, что
  других несинхронизируемых настроек не осталось.
- **Проверка:** 20/20 новых тестов, включая замер, что в колонке БД **нет**
  подстроки исходного ключа, а подделанный шифротекст не открывается.

---

## 4. UI / мобильная версия

### 4.1 Убраны кнопки «Сообщить о проблеме» и «Присоединиться к сообществу»
- **Слой:** UI · **Столкновение:** 🟡 · **PR:** нет (наше решение).
- **Что:** удалены из сайдбара (footer развёрнутый/мобильный + свёрнутые иконки).
- **Файлы:** `src/components/sidebar/view/subcomponents/SidebarFooter.tsx`,
  `SidebarCollapsed.tsx`. Discord-ссылки на вкладках «О программе»/«Версия»
  оставлены (спрятаны в настройках, не мешают).

### 4.1-бис Низ сайдбара — одна строка вместо стопки полос
- **Слой:** UI · **Столкновение:** 🟡 · **PR:** кандидат.
- **Симптом:** низ сайдбара занимал до четырёх полноширинных полос (баннер
  «нужен перезапуск», баннер обновления, «Настройки», брендовая строка с
  версией) — каждая со своими отступами и разделителем. На телефоне это
  съедало заметный кусок ленты сеансов ради сведений, которые почти всегда
  простаивают: «доступно обновление» — это напоминание «когда-нибудь», а не
  задача на сейчас.
- **Что сделано:** всё свёрнуто в **одну строку**: слева «Настройки»
  (растягивается), справа — компактные значки состояния. Плашка обновления
  стала значком-стрелкой с пульсирующей точкой, текст ушёл в подсказку
  (десктоп) и в модалку, которую значок и открывает — там пользователь всё
  равно совершает действие. Значок «нужен перезапуск» (янтарный) стоит перед
  значком обновления как более срочный. Версия+ссылка на проект — только
  десктоп (это справка, а не действие).
- **Ничего не удалено** — уменьшен только размер в покое.
- **Замер в браузере** (реальная таблица стилей сборки, ширина 390px):
  высота низа **126px → 57px** (−69px, −55%); десктоп — **41px**. Тач-цели
  остались **44×44** на мобиле (32×32 на десктопе, где указатель точный):
  компактность не куплена ценой попадания пальцем.
- **Файлы:** `src/components/sidebar/view/subcomponents/SidebarFooter.tsx`.

### 4.2 Кнопка меню в шапке не сливается с лентой вкладок (мобила)
- **Слой:** UI · **Столкновение:** 🟢 (снят) · **PR:** решено upstream.
- **Что было:** на узком экране лента вкладок/плагинов подъезжала вплотную к
  кнопке-гамбургеру. Кнопка выносилась в отдельную зону с вертикальным
  разделителем и отступом справа.
- **Статус:** наша правка **снята при мерже v1.37.2** — upstream переработал шапку
  структурно (`MainContentHeader.tsx`): на мобиле заголовок и лента вкладок теперь
  в разных строках (`flex-col` → `sm:flex-row`), плюс появились кнопки прокрутки
  вкладок и градиенты по краям. Слипнуться кнопке с лентой больше негде, наш
  разделитель стал лишним. Оставлено как история — если upstream вернёт
  однострочную раскладку, смотреть сюда.
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

### 4.5 Картинки из чата открываются как картинки, а не в текстовом редакторе
- **Слой:** frontend + server · **Столкновение:** 🟡 · **PR:** кандидат.
- **Симптом:** клик по ссылке на `.png` в рассуждениях агента открывал панель
  редактора с плашкой «Unable to display this file.» и путём под ней. Текстовые
  файлы при этом открывались нормально.
- **Причина (не та, что кажется):** ветка «файл — изображение → `<img>`» в
  апстриме **уже есть** (`CodeEditor.tsx:198`, `getPreviewKind`), и `.png`
  распознаётся верно. Ломалась **доставка байтов**: превью грузит файл только
  через `/api/file-tree/projects/:id/files/content`, а тот зовёт
  `resolvePathInsideProject` (`file-tree.service.ts:72-83`) → всё вне корня
  проекта отбивается **403 PATH_OUTSIDE_PROJECT**. Скриншоты агента лежат в
  `/tmp/...`, то есть вне любого проекта.
- **Почему «текст работал»:** открывавшиеся текстовые файлы были **внутри**
  проекта. Ограничение общее — `readTextFile` (:353) и `openFile` (:367) зовут
  одну и ту же проверку. Текст из `/tmp` упал бы так же. Дело не в типе файла.
- **Фикс (сервер):** новый роут `GET /api/assets/local-media?path=<abs>` +
  сервис `local-media.service.ts`. Отдаёт файл по абсолютному пути **только**
  если: (1) путь внутри allowlist-каталогов, (2) расширение — медиа, которое
  браузер рендерит сам. Проверено: `/etc/passwd`, обход через `..`, `~/.ssh/*`
  и симлинк из `/tmp` наружу → `forbidden`; `realpath` до проверки границы
  закрывает побег по симлинку. Заголовки как у stored-assets: `nosniff`,
  форс-download для SVG.
- **Allowlist:** по умолчанию `os.tmpdir()`, `~/Downloads`, `~/.cloudcli`.
  Переопределяется `CLOUDCLI_MEDIA_DIRS` (разделитель — как в `PATH`).
- **Фикс (клиент):** (1) `CodeEditorMediaPreview` пробует цепочку источников —
  проектный роут, затем `local-media` для абсолютных путей. (2) Клик по ссылке
  на картинку в чате открывает **lightbox поверх ленты**
  (`FilePathLightbox` → переиспользует апстримовский `ImageLightbox`), а не
  панель редактора: редактор рассчитан на текст и на телефоне занимает весь
  экран. Не-картинки открываются в редакторе как раньше.
- **Файлы:** `server/modules/assets/services/local-media.service.ts` (новый),
  `server/modules/assets/assets.routes.ts`,
  `src/components/chat/view/subcomponents/FilePathLightbox.tsx` (новый),
  `src/components/chat/view/subcomponents/Markdown.tsx`,
  `src/components/code-editor/view/subcomponents/CodeEditorMediaPreview.tsx`.
- **Мерж-заметка:** роут добавлен в конец `assets.routes.ts` (монтируется под
  `authenticateToken`, `server/index.ts:159`) — при обновлении upstream следить
  за этим файлом и за сигнатурой `getPreviewKind`.

### 4.6 Активный сеанс выделен явно + короткие ИИ-названия сеансов
- **Слой:** frontend + backend + БД · **Столкновение:** 🔴 · **PR:** кандидат
  (выделение — баг апстрима; ИИ-названия — наша фича, отдельным PR).
- **Симптом:** (1) выбранный сеанс отличался только `bg-primary/5` +
  `border-primary/20` — в тёмной теме неразличимо, непонятно какой сеанс открыт;
  (2) названием сеанса служил сырой первый запрос (`display` из
  `~/.claude/history.jsonl`), обрезанный по ширине строки, поэтому десяток
  сеансов подряд читался одинаково («Review this change for security…»).
- **Что сделано:**
  - **Выделение:** акцентная полоса 4px (`::before`), фон `bg-primary/15`,
    сплошная рамка + `ring-primary/40`, `font-semibold` у заголовка,
    `aria-current`. Обе ветки — десктопная и мобильная.
  - **Названия:** новый сервис `session-title.service.ts` сокращает первый
    запрос до «\<предмет\> — \<действие\>» (≤48 симв., первые два слова —
    проект/домен/файл/номер задачи, язык запроса сохраняется). Модель берётся из
    `ANTHROPIC_DEFAULT_HAIKU_MODEL`, доступ — по тем же `ANTHROPIC_BASE_URL` /
    `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`, что и Claude Code.
  - **Подсказка:** полный исходный запрос хранится в новой колонке
    `sessions.full_title` и показывается в `title` при наведении.
  - **Перегенерация вручную:** кнопка-искра в строке сеанса (десктоп + мобила) →
    `POST /api/providers/sessions/:id/regenerate-title`. Индексация никогда не
    переписывает уже существующее имя, поэтому старые сеансы обновляются только
    этой кнопкой.
- **Отказоустойчивость (важно):** ни один сбой не оставляет сеанс без имени —
  при отсутствии ключей, ошибке шлюза, таймауте или ответе не в формате
  возвращается прежнее поведение (обрезанный сырой запрос). Отключается
  `CLOUDCLI_SESSION_TITLES=off`, модель переопределяется
  `CLOUDCLI_SESSION_TITLE_MODEL`.
- **Грабли, пойманные на живом стенде:**
  1. Шлюз холдинга (CLIProxyAPI) отвечает `400 clear_thinking_20251015 strategy
     requires thinking to be enabled` на обычный запрос → сервис делает один
     повтор с `thinking: {type:'enabled'}` (`max_tokens` > `budget_tokens`,
     `temperature` при этом слать нельзя).
  2. Первая индексация шлёт запрос на сеанс — при 121 сеансе шлюз рвал
     соединения (`fetch failed`) → запросы поставлены в последовательную очередь.
  3. Генерация не должна быть внутри синхронизации: `/api/projects` ждёт
     `synchronizeSessions()`, и ожидание сети там вешало список проектов
     (>2 мин). Теперь строка пишется с сырым именем сразу, а заголовок
     дописывается фоном (`scheduleTitle`) с проверкой, что имя не изменилось.
- **Файлы:** `server/modules/providers/services/session-title.service.ts` (новый),
  `server/modules/providers/tests/session-title.service.test.ts` (новый, 14 тестов),
  `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts`,
  `server/modules/providers/services/sessions.service.ts`,
  `server/modules/providers/provider.routes.ts`,
  `server/modules/database/{schema,migrations}.ts`,
  `server/modules/database/repositories/sessions.db.ts`,
  `server/modules/projects/services/projects-with-sessions-fetch.service.ts`,
  `src/components/sidebar/**` (5 файлов: строка сеанса, список, проект, панель,
  контроллер), `src/utils/api.js`, `src/i18n/locales/{ru,en}/sidebar.json`.
- **Мерж-заметка:** колонка `full_title` добавляется миграцией
  `addSessionFullTitleColumn` (по образцу `addSessionModelColumn`) — при
  обновлении upstream следить за `migrations.ts` и за `SESSION_ROW_COLUMNS`.
  Переименование вручную (`renameSessionById`) теперь чистит `full_title`, иначе
  подсказка показывала бы устаревший текст.
- **Мерж-заметка (v1.37.2):** upstream добавил свою колонку `effort` той же
  миграционной механикой — в `migrations.ts` теперь **обе** функции
  (`addSessionFullTitleColumn` + `addSessionEffortColumn`), в
  `SESSION_ROW_COLUMNS` — **оба** поля. Конфликт был вида «обе стороны добавили
  своё в одну точку»: брать одну сторону нельзя, иначе тихо теряется колонка.
- **Мерж-заметка (v1.37.2) — строка сеанса переехала в меню.** Upstream заменил
  инлайн-кнопки в `SidebarSessionItem.tsx` на `ActionMenu` («три точки» +
  нижняя шторка на мобиле). Наша кнопка-искра больше не инлайн: она стала
  пунктом меню `regenerate-title` (иконка `Sparkles`, `loading:
  isRegeneratingTitle`) рядом с `rename`/`copy`/`delete`. Наше выделение
  активного сеанса (акцентная полоса, `ring`, `font-semibold`) сохранено и
  дополнено апстримовским `pr-11`, чтобы текст строки не заезжал под меню.

### 4.7 Автозаголовок срабатывает и для новых сеансов (гонка индексации)
- **Слой:** backend · **Столкновение:** 🟡 · **PR:** вместе с 4.6.
- **Симптом:** у сеансов из истории заголовок появлялся, а у **новых** — нет:
  название оставалось сырым первым запросом. Кнопка перегенерации при этом
  работала, то есть сам сервис был исправен.
- **Причина — гонка.** Активный сеанс переиндексируется на *каждую* запись в
  файл беседы. Первый проход ставил фоновую генерацию (2–4 с), но следующая
  запись приходила раньше ответа модели, и на втором проходе срабатывал ранний
  выход «имя уже есть» (`custom_name` != пусто) — `rawPrompt` больше не
  возвращался, второго шанса не было никогда. У старых сеансов из истории
  повторной индексации нет, поэтому там всё работало.
- **Фикс:** признаком «уже озаглавлен» стал непустой `full_title`, а не сам факт
  наличия имени. Пока `full_title` пуст, имя считается сырым и генерация
  повторяется на следующем проходе. Чтобы это не превратилось в запрос на каждое
  нажатие клавиши, добавлен `titlesInFlight` — один активный запрос на сеанс.
  `scheduleTitle` перед записью перечитывает строку и пишет, только если имя
  всё ещё равно исходному запросу и `full_title` пуст → ручное переименование
  никогда не затирается.
- **Источник текста:** приоритет у `history.jsonl` (`buildLookupMap` берёт
  **первую** запись = первый запрос сеанса), сохранённое имя — запасной вариант,
  т.к. оно уже обрезано до 120 символов. Важно: `extractSessionAiTitleFromEnd`
  читает файл с конца и даёт *последний* запрос — на него опираться нельзя,
  иначе сеанс назовётся «да, спасибо!».
- **Файлы:** `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts`,
  `server/modules/providers/tests/claude-session-titles.test.ts` (новый, 4 теста
  на настоящей БД + подменённый шлюз; тест «повторная индексация» падает на
  коде до фикса — проверено).

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

## 6. Документация

- **Слой:** доки · **Столкновение:** 🟡 · **PR:** нет.
- **Мерж-заметка (v1.37.2):** upstream перенёс корневой `README.md` (и его
  переводы) в `docs/`, столкнувшись с нашим оглавлением доков форка. Конфликт
  «добавление/добавление» разведён так: `docs/README.md` — **наше** оглавление
  каталога доков, апстримовский README лёг в `docs/upstream/README.md` (там же,
  где зеркало остальной их документации). При следующем обновлении upstream
  ждать конфликта ровно в этой точке и разводить так же.

---

## Регламент ведения (коротко)

1. Изменил код → допиши/поправь секцию здесь **тем же коммитом**.
2. Новая крупная фича → отдельная секция + строка в
   `../../GOLDJAXE-FORK.md` (roadmap) и `../../CLAUDE.md` («Наши доработки»).
3. Правка снята/поглощена upstream при мерже → не удаляй молча: поменяй статус
   (как в 2.3), чтобы история слияний оставалась прослеживаемой.
4. Проставляй «Столкновение с upstream» и «PR» — это то, ради чего реестр и нужен.
