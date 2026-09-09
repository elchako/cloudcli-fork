#!/usr/bin/env bash
# Обновление форка CloudCLI из git + пересборка + перезапуск службы.
#
# Системы у всех разные, поэтому скрипт НИЧЕГО не предполагает:
# способ перезапуска определяется автоматически либо задаётся явно
# в scripts/update.local.conf (файл не коммитится).
#
# Использование:
#   ./scripts/update.sh              # обновить и перезапустить
#   ./scripts/update.sh --no-restart # только обновить и собрать
#   ./scripts/update.sh --check      # только показать, есть ли обновления
#
# Настройка (scripts/update.local.conf или переменные окружения):
#   CLOUDCLI_SERVICE=cloudcli-fork      имя systemd-службы
#   CLOUDCLI_SERVICE_SCOPE=user|system  scope systemd (по умолчанию user)
#   CLOUDCLI_RESTART_CMD="..."          своя команда перезапуска (важнее всего)
#   CLOUDCLI_BRANCH=main                ветка для pull (по умолчанию текущая)
#   CLOUDCLI_REMOTE=origin              remote для pull

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- цвета (отключаются, если вывод не в терминал) ---
if [ -t 1 ]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[1m'; N=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; N=''
fi
info() { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s  !!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '%s ERR%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# --- локальный конфиг ---
[ -f scripts/update.local.conf ] && . scripts/update.local.conf

DO_RESTART=1
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-restart) DO_RESTART=0 ;;
    --check)      CHECK_ONLY=1 ;;
    -h|--help)    sed -n '2,20p' "$0"; exit 0 ;;
    *)            die "неизвестный аргумент: $arg" ;;
  esac
done

# --- предпосылки ---
command -v git  >/dev/null || die "git не найден"
command -v node >/dev/null || die "node не найден (нужен Node.js >= 22)"
command -v npm  >/dev/null || die "npm не найден"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "нужен Node.js >= 22, установлен $(node -v)"

REMOTE="${CLOUDCLI_REMOTE:-origin}"
git remote get-url "$REMOTE" >/dev/null 2>&1 || die "remote '$REMOTE' не настроен (см. docs/ru/install.md)"

BRANCH="${CLOUDCLI_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
[ "$BRANCH" != "HEAD" ] || die "detached HEAD — переключитесь на ветку: git checkout main"

# --- незакоммиченные правки останавливают обновление ---
if [ -n "$(git status --porcelain)" ]; then
  warn "есть незакоммиченные изменения:"
  git status --short
  die "закоммитьте, спрячьте (git stash) или откатите их перед обновлением"
fi

# --- что нового ---
info "проверяю обновления ($REMOTE/$BRANCH)"
git fetch "$REMOTE" "$BRANCH" --quiet

LOCAL="$(git rev-parse HEAD)"
UPSTREAM="$(git rev-parse "$REMOTE/$BRANCH")"

if [ "$LOCAL" = "$UPSTREAM" ]; then
  ok "уже актуальная версия ($(git rev-parse --short HEAD))"
  [ "$CHECK_ONLY" = 1 ] && exit 0
  # даже без новых коммитов имеет смысл убедиться, что сборка на месте
  if [ -f dist-server/server/index.js ] && [ -d dist ]; then
    exit 0
  fi
  warn "сборка отсутствует — пересобираю"
else
  COUNT="$(git rev-list --count HEAD.."$REMOTE/$BRANCH")"
  info "доступно новых коммитов: $COUNT"
  git --no-pager log --oneline --no-decorate HEAD.."$REMOTE/$BRANCH" | sed 's/^/     /'
  if [ "$CHECK_ONLY" = 1 ]; then
    printf '\nЗапустите без --check, чтобы обновиться.\n'
    exit 0
  fi
  info "подтягиваю изменения"
  git merge --ff-only "$REMOTE/$BRANCH" \
    || die "быстрая перемотка невозможна — ветка разошлась с $REMOTE/$BRANCH; разберитесь вручную"
  ok "теперь на $(git rev-parse --short HEAD)"
