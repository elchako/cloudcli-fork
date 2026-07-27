> Источник: https://cloudcli.ai/docs/mcp-servers/remote-http-mcp-servers — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Remote HTTP MCP Server Examples

## Overview

CloudCLI documentation covers integrating popular hosted MCP servers. Users can add these through **Settings > Configuration > MCP** by selecting **HTTP** and entering the URL with appropriate authentication.

## Supported MCP Servers

### GitHub MCP
GitHub's server facilitates repository management, issue tracking, pull requests, and Actions workflows. Configuration requires OAuth or a static bearer token with a personal access token. The documentation recommends using minimal token permissions aligned with specific needs.

### Supabase MCP
This platform enables project management, database queries, and schema inspection. Setup uses OAuth authentication with optional URL scoping via `project_ref` and `read_only` parameters to restrict access to specific projects.

### Stripe MCP
Stripe's integration supports API workflows through OAuth or restricted API keys. The guidance emphasizes sandbox testing before live mode deployment and restricting keys to necessary resources.

### Context7 MCP
Context7 delivers library documentation to coding agents. It's configured as organization-wide since documentation lookup benefits all team members. Authentication uses static headers with an API key.

## Security Recommendations

The documentation emphasizes several practices: preferring OAuth over broad secrets, distinguishing between user and organization-wide servers, implementing per-member OAuth for individualized access, scoping provider URLs when possible, and rotating static tokens regularly.
