---
title: "Разработка: команды, тесты, проверки"
type: dev
tags: [разработка, команды, npm, тесты, vitest, node-test, tsx, lint, typecheck, изоляция]
description: "Все команды разработки форка (dev, сборка, запуск, проверки), как гонять серверные тесты через tsx и клиентские через vitest с NODE_ENV=test, почему тесты и тестовый инстанс из сессии CloudCLI запускаются только в изолированном окружении, что проверять перед коммитом."
updated: 2026-10-31
---

# Разработка: команды, тесты, проверки

## Команды

```bash
# Разработка (клиент :5173 + сервер :3001 одновременно)
npm run dev

# По отдельности
npm run client            # только Vite dev-сервер
npm run server:dev        # только Express/WS через tsx
npm run server:dev-watch  # то же с авто-перезапуском

# Сборка (клиент → dist/, сервер → dist-server/)
npm run build             # = build:client + build:server
npm run build:client      # vite build
npm run build:server      # tsc -p server/tsconfig.json + tsc-alias

# Прод-запуск собранного
npm run start             # build + node dist-server/server/index.js
npm run server            # только запуск уже собранного dist-server

# Проверки (гонять перед каждым коммитом)
npm run typecheck         # tsc --noEmit для client И server
npm run lint              # oxlint src/ server/ (с 1.37.3; eslint.config.js удалён)
npm run lint:fix          # oxlint --fix

# Desktop-компаньон (Electron) — для веб-сценария обычно не нужен
npm run desktop:dev
```

**Node.js:** `.nvmrc` просит v22; в нашей среде стоит v24, он совместим и для
сборки vite/react, и для запуска сервера. Апстрим требует Node ≥ 22.

**Зависимости:** в среде выставлен `NODE_ENV=production`, поэтому `npm install`
без `--include=dev` не ставит инструменты разработки.

**Husky и lint-staged** активны: pre-commit гоняет oxlint по staged-файлам.

**Установка апстрима у конечного пользователя** (не для разработки форка) —
`npx @cloudcli-ai/cloudcli` или `npm i -g @cloudcli-ai/cloudcli && cloudcli`.

## Серверные тесты (node:test через tsx)

```bash
npx tsx --tsconfig server/tsconfig.json --test <path/to/*.test.ts>
```

Без tsx алиасы `@/` не резолвятся. С 1.37.3 есть и `npm test` (все серверные
тесты сразу). Новую серверную логику покрывай тестом рядом
(`server/**/tests/*.test.ts`).

**Из сессии CloudCLI — только в изолированном окружении.** Сессия агента
наследует env боевого инстанса (`DATABASE_PATH`, `SERVER_PORT`,
`CLAUDE_CLI_PATH`). Тест, который сам не подменяет `DATABASE_PATH`, получит
унаследованную, то есть боевую, `~/.cloudcli/auth.db`. Четыре теста
`claude-cli-path.test.ts` падают, пока в env есть `CLAUDE_CLI_PATH`. Полный
прогон:

```bash
H=$(mktemp -d); env -i PATH="$PATH" HOME="$H" DATABASE_PATH="$H/auth.db" \
  node_modules/.bin/tsx --tsconfig server/tsconfig.json --test \
  "server/**/*.test.ts" "server/**/*.test.js"
```

## Клиентские тесты (vitest)

```bash
NODE_ENV=test npx vitest run          # весь набор
NODE_ENV=test npx vitest run <file>   # один файл
```

`NODE_ENV=test` обязателен: при унаследованном `NODE_ENV=production` React
грузится production-сборкой, `act()` не работает, и получаются сотни ложных
падений.

## Тестовый инстанс

Подмена одного `HOME` БД не изолирует: тестовый сервер, запущенный из сессии
CloudCLI, пишет в боевую `~/.cloudcli/auth.db` (сканирование, автоархив, курсор
`scan_state`). Запускать через `env -i …` со своими `DATABASE_PATH` и
`SERVER_PORT`. Рабочие инстансы не трогать: :3302 — боевой форк, :3301 —
рабочий инстанс Артёма ([деплой](../deploy.md)).

## Перед коммитом

- `npm run typecheck` — 0 ошибок;
- `npm run lint` — 0 ошибок; предупреждения апстрима базовые, новых не добавлять;
- при правках сервера — `npm run build` (в worktree: здесь сборка — это выкатка, см. ниже) и профильные `node:test`;
- для UI и тача — проверка в браузере на мобильном вьюпорте на изолированном
  инстансе;
- запись в реестре и документации — тем же коммитом
  ([регламент реестра](../fork-changes.md#регламент-ведения)).

## Почему не собирать и не сливать в рабочей папке

Боевой инстанс :3302 (`cloudcli-fork.service`) работает из `dist-server/` и
`dist/` этой же папки, а сессия агента обычно идёт внутри него. Пересборка здесь
подменит файлы под живым сервером, рестарт службы оборвёт сессию. Поэтому
слияние upstream, сборка и тесты слияния — в отдельном git worktree, сюда —
только `merge --ff-only` готового результата
([как вливать upstream](../fork/upstream-merge.md)). Выкатка (сборка здесь и
рестарт службы) согласуется с владельцем.

## Связанные страницы

- [Архитектура форка](architecture.md) — карта репозитория и ключевые механизмы
- [Как вливать upstream](../fork/upstream-merge.md) — порядок работы в worktree
- [Деплой форка на ноуте mx-linux](../deploy.md) — служба, порты, перезапуск
