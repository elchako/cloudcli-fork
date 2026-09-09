# Установка и обновление форка CloudCLI

Инструкция для тех, кто ставит форк себе на машину и потом обновляется, когда
выходит новая версия. Про инстанс на ноуте `mx-linux` — отдельный документ,
[`deploy.md`](deploy.md).

## Репозиторий

Код лежит на GitHub: **`git@github.com:elchako/cloudcli-fork.git`**, репозиторий
приватный. Рабочая ветка — `main`, это зеркало нашей ветки разработки
(`feat/goldjaxe-improvements` во внутреннем git холдинга). Обновления приходят
только из зеркала: **свои коммиты в GitHub не пушить**, иначе ветка разойдётся
и `update.sh` откажется обновляться.

Чтобы получить доступ, дайте Артёму ваш GitHub-логин — он добавит вас
коллаборатором.

## Требования

| Что | Версия |
|---|---|
| Node.js | ≥ 22 (проверено на 22 и 24) |
| npm | идёт с Node |
| git | любой современный |
| Claude Code CLI | установлен и авторизован — форк работает поверх него |

## Установка с нуля

### 1. Настроить доступ по SSH

Если ключа для GitHub ещё нет:

```bash
ssh-keygen -t ed25519 -C "ваш-email"
cat ~/.ssh/id_ed25519.pub
```

Скопируйте вывод и добавьте его на github.com → Settings → SSH and GPG keys →
New SSH key. Проверка:

```bash
ssh -T git@github.com   # должно ответить: Hi <логин>! You've successfully authenticated
```

### 2. Склонировать и собрать

```bash
git clone git@github.com:elchako/cloudcli-fork.git
cd cloudcli-fork

# --include=dev обязателен: без devDependencies не соберётся ни клиент, ни сервер
npm install --include=dev
npm run build
```

### 3. Запустить

```bash
npm run server            # запуск собранного сервера
```

По умолчанию сервер слушает порт **3001**. Открывайте `http://localhost:3001`.
При первом входе на пустой базе создаётся учётка — форма регистрации появится
сама.

Порт и путь к БД меняются переменными окружения:

```bash
SERVER_PORT=3302 DATABASE_PATH=~/.cloudcli/auth.db npm run server
```

### 4. Автозапуск (по желанию)

Чтобы форк поднимался сам при загрузке системы.

**Linux с systemd.** Создайте `~/.config/systemd/user/cloudcli-fork.service`:

```ini
[Unit]
Description=CloudCLI fork (GOLDJAXE)
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/путь/к/cloudcli-fork
ExecStart=/usr/bin/node dist-server/server/index.js
Environment=NODE_ENV=production
Environment=SERVER_PORT=3001
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

> `ExecStart` требует **абсолютный** путь к `node`. Если Node стоит через nvm,
> посмотрите путь командой `which node` и подставьте его.

```bash
systemctl --user daemon-reload
systemctl --user enable --now cloudcli-fork
loginctl enable-linger "$USER"   # чтобы служба стартовала до входа в систему
```

**macOS.** Проще всего через pm2:

```bash
npm install -g pm2
pm2 start "npm run server" --name cloudcli-fork
pm2 save && pm2 startup   # выполните команду, которую pm2 напечатает
```

**Windows.** Используйте WSL2 и инструкцию для Linux. Если в вашем WSL нет
systemd, запускайте вручную или через pm2.

## Обновление

Когда пришло сообщение, что вышла новая версия:

```bash
cd путь/к/cloudcli-fork
./scripts/update.sh
```

Скрипт по шагам: проверяет Node и незакоммиченные правки → `git fetch` и
показывает новые коммиты → `git merge --ff-only` → `npm install --include=dev`
→ `npm run build` → перезапускает службу.

Полезные режимы:

```bash
./scripts/update.sh --check        # только посмотреть, что нового, ничего не менять
./scripts/update.sh --no-restart   # обновить и собрать, перезапустить самому
npm run update                     # то же, что ./scripts/update.sh
```

### Настройка перезапуска под свою систему

Скрипт сам ищет, как перезапустить приложение: systemd-служба `cloudcli-fork`
(user-scope) → pm2-процесс `cloudcli-fork` → launchd. Если у вас иначе — он
честно скажет, что не нашёл способ, и остановится после сборки (код при этом
уже обновлён и собран).

Тогда заведите локальный конфиг — он у каждого свой и в git не попадает:

```bash
cp scripts/update.local.conf.example scripts/update.local.conf
```

и раскомментируйте нужное:

```bash
CLOUDCLI_SERVICE=my-cloudcli          # другое имя systemd-службы или pm2-процесса
CLOUDCLI_SERVICE_SCOPE=system         # systemctl --system вместо --user
CLOUDCLI_LAUNCHD_LABEL=com.goldjaxe.cloudcli   # macOS launchd

# универсальный запасной вариант — подойдёт для чего угодно:
CLOUDCLI_RESTART_CMD="docker compose restart cloudcli"
```

## Частые проблемы

**`ошибка: закоммитьте, спрячьте или откатите их перед обновлением`**
В рабочей копии есть локальные правки, и обновление их бы затёрло. Если правки
не нужны: `git checkout .` Если нужны: `git stash`, обновиться, потом
`git stash pop`.

**`быстрая перемотка невозможна — ветка разошлась`**
В вашу копию попали коммиты, которых нет в зеркале. Если своих наработок нет,
проще всего сбросить копию к зеркалу:

```bash
git fetch origin main
git reset --hard origin/main
```

> `reset --hard` безвозвратно удалит локальные коммиты и правки. Если сомневаетесь,
> сначала сделайте `git branch backup-$(date +%F)` — это сохранит текущее
> состояние в отдельной ветке.

**Сборка падает на `vite: not found` или `tsc: not found`**
Установлены только production-зависимости. Лечится: `npm install --include=dev`.
Причина в том, что при `NODE_ENV=production` npm по умолчанию пропускает
devDependencies, а сборка без них невозможна.

**Порт занят**
Кто-то уже слушает порт. Найдите процесс: `ss -ltnp | grep 3001` (Linux) или
`lsof -i :3001` (macOS). Либо запустите на другом порту: `SERVER_PORT=3010`.

**Служба не поднялась после обновления**
Смотрите логи: `journalctl --user -u cloudcli-fork -n 50` (systemd) или
`pm2 logs cloudcli-fork` (pm2).
