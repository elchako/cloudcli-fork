# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.

## Завершение работы в отдельном рабочем дереве (worktree)

- Дополнительное рабочее дерево временное. После принятия и слияния доработки в целевую ветку проекта (`dev`, `main`, `master` или явно согласованную другую) в той же сессии останови его локальный демонстрационный сервер и удали каталог дерева. Не оставляй завершённые копии рядом с основным проектом.
- Перед удалением обнови ссылки нужного удалённого репозитория и проверь, что `HEAD` дерева входит в целевую ветку: `git merge-base --is-ancestor <HEAD-дерева> <целевая-ветка>`. При squash или rebase отдельно подтверди сохранность всех изменений. Одного имени задачи, наличия ветки на сервере или сообщения о слиянии недостаточно.
- Проверь `git status --porcelain=v1 --untracked-files=all`, а также игнорируемые файлы: настройки, локальные базы, выгрузки и результаты работы могут не попадать в Git. Уникальные нужные данные сначала сохрани вне удаляемого дерева, секреты не добавляй в репозиторий. Невлитые коммиты, незакоммиченные изменения и спорные копии оставляй с указанием причины.
- Убедись, что дерево не используется другой активной сессией или задачей. Демонстрационный сервер останавливай только по проверенному PID, рабочему каталогу и порту, без широкого `pkill -f`. Общие службы и серверы других проектов не трогай. Проверь, что процесс завершён и его порт больше не занят этим сервером.
- Выйди из удаляемого каталога и выполни `git -C <основной-проект> worktree remove <путь>`. Не применяй `--force`, `git clean -fdx`, `reset --hard` или `rm -rf` для обхода проверки. Отдельный клон проверяй как самостоятельный репозиторий, а не как worktree. Ветки без отдельного запроса не удаляй.
- После уборки проверь `git worktree list` и отсутствие удалённого каталога. Устаревшие записи отсутствующих деревьев сначала просмотри через `git worktree prune --dry-run`; не удаляй записи временно недоступных или заблокированных деревьев. В итоговом ответе укажи удалённые деревья, остановленные серверы и то, что сохранено с причиной.
