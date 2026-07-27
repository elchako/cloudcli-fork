# Документация CloudCLI (форк GOLDJAXE)

> Рабочая документация форка. Официальную (upstream) документацию забрали в
> `docs/upstream/` как основу — дальше переводим на русский и дополняем в
> `docs/ru/`. Источник истины — код; доки описывают то, что реально есть.

## Как устроен этот каталог

| Папка | Что это | Язык | Статус |
|---|---|---|---|
| `upstream/` | Зеркало официальной документации CloudCLI (`cloudcli.ai/docs`) на момент забора. База для перевода. **Не редактировать смыслово** — правки идут в `ru/`. | EN | забрано (см. ниже) |
| `ru/` | Наш перевод + дополнения под форк холдинга. Растёт по мере доработки. | RU | в работе |
| корень репо | `../CLAUDE.md` (правила для ИИ), `../GOLDJAXE-FORK.md` (о форке), `../README*.md` (витрина, 8 языков) | RU/EN | есть |

## Карта официальной документации (`upstream/`)

Забрано с `https://cloudcli.ai/docs`. У апстрима нет структурированной doc-папки
в репозитории — полная документация живёт на сайте; мы сняли её сюда.

- **Установка** — `upstream/installation/`
  - `00-overview` · `01-prerequisites` · `02-quick-start-npx` ·
    `03-global-installation` · `04-local-development-setup` · `05-remote-server`
- **Конфигурация** — `upstream/configuration/`
  - `01-tools-and-permissions` · `02-environment-variables`
- **Возможности** — `upstream/features/`
  - `browser-use` · `chat-interface` · `file-explorer` · `git-explorer` ·
    `session-management` · `mobile-app`
- **MCP-серверы** — `upstream/mcp-servers/`
  - `00-overview` · `01-remote-http` · `02-stdio` · `03-cloudcli-as-mcp-server`
- **Плагины** — `upstream/plugins/`
  - `00-overview` · `01-getting-started` · `02-manifest-reference` ·
    `03-frontend-api` · `04-backend-servers` · `05-security-model` ·
    `06-example-project-stats`
- **Разработка** — `upstream/development/`
  - `01-architecture` · `02-network-architecture` · `03-lint-and-commit-setup`
- **Облако** — `upstream/cloud/`
  - `00-overview` · `01-running-and-previewing`
- **Диагностика** — `upstream/troubleshooting/`
  - `common-issues`

Внешние ресурсы апстрима (не зеркалим): REST API — `https://developer.cloudcli.ai`,
Discord, GitHub Issues.

## ⚠️ Важно про качество забора

`upstream/` снят инструментом, который прогоняет страницы через вспомогательную
модель. **Команды, код-листинги, таблицы и структура воспроизведены точно**, но
часть связного пояснительного текста местами пересказана, а отдельные длинные
примеры (напр. полный конфиг Caddy с basic-auth в `installation/05-remote-server`,
развёрнутые списки PM2-команд) даны конспективно, не дословно.

Для перевода и доработки этого достаточно. Если для конкретной страницы нужна
дословная копия — перезабрать через headless-Chrome/`curl` + конвертер и
заменить файл (шапку-источник сохранить).

Отдельная сверка: некоторые переменные окружения в `upstream/configuration/`
(`PORT`, `WORKSPACES_ROOT`, `ENABLE_HTTPS`) — с сайта апстрима; реальный
`.env.example` форка использует `SERVER_PORT`, `VITE_PORT`, `HOST`,
`DATABASE_PATH`, `CONTEXT_WINDOW`. При переводе выверять по коду форка.

## План доработки документации

1. **Перевод** — переносить страницы `upstream/*` → `ru/*` на русский, выверяя
   факты по коду форка (имена переменных, порты, флаги).
2. **Дополнения форка** — то, чего нет у апстрима:
   - наши доработки (нативные картинки, вложения, effort-фикс, настройки в БД,
     Opus 5) — сведены в `../CLAUDE.md` и `../GOLDJAXE-FORK.md`, развернуть в
     `ru/features/` по мере надобности;
   - деплой холдинга (Tailscale, отдельный порт/БД, раскатка вместо npm-пакета).
3. **Единый индекс** — по мере роста `ru/` добавить сюда оглавление русской доки
   (при желании — поднять MkDocs + Material, как в проекте diktor).

## Быстрые ссылки

- Правила для ИИ-ассистентов и карта архитектуры → [`../CLAUDE.md`](../CLAUDE.md)
- О форке и его целях → [`../GOLDJAXE-FORK.md`](../GOLDJAXE-FORK.md)
- Витрина проекта (EN + 7 языков) → [`../README.md`](../README.md)
- Как контрибьютить (upstream) → [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
