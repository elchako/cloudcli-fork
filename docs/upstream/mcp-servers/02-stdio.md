> Источник: https://cloudcli.ai/docs/mcp-servers/stdio-mcp-servers — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Local stdio MCP Server Examples

## Overview

CloudCLI documentation outlines configuring stdio MCP servers for AI coding agents. These run locally within each target environment rather than remotely. Users access configuration through Settings > Configuration > MCP, selecting stdio and entering command details.

## Key Server Examples

**Playwright MCP**
Enables browser automation and accessibility snapshots. Uses `npx @playwright/mcp@latest` with no typical environment variables needed.

**Filesystem MCP**
Grants file read/write capabilities in permitted directories. Configured with `npx -y @modelcontextprotocol/server-filesystem /workspace/<project>`, limiting access to specific paths for security.

**Stripe MCP**
Supports local API key usage via `npx -y @stripe/mcp@latest` with `STRIPE_SECRET_KEY` environment variable. "Use Stripe test mode first. For production, prefer a restricted key over a full secret key."

## When to Use HTTP Instead

The documentation recommends HTTP transport when official remote endpoints exist, OAuth integration is required, shared hosted solutions are preferred, or necessary software isn't installed in local environments.

## Important Note

"A stdio MCP server starts when the agent client starts. If you add or edit one, restart the agent session before testing it."
