> Источник: https://cloudcli.ai/docs/plugins/plugin-overview — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Plugin System Overview — CloudCLI UI

## Overview

The CloudCLI UI plugin system enables developers to extend functionality through custom tabs. Each plugin is a Git-based project that runs both frontend code (in the browser) and optional backend services (Node.js).

## Where Plugins Appear

Plugins manifest in two locations:

1. **Tab bar** — Plugins add tabs alongside built-in ones (Chat, Shell, Files, Git, Tasks)
2. **Settings → Plugins** — Management interface for installation, updates, and configuration

## Plugin Capabilities

### Frontend Features

- Render custom UI components within plugin tabs
- Access current project name and filesystem path
- Receive active session ID and title
- Detect and adapt to theme changes (dark/light mode)
- Load CSS, images, fonts, and other assets

### Backend Features

- Full filesystem read and directory scanning capabilities
- External API integration with secure secret key injection
- Data processing and analysis operations
- npm package dependency support
- In-memory state caching
- WebSocket streaming for real-time data

## Plugin Limitations

Plugins cannot:

- "Modify the Chat, Shell, Files, Git, or Tasks tabs — plugins don't have access to the built-in UI"
- Send messages to Claude or interact with chat functionality
- Appear in sidebar, toolbar, or status bar areas
- Access other plugins or share data between plugins
- Read authentication tokens or session cookies
- Intercept or modify application requests

## Architecture

### Build Process

Plugins use TypeScript with compilation to ES modules. Installation triggers:

1. `npm install` — dependency resolution
2. `npm run build` — TypeScript compilation

### Communication Methods

**HTTP via `api.rpc()`** — Request/response calls proxied through `/api/plugins/:name/rpc/*`

**WebSocket via `/plugin-ws/:name`** — Bidirectional streaming with host authentication enforcement

## Directory Structure

```
~/.claude-code-ui/plugins/plugin-name/
├── manifest.json
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts (frontend)
│   └── server.ts (optional backend)
├── dist/ (compiled output)
└── icon.svg (optional)
```

## Installation and Management

**To install:** Navigate to Settings → Plugins, paste a Git repository URL, click Install.

**To manage:** Enable/disable toggles, update via refresh button, uninstall with confirmation.

Plugin state persists in `~/.claude-code-ui/plugins.json`.

## Available Plugins

| Plugin | Description |
|--------|-------------|
| **Project Stats** | File analysis and code metrics |
| **Web Terminal** | xterm.js terminal with multi-tab support |

Community plugins can be shared in GitHub Discussions for inclusion.
