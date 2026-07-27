> Источник: https://cloudcli.ai/docs/open-source-self-hosting/open-source-overview — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Installation Overview — CloudCLI UI

CloudCLI UI is a self-hostable web interface for Claude Code and Cursor that manages coding sessions, browses files, and runs agents from any browser.

## Options at a Glance

| Option | Best for | Setup |
|--------|----------|-------|
| Quick Start (npx) | Trying it out | `npx @siteboon/claude-code-ui` |
| Install via npm | Daily use from your machine | `npm install -g @siteboon/claude-code-ui` |
| Install via npm + PM2 | Always-on UI on local network | PM2 process manager |
| Local Development | Contributing or testing unreleased features | `git clone` + `npm run dev` |
| Remote Server | Access from anywhere without keeping laptop on | VPS or cloud server |

## Choosing the right option

**Quick trial**: Run `npx @siteboon/claude-code-ui` with no persistent installation.

**Daily usage**: Install globally with `npm install -g @siteboon/claude-code-ui` and update via `npm update -g`.

**Always-on access**: Pair global installation with PM2 for persistence across reboots and crashes.

**Development contributions**: Clone the GitHub repository and run `npm run dev` for hot reload and early feature access.

**Remote access**: Deploy to a VPS with HTTPS configuration for access from any device without maintaining your local machine.

## After you install

- The UI launches on `http://localhost:3001` by default
- Auto-discovers Claude Code sessions in `~/.claude/projects`
- Configure behavior through environment variables

## Switching between install methods

Multiple installations can coexist by using different ports—set `PORT=3001` for one instance and `PORT=3002` for another in their respective `.env` files.

## Getting started

Begin with the quick start option. Progress to global npm installation for daily work. Add PM2 for background operation. Consider CloudCLI Cloud if you need device-agnostic access without server management.
