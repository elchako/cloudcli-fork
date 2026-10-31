---
title: "План перевода документации upstream"
type: plan
tags: [перевод, upstream, документация]
description: "Как переводить официальную документацию CloudCLI на русский с выверкой фактов по коду форка и что переводить первым."
updated: 2026-10-31
---
# План перевода документации upstream

Здесь будет русский перевод официальной документации CloudCLI и дополнения под
форк холдинга GOLDJAXE.

**Порядок работы:** берём страницу из `../upstream/<раздел>/<файл>.md`, переводим
на русский, **выверяя факты по коду форка** (имена переменных окружения, порты,
флаги, эндпоинты — апстрим-текст местами расходится с реальным `.env.example` и
роутами форка), сохраняем сюда с тем же путём (`ru/<раздел>/<файл>.md`).

Карта разделов зеркала и оговорки о качестве забора — [`upstream-mirror.md`](upstream-mirror.md). Оглавление русской документации — [`index.md`](index.md).

## Что перевести в первую очередь

1. `installation/02-quick-start-npx`, `03-global-installation`, `05-remote-server`
   — как поднять (в т.ч. удалённо).
2. `configuration/02-environment-variables` — **с выверкой по `.env.example`**
   форка (`SERVER_PORT`/`VITE_PORT`/`HOST`/`DATABASE_PATH`/`CONTEXT_WINDOW`).
3. `configuration/01-tools-and-permissions` — включение инструментов агента.
4. `features/mobile-app` — основной сценарий холдинга (телефон + Tailscale).
5. `troubleshooting/common-issues`.

## Дополнения форка (нет у апстрима)

- Наши доработки — по темам в [реестре правок форка](fork-changes.md), цели
  форка — в [`../../GOLDJAXE-FORK.md`](../../GOLDJAXE-FORK.md).
- Деплой в контуре холдинга (Tailscale, отдельный `SERVER_PORT`/`DATABASE_PATH`,
  раскатка форка вместо npm-пакета).
- Картинки прямо в чате (gpt-image-2.5 через шлюз) — [`images.md`](images.md).
- Любые вложения, очередь сообщений и переключение чатов при загрузке файла —
  [`chat.md`](chat.md).

## Связанные страницы

- [Зеркало документации upstream](../upstream/README.md) — что переводим
- [CloudCLI (форк GOLDJAXE) — документация](index.md) — оглавление русской документации
