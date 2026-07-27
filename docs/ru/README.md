# Документация на русском (в работе)

Здесь будет русский перевод официальной документации CloudCLI и дополнения под
форк холдинга GOLDJAXE.

**Порядок работы:** берём страницу из `../upstream/<раздел>/<файл>.md`, переводим
на русский, **выверяя факты по коду форка** (имена переменных окружения, порты,
флаги, эндпоинты — апстрим-текст местами расходится с реальным `.env.example` и
роутами форка), сохраняем сюда с тем же путём (`ru/<раздел>/<файл>.md`).

Карта разделов и статус забора upstream — в [`../README.md`](../README.md).

## Что перевести в первую очередь

1. `installation/02-quick-start-npx`, `03-global-installation`, `05-remote-server`
   — как поднять (в т.ч. удалённо).
2. `configuration/02-environment-variables` — **с выверкой по `.env.example`**
   форка (`SERVER_PORT`/`VITE_PORT`/`HOST`/`DATABASE_PATH`/`CONTEXT_WINDOW`).
3. `configuration/01-tools-and-permissions` — включение инструментов агента.
4. `features/mobile-app` — основной сценарий холдинга (телефон + Tailscale).
5. `troubleshooting/common-issues`.

## Дополнения форка (нет у апстрима)

- Наши доработки: нативные картинки в чате, прикрепление любых файлов, фикс
  мобильного effort, настройки в БД, Opus 5 — кратко в
  [`../../CLAUDE.md`](../../CLAUDE.md) и [`../../GOLDJAXE-FORK.md`](../../GOLDJAXE-FORK.md).
- Деплой в контуре холдинга (Tailscale, отдельный `SERVER_PORT`/`DATABASE_PATH`,
  раскатка форка вместо npm-пакета).
