# Деплой форка на ноуте mx-linux (автозапуск)

Форк CloudCLI холдинга крутится на ноуте `mx-linux` как **user-сервис systemd**
и стартует автоматически при загрузке системы. Основной сценарий — доступ с
телефона по Tailscale.

## Параметры инстанса

| Параметр | Значение |
|---|---|
| Порт | **3302** (рабочий инстанс Артёма — 3301, **не трогать**) |
| Хост | `0.0.0.0` (доступен по Tailscale) |
| Доступ с телефона | `http://100.64.0.27:3302` (Tailscale-IP ноута) |
| БД | `~/.cloudcli/auth.db` (по умолчанию) |
| Node | nvm `v24.13.0`, абсолютный путь в unit |
| Рабочий каталог | `…/GoldJaxe/tools/cloudcli-fork` |
| Точка входа | `dist-server/server/index.js` (сборка сервера) |

## Сервис

Unit: `~/.config/systemd/user/cloudcli-fork.service` (user-scope, не system).
Автозапуск обеспечен двумя вещами:
- `systemctl --user enable` → симлинк в `default.target.wants`;
- `loginctl` **linger включён** для `mx-linux` (`Linger=yes`) → user-инстанс
  systemd поднимается при загрузке системы, не дожидаясь GUI-входа.

### Управление

```bash
# статус / логи
systemctl --user status cloudcli-fork
journalctl --user -u cloudcli-fork -f

# старт / стоп / рестарт
systemctl --user start   cloudcli-fork
systemctl --user stop    cloudcli-fork
systemctl --user restart cloudcli-fork

# включить/выключить автозапуск
systemctl --user enable  cloudcli-fork
systemctl --user disable cloudcli-fork
```

### После изменения кода форка

Сервис запускает **собранный** сервер и раздаёт **собранный** клиент, поэтому
изменения подхватываются только после сборки:

```bash
cd …/GoldJaxe/tools/cloudcli-fork
npm run build:client      # правки во фронте (src/)
npm run build             # правки в сервере (server/) — билд клиента+сервера
systemctl --user restart cloudcli-fork
```

> Раньше инстанс запускали вручную (`nohup node dist-server/server/index.js …`).
> Теперь это делает systemd — **не запускать копию руками**, иначе конфликт за
> порт 3302. Если ручной процесс висит: `systemctl --user restart cloudcli-fork`
> сам не убьёт чужой процесс — сначала `kill` висящего, потом рестарт.

### Правка параметров запуска

Порт/хост/переменные заданы в `Environment=` внутри unit-файла. После правки:

```bash
systemctl --user daemon-reload
systemctl --user restart cloudcli-fork
```

## Проверка после рестарта/перезагрузки

```bash
ss -tlnp | grep :3302                       # порт слушается
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3302/   # ожидаем 200
```
