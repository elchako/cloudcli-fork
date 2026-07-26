# GOLDJAXE — форк CloudCLI (siteboon/claudecodeui)

Форк холдинга GOLDJAXE поверх `siteboon/claudecodeui` (upstream, GPL v3).
CloudCLI = единая удалённая рабочая среда: Claude Code + MCP + скилы + браузер,
доступ преимущественно с телефона по Tailscale.

## Зачем форк

Часть доработок под холдинг невозможно сделать плагином (Plugin API изолирован:
`slot:'tab'`, не переопределяет встроенный композер, хуки, i18n, middleware ядра).
Такие правки живут в форке и параллельно отправляются PR в upstream на мерж
(гибрид «форк-до-мержа»).

## Ветка доработок

`feat/goldjaxe-improvements` — от `27eaf01 chore(release): v1.36.3`.

## Roadmap (по волнам)

- **Волна 1** — нативный показ картинок в чате (`img`-override с авторизацией);
  прикрепление любых файлов, не только картинок.
- **Волна 2** — фикс мобильного переключателя уровня рассуждений (effort).
- **Волна 3** — перенос пользовательских настроек из `localStorage` в БД (per-user),
  голосовой apiKey — в шифрованный `user_credentials`, одноразовая миграция.
- **Отложено** — управление ПК (отдельный крупный проект).

Каждая правка: код → сборка/typecheck/lint/браузер-проверка → commit.

## Upstream

```
git remote -v   # origin = https://github.com/siteboon/claudecodeui.git
```
PR отправляются в `siteboon/claudecodeui`. При обновлении upstream —
rebase ветки доработок, минимизируя расхождение.
