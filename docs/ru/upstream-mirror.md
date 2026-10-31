---
title: "Зеркало документации upstream: карта и качество забора"
type: reference
tags: [upstream, документация, зеркало, перевод, env]
description: "Что лежит в docs/upstream/ (официальная документация CloudCLI с сайта на момент забора), карта разделов, насколько точен забор и какие переменные окружения там расходятся с кодом форка."
updated: 2026-10-31
---

# Зеркало документации upstream: карта и качество забора

`docs/upstream/` — снимок официальной документации CloudCLI с
`https://cloudcli.ai/docs` на момент забора, на английском. У апстрима нет
структурированной папки документации в репозитории, полная документация живёт на
сайте, поэтому мы сняли её сюда. Это база для [перевода](translation.md); наши
пометки — отдельными блоками или файлами, само зеркало правим осторожно.

> Раздел восстановлен 31.10.2026 из каталога `docs/README.md`, который потерялся
> при слиянии upstream v1.37.3 ([§6](fork/upstream-merge.md)).

## Карта разделов

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

`upstream/README.md` — копия README апстрима, отложенная туда при разводе
конфликта v1.37.2.

Вне зеркала, прямо в репозитории апстрима: `docs/architecture/` (как сообщение
идёт от композера к CLI и обратно) и переводы витрины `docs/README.<язык>.md`.
Внешние ресурсы апстрима, которые не зеркалим: REST API —
`https://developer.cloudcli.ai`, Discord, GitHub Issues.

## Насколько точен забор

Зеркало снято инструментом, который прогоняет страницы через вспомогательную
модель. **Команды, листинги кода, таблицы и структура воспроизведены точно**, но
часть связного пояснительного текста местами пересказана, а отдельные длинные
примеры (например, полный конфиг Caddy с basic-auth в
`installation/05-remote-server`, развёрнутые списки команд PM2) даны конспективно.

Для перевода и доработки этого достаточно. Если для конкретной страницы нужна
дословная копия — перезабрать её через headless-Chrome или `curl` с конвертером и
заменить файл, сохранив шапку-источник.

## Расхождения с кодом форка

Переменные окружения в `upstream/configuration/` взяты с сайта апстрима и с
кодом совпадают не все (сверка 31.10.2026):

- порт сервера — `SERVER_PORT`; `PORT` читается только запасным вариантом в
  `browser-use.service.ts`;
- `ENABLE_HTTPS` код не читает вовсе;
- `WORKSPACES_ROOT` читается (`server/shared/utils.ts`, по умолчанию домашняя
  папка), но в `.env.example` её нет;
- `.env.example` форка перечисляет `SERVER_PORT`, `VITE_PORT`, `HOST`,
  `DATABASE_PATH`, `CONTEXT_WINDOW`.

При переводе факты выверяются по коду форка.

## Связанные страницы

- [План перевода документации upstream](translation.md) — что переводить первым
- [Архитектура форка](dev/architecture.md) — карта репозитория форка
- [Как вливать upstream](fork/upstream-merge.md) — история конфликта вокруг `docs/README.md`
