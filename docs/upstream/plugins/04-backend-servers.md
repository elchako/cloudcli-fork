> Источник: https://cloudcli.ai/docs/plugins/backend-servers — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Plugin Backend Servers — CloudCLI UI

Plugins can include a backend server that runs as a managed Node.js subprocess. This gives plugins access to the filesystem, databases, external APIs, and other Node.js capabilities while the host handles process management, authentication, and secret injection.

## When Do You Need a Server?

A backend server is necessary for:
- Accessing the filesystem (scanning files, reading configs)
- Calling external APIs with secret keys
- Running long computations or background tasks
- Storing state between tab opens

A server is not needed for displaying static UI or reading context information.

## The Readiness Protocol

The critical requirement: print a JSON ready signal to stdout in this format:

```json
{"ready": true, "port": 3456}
```

The host waits 10 seconds for this signal. If it doesn't arrive, the process is terminated.

## Process Lifecycle

**Startup:**
1. The host spawns `node <server-entry>` in your plugin directory
2. Only PATH, HOME, NODE_ENV, and PLUGIN_NAME environment variables are available
3. The host reads stdout for the ready signal
4. On success, RPC calls route to this port; on timeout, the process is killed

**During Runtime:**
- The server stays running while the plugin is enabled
- RPC requests arrive as standard HTTP requests
- Crashed processes are removed; lazy-restarts occur on next call

**Shutdown:**
- SIGTERM is sent with 5 seconds for cleanup
- After 5 seconds, SIGKILL is sent (force kill)

## Secrets Management

Secrets are configured in `~/.claude-code-ui/plugins.json` but are NOT passed as environment variables. Instead, they're injected as HTTP headers on every RPC request:

```
x-plugin-secret-apikey: sk-abc123
```

Header naming: prefix `x-plugin-secret-` with lowercased keys.

This approach ensures per-request injection, eliminates restart requirements for updates, and prevents leakage to child processes.

## Environment Variables

Servers receive a restricted set:
- PATH
- HOME
- NODE_ENV
- PLUGIN_NAME

All other host environment variables are stripped for security.

## Dependencies

Add a `package.json` to your plugin directory. The host runs `npm install --ignore-scripts` then `npm run build` if a build script exists. Postinstall scripts are not executed.
