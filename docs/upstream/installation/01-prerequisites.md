> Источник: https://cloudcli.ai/docs/open-source-self-hosting/prerequisites — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# CloudCLI Self-Hosting Prerequisites

## Overview

CloudCLI UI requires specific software and services before you can self-host it. The documentation outlines two primary requirements: Node.js and at least one AI coding agent.

## Node.js Requirements

The platform demands "Node.js v22 or higher." Users can verify their current installation using the `node --version` command.

For installation or upgrades, the guide recommends using nvm (Node Version Manager). The installation commands provided are:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 22
nvm use 22
```

Alternatively, Node.js can be downloaded directly from nodejs.org.

## Supported AI Coding Agents

CloudCLI UI functions as a user interface layer for AI coding agents. The documentation lists four compatible options:

1. **Claude Code** — requires Claude Pro/Max subscription or Anthropic API key
2. **Cursor CLI** — requires Cursor subscription
3. **Codex** — requires OpenAI API key
4. **Gemini CLI** — requires Google account or API key

Each agent has corresponding npm installation commands provided in the documentation.

## Next Steps

After satisfying these prerequisites, users should consult the Installation Overview to select an appropriate deployment method.
