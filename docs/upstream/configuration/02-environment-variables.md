> Источник: https://cloudcli.ai/docs/configuration/environment-variables — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Environment Variables — CloudCLI UI

## Getting Started

Initialize configuration by copying the example file:

```bash
cp .env.example .env
```

Then modify `.env` with your preferred settings.

## Precedence

Settings resolve in priority order (first match wins):

1. **CLI flags** — highest priority, one-shot overrides
2. **Process environment** — shell or supervisor variables
3. **`.env` file** — project defaults
4. **Built-in defaults** — fallback values

Example: `cloudcli --port 8080` overrides any `PORT` setting in `.env`.

## Available Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server listening port |
| `WORKSPACES_ROOT` | `~` | Root directory for project discovery |
| `ENABLE_HTTPS` | `false` | Enable HTTPS (requires cert setup) |

## Custom Port

Run on a different port via configuration or CLI:

```bash
# Via .env
PORT=8080

# Via CLI flag (overrides .env)
cloudcli --port 8080
```

Multiple instances on the same machine can coexist with distinct ports.

## Restricting Project Discovery

Limit discovery to a specific workspace:

```bash
WORKSPACES_ROOT=/home/user/projects
```

## Enabling HTTPS

```bash
ENABLE_HTTPS=true
```

Requires certificate paths. For remote deployments, use a reverse proxy (Caddy, Nginx, Traefik) for TLS.

## Production Tips

- Run under a process supervisor (PM2, systemd) for automatic restart capability
- Place a reverse proxy in front for HTTPS, compression, and logging
- Pin `WORKSPACES_ROOT` to specific directories; use `~` only for single-user setups

## Troubleshooting

**Port already in use:** Stop the conflicting process or assign a free port with `PORT=` or `cloudcli --port 8080`.

**Projects not appearing:** Verify `WORKSPACES_ROOT` points to your project directory.

**`.env` changes ignored:** Restart CloudCLI—variables load only at startup.
