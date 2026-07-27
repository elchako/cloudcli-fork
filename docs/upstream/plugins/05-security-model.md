> Источник: https://cloudcli.ai/docs/plugins/security-model — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Plugin Security Model — CloudCLI UI

## Overview

CloudCLI's plugin architecture implements multiple isolation layers to contain the risks inherent in running third-party code. The documentation emphasizes that "Plugins are trusted code. Installing a plugin is equivalent to running someone's Node.js code on your machine."

## Key Security Mechanisms

**Frontend Sandboxing**
Plugins receive only an `api` object and cannot access the host's React state, authentication tokens, other plugins' data, or browser storage. Code loads via dynamic import from a Blob URL, restricting module access.

**Process Isolation**
Each plugin server runs in its own Node.js process with limited environment variables (PATH, HOME, NODE_ENV, PLUGIN_NAME only). Servers must bind to localhost only. Lifecycle controls include a 10-second startup timeout, graceful shutdown with 5-second grace period, and SIGKILL fallback.

**Secret Handling**
Secrets stored in `~/.claude-code-ui/plugins.json` are injected as HTTP headers per request. They remain on localhost, are request-scoped rather than stored in memory, and are plugin-specific. However, they're stored in plaintext without automatic rotation.

**Installation Controls**
Only HTTPS and git URLs are accepted, with shallow clones enforced. Directory names validate against `/^[a-zA-Z0-9_.-]+$/`. NPM installations skip lifecycle scripts, with builds executed separately.

## Notable Limitations

The documentation candidly lists significant constraints: no CPU/memory enforcement, no filesystem sandboxing, unrestricted network access, and plaintext secret storage readable by anyone with filesystem access.
