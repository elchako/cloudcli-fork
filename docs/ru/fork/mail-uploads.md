---
title: "Учёт пользовательских загрузок для Mail"
type: fork-change
sections: ["24"]
tags: [mail, вложения, assets, происхождение, отзыв]
description: "Opt-in JSON-реестр новых authenticated multipart загрузок, точный протокол для Python Source G2, владелец из активной учётки и отзыв только Mail-экспорта."
updated: 2026-11-15
---

# Учёт пользовательских загрузок для Mail

## §24. Новые пользовательские файлы, не произвольный путь модели

**Состояние:** реализация от `bdb11975` прошла изолированные проверки и
независимое ревью. Сборка и opt-in конфигурация требуют перезапуска живого
CloudCLI; пользовательский сквозной проход не объявлен завершённым.
**Слой:** assets API и отдельный сервис реестра.
**Пересечение с upstream:** среднее в двух upload routes; остальная логика
изолирована. **PR в upstream:** не отправлен.

### Зачем и граница

Общий каталог chat assets сам по себе не доказывает происхождение файла: туда
попадают и картинки генератора, а в дескрипторе хранится лишь путь. Для Python
Source G2 добавлен реестр **только новых пользовательских multipart загрузок**.
Это не разрешение на отправку письма, не capability и не export lease.

Администратор отдельно задаёт абсолютный путь `CLOUDCLI_MAIL_UPLOADS_DIR` в env
backend. Родитель каталога должен существовать. Сам каталог создаётся с 0700
либо проверяется как уже существующий: UID процесса, ровно 0700, без symlink.
Путь читается при старте модуля. Реальные настройки здесь не менялись.

Без env прежние upload response совместимы, записей нет. При ошибочном явно
заданном каталоге загрузка не выдаёт успешный Mail record, API отвечает 500 без
приватных путей. Закрытый каталог не раздаётся HTTP API и не включается в
разрешённые корни чтения автоматически. Права 0700/0600 не изолируют данные от
произвольного кода того же Unix UID; границу исполнения обеспечивает развёртывание.

### Запись после authenticated upload

У существующих `POST /api/assets/images` (20 MiB на файл) и
`POST /api/assets/files` (10 MiB на файл) сохранены multipart поля и лимиты.
JWT middleware защищает оба пути, а route повторно проверяет существование и
активность `req.user.id`. `owner_user_id` и scope из body не используются.

После успешного multer upload для каждого файла:

- storage_name берётся только из настоящего multer filename, без разделителей;
- source открывается O_RDONLY/O_NOFOLLOW/O_NONBLOCK, проверяется как обычный
  файл с nlink=1; размер и SHA-256 вычисляются по одному FD, с ограничением
  фактически прочитанных байтов и перепроверкой stat после чтения;
- операции с файлами привязаны к открытым FD каталогов через `/proc/self/fd`,
  поэтому реализация рассчитана на Linux;
- активность владельца перепроверяется после hash и перед публикацией;
- JSON сначала пишется в уникальный `.pending-*.tmp` через O_EXCL с 0600,
  синхронизируется и атомарно переименовывается в UUIDv4 `.json`. Source должен
  перечислять только UUID `.json`, не временные файлы.

Точный протокол записи, без дополнительных полей:

```json
{
  "asset_id": "UUIDv4",
  "owner_user_id": "строка CloudCLI user.id",
  "origin": "user_upload",
  "storage_name": "реальное имя файла multer без разделителей",
  "filename": "исходное имя файла пользователя",
  "mime_type": "file.mimetype от multer",
  "size_bytes": 123,
  "sha256": "нижний hex SHA-256 фактических байтов",
  "created_at_ms": 1794700000000,
  "state": "ready",
  "acl_version": 1
}
```

MIME сохраняется из multipart метаданных multer, это не проверка сигнатуры
содержимого. `size_bytes` берётся из фактического файла, не из model JSON.
Формат ответа дополнен полями каждого дескриптора:
`mail_source_object_id=asset_id` и `mail_sha256=sha256`. Прежние
`name/path/size/mimeType/kind` не меняются.

Генератор, обычное построение дескрипторов, старые файлы и произвольные пути
**не регистрируются**. Автоматического backfill нет. Для старых вложений нужна
новая пользовательская загрузка после включения env. ID для Mail получает
`mail_prepare_draft.list_uploads` через Python Source, а не догадка модели о пути.
Дополнительно пара `mail_source_object_id/mail_sha256` проходит нормализацию
chat descriptors и видна модели внутри существующего attachment-блока prompt:
для файлов и Claude native images, а также images_input соответствующих
провайдеров. Указаны вид вложения и его порядковый номер; история чата удаляет
технический блок прежним парсером, не превращая ID/hash в путь.

