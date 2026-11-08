---
title: "Модели Claude и Kimi в каталоге"
type: fork-change
sections: [§1.1, §1.2, §1.4]
tags: [модели, kimi, sonnet, opus, claude-models]
description: "История запасного каталога Claude: Kimi K3, снятый Opus 5 и Sonnet 5.5. С §22 основной список приходит из подключённого API, а эти записи остаются fallback и метаданными совместимости."
updated: 2026-11-08
---

# Модели Claude и Kimi в каталоге

> Разделы реестра §1.1, §1.2, §1.4. Часть [реестра правок форка](../fork-changes.md): номер § — постоянный адрес правки, по нему на эту страницу ссылаются код и коммиты.

> **С 08.11.2026:** основной каталог при подключённом API динамический —
> [§22](api-models.md). Ниже сохранена история наших статических записей;
> `CLAUDE_PREDEFINED_MODELS` используется как fallback и известные метаданные.
> Чтобы новая модель API появилась в выборе, редактировать массив не нужно.

## §1.1 Kimi K3 (1M контекст)

- **Слой:** модель · **Столкновение:** 🟡 · **PR:** нет (специфично для холдинга).
- **Что:** добавлена модель `kimi-k3[1m]` (Moonshot) в список моделей Claude.
  Когда выбрана `kimi-*` и задан `ANTHROPIC_AUTH_TOKEN`, но нет
  `ANTHROPIC_BASE_URL` — endpoint `https://api.moonshot.ai/anthropic`
  подставляется автоматически.
- **Файлы:** `server/modules/providers/list/claude/claude-models.provider.ts`
  (запись в `CLAUDE_FALLBACK_MODELS`), `.../claude-runtime.provider.ts`
  (хук env в `mapCliOptionsToSDK`), `.env.example` (переменные Kimi).
- **Историческая причина форка:** до §22 список моделей был захардкожен в ядре
  (`getSupportedModels()` отключён upstream), плагином было не расширить.

## §1.2 Opus 5 в списке моделей

- **Слой:** модель · **Столкновение:** 🟡 · **PR:** нет.
- **Статус:** **снято коммитом `969a6443`** — каталог сокращён до 1M-моделей
  (Fable 5.1, Sonnet 5, Opus 5.5; режим ultracode добавлен Opus 5.5),
  `claude-opus-5`/`claude-opus-5[1m]` и Opus 4.8 из списка убраны. Массив после
  слияния v1.37.3 называется `CLAUDE_PREDEFINED_MODELS` (не `CLAUDE_FALLBACK_MODELS`).
- **Что было:** `claude-opus-5` и `claude-opus-5[1m]` добавлены выше Opus 4.8; старый
  label `Opus` переименован в `Opus 4.8`.
- **Файлы:** `server/modules/providers/list/claude/claude-models.provider.ts`.
- **Мерж:** все модельные правки живут в одном массиве `CLAUDE_PREDEFINED_MODELS` —
  при обновлении upstream сверять этот массив целиком.

## §1.4 Sonnet 5.5 явным id вместо алиаса `sonnet[1m]`

- **Слой:** модель · **Столкновение:** 🟡 (тот же массив моделей) · **PR:** нет.
- **Что:** пункт «Sonnet 5 (1M context)» со значением-алиасом `sonnet[1m]`
  заменён на `claude-sonnet-5-5[1m]` — «Sonnet 5.5 (1M context)». Алиас
  разворачивался в зависимости от `ANTHROPIC_DEFAULT_SONNET_MODEL` на машине;
  явный id одинаков везде (шлюз отдаёт `claude-sonnet-5-5[1m]`; проверено через
  Claude CLI — инструменты работают, отвечает `claude-sonnet-5-5`).
- **Старые сеансы:** у них в БД остаётся записанное `sonnet[1m]` — при
  продолжении оно по-прежнему уходит в CLI как алиас. В меню такой сеанс
  показывает сырой id; уровни effort там есть (запасной общий список), но сервер
  их отбрасывает — `resolveClaudeEffort` сверяет уровень с каталогом, — и ран
  идёт на уровне CLI по умолчанию. Так же, как со снятыми в 1.2 моделями;
  миграции нет, как и тогда.
- **Файлы:** `server/modules/providers/list/claude/claude-models.provider.ts`.

## Связанные страницы

- [GPT через шлюз CLIProxyAPI: effort и окно контекста](gpt-gateway.md) — GPT в том же каталоге моделей
- [Свои модели через библиотеку: «Польза.ai»](custom-models.md) — модели из библиотеки, без правки каталога
