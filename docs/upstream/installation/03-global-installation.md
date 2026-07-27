> Источник: https://cloudcli.ai/docs/installation/global-installation — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Install CloudCLI Globally via npm

## Overview

CloudCLI offers a global npm installation method for easy access across your system. The documentation explains the complete installation, configuration, and management process.

## Installation Steps

To install CloudCLI globally, run:

```bash
npm install -g @siteboon/claude-code-ui
```

Once installed, start the server with:

```bash
cloudcli
```

The service launches at `http://localhost:3001` by default.

## Available Commands

The CLI provides several useful commands:

| Command | Purpose |
|---------|---------|
| `cloudcli` | Start the server |
| `cloudcli start` | Explicitly start the server |
| `cloudcli status` | Display configuration and data locations |
| `cloudcli update` | Upgrade to the latest version |
| `cloudcli version` | View version details |
| `cloudcli help` | Display help information |
| `cloudcli -p 8080` | Launch on a custom port |

## Maintenance Operations

**Updating:** Run `cloudcli update` to fetch the latest release.

**Uninstalling:** Remove the package with `npm uninstall -g @siteboon/claude-code-ui`.

## Background Service Setup

For persistent operation, the documentation recommends using PM2:

1. Install PM2 globally: `npm install -g pm2`
2. Start as a service: `pm2 start cloudcli --name "cloudcli-ui"`
3. Enable auto-restart: Run `pm2 startup` followed by `pm2 save`

Key PM2 commands include viewing logs, stopping, restarting, and removing services.

## Configuration

For global installations, "environment variables are set in your shell profile rather than a `.env` file."
