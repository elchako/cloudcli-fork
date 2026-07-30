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

## Голосовой ввод с телефона (микрофон)

Кнопка микрофона в чате появляется только когда браузер отдаёт
`navigator.mediaDevices.getUserMedia`, а он доступен **исключительно в secure
context** — HTTPS либо localhost. Заход по `http://100.64.0.27:3302` (Tailscale-IP)
защищённым не считается, поэтому по умолчанию на телефоне микрофона нет
(см. `fork-changes.md` §4.4 — форк скрывает кнопку вместо падения по тапу).

**Рабочее решение холдинга — Chrome-флаг на телефоне.** Один раз, ~1 минута:

1. `chrome://flags`
2. Найти **Insecure origins treated as secure**
3. В поле вписать ровно `http://100.64.0.27:3302`
4. Перевести флаг в **Enabled**
5. Нажать **Relaunch**

После перезапуска origin считается доверенным, `mediaDevices` появляется,
кнопка микрофона включается сама — правок кода не требуется.

> **Tailscale Serve не подходит.** У холдинга **Headscale** (контроллер
> `head.vegasoft.org`, tailnet `h.org`), а он не выдаёт TLS-сертификаты:
> `tailscale cert` → *HTTPS cert support is not enabled/configured for your
> tailnet*, `CertDomains: null`. Домен `h.org` вымышленный, Let's Encrypt его не
> подтвердит. Инструкции из документации Tailscale SaaS («включите HTTPS
> Certificates в админке») к нам неприменимы — такой галочки в Headplane нет.

Альтернатива на будущее, если понадобится доступ с любого устройства без
настройки браузера: поддомен на edge-nginx холдинга (валидный сертификат) с
`proxy_pass` на `100.64.0.27:3302` через Tailscale — как сделано для
`g.amilin.vip`, `rust.amilin.vip`.

## Проверка после рестарта/перезагрузки

```bash
ss -tlnp | grep :3302                       # порт слушается
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3302/   # ожидаем 200
```

### Проверка secure context (когда «микрофона нет»)

Наличие кнопки в UI **ничего не доказывает** — она может быть видна и нерабочей.
Проверять надо сам origin в браузере. В консоли DevTools на нужной вкладке:

```js
JSON.stringify({
  origin: location.origin,
  secure: window.isSecureContext,
  gum: typeof (navigator.mediaDevices || {}).getUserMedia,
})
```

`secure: false` / `gum: "undefined"` → микрофон физически недоступен на этом
origin, дело не в коде приложения. Лечится только secure context (см. выше).