fi

# --- зависимости ---
# --include=dev обязателен: в проде NODE_ENV=production и npm иначе пропустит
# devDependencies, без которых не соберутся ни клиент (vite), ни сервер (tsc).
info "устанавливаю зависимости"
npm install --include=dev --no-audit --no-fund

# --- сборка ---
info "собираю клиент и сервер"
npm run build

# --- перезапуск ---
if [ "$DO_RESTART" = 0 ]; then
  ok "готово (перезапуск пропущен: --no-restart)"
  exit 0
fi

restart_service() {
  # 1. Явная команда из конфига — приоритет над любым автоопределением.
  if [ -n "${CLOUDCLI_RESTART_CMD:-}" ]; then
    info "перезапуск: CLOUDCLI_RESTART_CMD"
    eval "$CLOUDCLI_RESTART_CMD"
    return 0
  fi

  # 2. systemd (Linux). Проверяем, что служба реально существует, —
  #    в WSL и контейнерах systemd может быть недоступен.
  if command -v systemctl >/dev/null 2>&1; then
    local svc="${CLOUDCLI_SERVICE:-cloudcli-fork}"
    local scope="${CLOUDCLI_SERVICE_SCOPE:-user}"
    local flag="--user"
    [ "$scope" = "system" ] && flag="--system"
    if systemctl $flag list-unit-files "$svc.service" >/dev/null 2>&1 \
       && systemctl $flag cat "$svc.service" >/dev/null 2>&1; then
      info "перезапуск systemd-службы: $svc ($scope)"
      systemctl $flag restart "$svc"
      sleep 2
      if systemctl $flag is-active --quiet "$svc"; then
        ok "служба активна"
      else
        warn "служба не поднялась, логи:"
        journalctl $flag -u "$svc" -n 30 --no-pager 2>/dev/null || true
        return 1
      fi
      return 0
    fi
  fi

  # 3. pm2 — частый вариант на серверах и macOS.
  if command -v pm2 >/dev/null 2>&1; then
    local pm2name="${CLOUDCLI_SERVICE:-cloudcli-fork}"
    if pm2 describe "$pm2name" >/dev/null 2>&1; then
      info "перезапуск pm2-процесса: $pm2name"
      pm2 restart "$pm2name"
      ok "процесс перезапущен"
      return 0
    fi
  fi

  # 4. launchd (macOS).
  if command -v launchctl >/dev/null 2>&1 && [ -n "${CLOUDCLI_LAUNCHD_LABEL:-}" ]; then
    info "перезапуск launchd: $CLOUDCLI_LAUNCHD_LABEL"
    launchctl kickstart -k "gui/$(id -u)/$CLOUDCLI_LAUNCHD_LABEL"
    ok "служба перезапущена"
    return 0
  fi

  return 2
}

set +e
restart_service
rc=$?
set -e

case "$rc" in
  0) ok "обновление завершено: $(git rev-parse --short HEAD)" ;;
  2)
    warn "не нашёл, как перезапустить приложение на этой системе"
    cat <<'EOF'

Код обновлён и собран, но служба НЕ перезапущена — запустите вручную,
либо задайте способ перезапуска в scripts/update.local.conf, например:

  # systemd, служба называется иначе:
  CLOUDCLI_SERVICE=my-cloudcli

  # systemd system-scope вместо user:
  CLOUDCLI_SERVICE_SCOPE=system

  # или своя команда — подойдёт для чего угодно:
  CLOUDCLI_RESTART_CMD="pkill -f dist-server/server/index.js; nohup npm run server >/tmp/cloudcli.log 2>&1 &"

Подробности: docs/ru/install.md
EOF
    exit 1
    ;;
  *) die "перезапуск не удался" ;;
esac
