> Источник: https://cloudcli.ai/docs/cloudcli-development-resources/network-architecture — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Network Architecture Guide — CloudCLI UI

## Overview

This documentation explains how CloudCLI's frontend and backend systems communicate across different development and production scenarios.

## High-Level Architecture

CloudCLI operates in two distinct modes:

**Development Mode:**
- Backend server runs on `SERVER_PORT` (default: 3001)
- Vite frontend dev server runs on `VITE_PORT` (default: 5173)
- Browser loads frontend from Vite, which proxies API and WebSocket traffic to backend

**Production/Built Mode:**
- Single backend server required
- Backend serves built frontend from `dist/`
- All traffic (API, frontend, WebSockets) originates from same source

## Configuration Sources

Network settings derive from these sources in order of precedence:

1. CLI options or shell environment variables
2. `.env` file (root directory)
3. Hardcoded defaults in code

Key variables include `SERVER_PORT`, `VITE_PORT`, and `HOST`.

## HOST Binding Explained

The `HOST` variable controls network interface binding:

- `127.0.0.1` / `localhost`: Localhost-only access
- `0.0.0.0`: All local interfaces (network-accessible)

Important note: `0.0.0.0` is a bind address only—"clients never browse to http://0.0.0.0:3001" but instead use actual addresses like `http://localhost:3001`.

## Backend Architecture

Located in `server/index.js`, the backend includes:

- Express application
- Shared HTTP server
- Attached WebSocket server

**WebSocket Endpoints:**
- `/ws`: Chat/session realtime channel
- `/shell`: Terminal/shell realtime channel

Both WebSocket paths share the backend HTTP server.

## Frontend Dev Server

Configured in `vite.config.js`, Vite proxies:

- `/api` → backend
- `/ws` → backend WebSocket
- `/shell` → backend WebSocket

**Request Routing:**
- From `:5173`: Browser → Vite → Backend
- From `:3001`: Browser → Backend directly

When accessing `http://localhost:3001`, the backend checks for built files (`dist/index.html`), serving them directly or redirecting to Vite dev server if absent.

## Network Interface Enumeration

When `HOST=0.0.0.0`, Vite exposes the server through multiple local interfaces (Wi-Fi, Ethernet, VPN, virtual adapters) while maintaining a single port.