Это **подсказка для выбора**, не capability и не проверка владельца. Дескриптор
приходит от клиента: normalizer проверяет только полную пару UUIDv4/hex64, а
владелец, state, acl_version и original SHA проверяются заново в Source.
Форматный ref нельзя использовать как разрешение или доверенное подтверждение
происхождения. Ни один свободный путь из model arg не становится Mail-вложением.

### Отзыв

`DELETE /api/assets/mail-uploads/:asset_id` использует только активного
авторизованного пользователя. Чужой и неизвестный ID дают одинаковый 404.
Успех: 204, атомарная замена JSON с `state: revoked`, `acl_version: 2` при первом
отзыве. Повторный отзыв владельца идемпотентен, версия повторно не увеличивается.
Прочие поля сохраняются. Symlink/hardlink записей не принимаются.

Исходный chat asset не удаляется и продолжает открываться в чате. Крестик
композера не является отзывом Mail-экспорта. Удаление самого файла не управляется
этим API; Source заново проверяет наличие и original SHA при экспорте.

Сессии, `import_id`, capability TTL 300 секунд и lease 10 секунд относятся к
Python G2, не к этому JSON-реестру. Здесь намеренно нет полей session/TTL/lease,
нет источникового RPC и нет изменений Mail. Source повторно проверяет активного
владельца по CloudCLI auth DB, состояние, acl_version и фактические байты.

### Проверки

- `server/modules/assets/tests/mail-upload-registry.service.test.ts`: точный
  протокол, SHA/размер, права, default off, отсутствие backfill, traversal,
  symlink/hardlink, неверный размер, неактивный владелец, отзыв и повторы.
- `server/modules/assets/tests/mail-upload-routes.test.ts`: настоящий HTTP
  multipart с синтетическим JWT, owner из auth вместо body, оба upload API,
  одинаковые 404, отзыв без удаления chat asset, запрет без JWT/inactive user.
- Прежние tests assets и тесты подписи Mail остаются в профильном прогоне.

Изолированная приёмка этого среза: 109 серверных тестов, 24 UI-теста,
typecheck и полная сборка прошли; lint: 0 ошибок и 146 предупреждений,
новых предупреждений в изменённых стыках нет. Тот же независимый Скептик дал
GO, отдельно выполнил 28 серверных и 24 UI-теста без ошибок. На автономном стенде при 390×844 проверены обе темы,
все Cc/Bcc, конец длинного тела, весь список файлов, отсутствие JSON/checkbox и
однократное подтверждение касанием. Реальные письма, Source RPC и живой CloudCLI
не запускались. Временные файлы стенда удалены, его HTTP listener и Chrome закрыты.

Из корня отдельного рабочего дерева:

```bash
H=$(mktemp -d)
env -i PATH="$PATH" HOME="$H" DATABASE_PATH="$H/auth.db" \
  node_modules/.bin/tsx --tsconfig server/tsconfig.json --test --test-concurrency=4 \
  server/modules/assets/tests/*.test.ts server/shared/mail-approval/tests/*.test.ts \
  server/modules/providers/tests/claude-elicitation.test.ts \
  server/shared/tests/image-attachments.test.ts server/shared/tests/mail-upload-refs.test.ts

H=$(mktemp -d)
env -i PATH="$PATH" HOME="$H" DATABASE_PATH="$H/auth.db" NODE_ENV=test \
  node_modules/.bin/vitest run src/modules/chat/tests/localMailElicitationPanel.test.tsx \
  src/modules/chat/tests/mcpElicitationPanel.test.tsx

H=$(mktemp -d)
env -i PATH="$PATH" HOME="$H" DATABASE_PATH="$H/auth.db" npm run typecheck
env -i PATH="$PATH" HOME="$H" DATABASE_PATH="$H/auth.db" npm run lint
env -i PATH="$PATH" HOME="$H" DATABASE_PATH="$H/auth.db" npm run build
```

### Файлы

- `server/modules/assets/services/mail-upload-registry.service.ts`: JSON-реестр,
  FD hash, защищённая публикация и отзыв.
- `server/modules/assets/assets.routes.ts`: активный owner, регистрация после
  upload, дополнительные поля ответа, owner-scoped DELETE.
- `server/shared/image-attachments.ts`: сохранение advisory ID/SHA в descriptors,
  prompt refs внутри уже существующих тегов и совместимость парсера истории.
- `server/modules/providers/list/claude/claude-runtime.provider.ts`: передача
  image refs в общий файловый блок без повторного прикрепления изображения.
- `server/shared/tests/mail-upload-refs.test.ts`: сохранность refs, фильтр
  некорректных значений и round trip истории.

## Связанные страницы

- [Реестр правок](../fork-changes.md)
- [Подтверждение Mail](local-mail-approval.md)
- [Вложения чата](attachments.md)
- [Архитектура](../dev/architecture.md)
