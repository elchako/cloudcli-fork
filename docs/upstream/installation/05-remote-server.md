> Источник: https://cloudcli.ai/docs/installation/remote-server — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Self-hosting on a Remote Server — CloudCLI UI

## Overview

The page describes how to deploy CloudCLI UI on your own infrastructure, offering alternatives to the managed CloudCLI Cloud service.

## Setup Instructions

Users can deploy CloudCLI to a VPS by:

1. Spinning up a server (Hetzner, DigitalOcean, Linode, etc.)
2. Installing Node.js v22+
3. Running the installation command:

```bash
npm install -g @siteboon/claude-code-ui
```

The UI runs on `http://your-server-ip:3001` and can be accessed from any device. The documentation references a separate guide for running it as a background service using PM2.

## Security Considerations

A key limitation is noted: "CloudCLI UI does not include built-in authentication." The recommendation is to place it behind a reverse proxy with authentication, using tools like Caddy or nginx. An example configuration using Caddy with basic auth is provided.

## Temporary Access Options

For short-term remote access without dedicated infrastructure, two tools are mentioned:

- **cloudflared** (free tunnel service)
- **ngrok**

Both generate temporary public URLs, though the documentation cautions against relying on this approach long-term.

## CloudCLI Cloud Alternative

The page emphasizes that CloudCLI Cloud offers a managed alternative starting at $7/month, eliminating setup complexity and providing features like team access and audit logs.
