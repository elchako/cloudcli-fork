---
title: "Картинки в markdown-чате"
type: fork-change
sections: [§2.1]
tags: [чат, картинки, markdownimage, jwt, same-origin, local-media]
description: "Показ картинок в markdown-чате: апстримовский MarkdownImage плюс наша ветка для /api/... (blob с JWT, только same-origin) и абсолютных путей через local-media."
updated: 2026-10-31
---

# Картинки в markdown-чате

> Раздел реестра §2.1. Часть [реестра правок форка](../fork-changes.md): номер § — постоянный адрес правки, по нему на эту страницу ссылаются код и коммиты.

## §2.1 Нативный показ картинок в markdown-чате

- **Слой:** frontend · **Столкновение:** 🟡 (с 1.37.4 — правка в
  апстримовском компоненте) · **PR:** кандидат (ветка `/api/` + same-origin).
- **Что:** markdown `![](/api/assets/...)` рендерится через `MarkdownImage` —
  blob-загрузка защищённых путей с JWT в заголовке (не в DOM/URL).
- **Статус (v1.37.4): основа поглощена upstream #1307.** Апстрим завёл свой
  `src/modules/chat/transcript/MarkdownImage.tsx`: пути проекта
  (`imagenes/x.png`) через `api.readFileBlob`, клик — лайтбокс, при ошибке —
  иконка + alt. Наш `chat/composer/MarkdownImage.tsx` **удалён**, а в
  апстримовский внесены две наши ветки (помечены `Fork:`): свои `/api/...`
  (картинки `generate_image`, вложения) — `authenticatedFetch`, иначе апстрим
  принял бы их за путь в проекте и показал бы заглушку; абсолютный путь вне
  проекта — запасной `local-media` ([§4.5](file-viewer.md)). Подробно — [§14.2](merge-v1.37.4.md).
- **Безопасность (исправлено при слиянии):** наша прежняя проверка
  `^https?://[^/]+/api/` отправляла JWT на **любой** хост с `/api/` в пути —
  картинка, которую написала модель, уводила 365-дневный токен. Теперь
  авторизованный запрос только same-origin; тест
  `src/modules/chat/tests/markdownImageFork.test.tsx` (6).
- **Файлы:** `src/modules/chat/transcript/MarkdownImage.tsx` (апстрим + наши
  ветки), `src/modules/chat/transcript/Markdown.tsx` (override `img` — апстрим).
- **Мерж-заметка (v1.37.2):** конфликт в `markdownComponents` — наш override
  `img` соседствовал с нашим же простым `pre`. Upstream переписал `pre` (ищет
  дочерний `CodeBlock` и рендерит его с `forceBlock`, т.к. react-markdown v9+
  больше не передаёт флаг `inline`). Взят апстримовский `pre` + наш `img`:
  наш `pre` был обычным passthrough и апстримовский его строго перекрывает.

## Связанные страницы

- [Файлы вне проекта открываются на чтение](file-viewer.md) — открытие картинок и файлов вне проекта
- [Генерация картинок в чате: устройство и ограничения](image-generation.md) — картинки, которые рисует generate_image
- [Вложения: любые файлы и сохранность при смене чата](attachments.md) — вложения в сообщениях
- [Чат: вложения и очередь сообщений](../chat.md) — пользовательская страница про чат
