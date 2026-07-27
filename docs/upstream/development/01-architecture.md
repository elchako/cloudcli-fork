> Источник: https://cloudcli.ai/docs/cloudcli-development-resources/architecture — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Architecture Overview - CloudCLI UI

## Stack Overview

CloudCLI employs a modern full-stack architecture. The frontend uses "React 18, Vite, Tailwind CSS, CodeMirror, xterm.js" while the backend runs on "Node.js, Express, TypeScript/JavaScript hybrid under `server/`". Data persists through "better-sqlite3" handling users, API keys, projects, sessions, and settings.

## Repository Structure

The codebase divides into clear sections:

- **Frontend** (`src/`): React components organized by feature (chat, sidebar, file tree, git, MCP)
- **Backend** (`server/`): Express modules handling HTTP routes, WebSocket connections, and provider runtimes
- **Persistence** (`server/modules/database/`): SQLite schema managing all application state
- **Build output**: `dist/` for frontend and `dist-server/` for compiled backend

## Request Flow

The Express application in `server/index.js` serves as the composition root. It initializes the database, creates a WebSocket server, registers routes, applies authentication middleware, and serves static files and the React app.

## Frontend Organization

Components organize by product feature rather than generic type:

| Area | Purpose |
|------|---------|
| `chat` | Provider chat UI and live event handling |
| `sidebar`/`main-content` | Project navigation and workspace layout |
| `file-tree`/`code-editor` | File browsing and editing |
| `git-panel` | Git operations and diffs |
| `mcp` | MCP server management |
| `browser-use` | Browser automation viewer |

## Backend Modules

Newer modules follow a structured pattern:

- **database**: SQLite operations and schema
- **projects**: Project discovery and session aggregation
- **providers**: Provider registry supporting Claude, Codex, Cursor, Gemini, and OpenCode
- **websocket**: Unified gateway for chat, shell, plugins, and Browser Use
- **browser-use**: Browser automation integration

## Provider System

CloudCLI abstracts provider-specific behavior through a registry supporting "Claude, Codex, Cursor, Gemini, and OpenCode." Each provider implements facets for authentication, MCP configuration, skills, and session management.

## Sessions and Persistence

Sessions maintain dual identities: a stable CloudCLI `session_id` and a provider-native `provider_session_id`. This separation allows the UI to preserve session continuity regardless of provider-side changes.

## WebSocket Gateway

A single WebSocket server handles multiple connection types:

| Path | Function |
|------|----------|
| `/ws` | Chat streaming protocol |
| `/shell` | Interactive terminal sessions |
| `/plugin-ws/:pluginName` | Plugin proxy |
| Browser Use viewer path | Browser automation viewer |

## Authentication Layers

CloudCLI implements multiple security boundaries including API-key validation, JWT authentication, WebSocket auth, and Browser Use viewer tokens. Filesystem operations validate paths against project roots.

## Plugins and Browser Use

Plugin support manages plugin lifecycle through a backend loader and process manager. Browser Use integrates as a dedicated module with its own routes, session management, and viewer authentication model.

## Deployment Modes

The application supports local development, built servers, npm packaging, remote self-hosting, and containerized cloud environments while maintaining consistent API and WebSocket interfaces across all modes.
