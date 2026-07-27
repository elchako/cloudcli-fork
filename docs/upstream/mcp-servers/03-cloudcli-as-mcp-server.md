> Источник: https://cloudcli.ai/docs/mcp-servers/connect-cloudcli-to-ai-clients — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Use CloudCLI as an MCP Server

## Overview

CloudCLI offers a hosted MCP server enabling compatible assistants to manage your CloudCLI environments. This differs from configuring third-party MCP servers within your environments themselves.

## Authentication Methods

Two approaches are available:

**OAuth Flow** — Recommended for clients like claude.ai that use browser-based sign-in. The URL `https://cloudcli.ai/api/mcp` initiates automatic discovery and registration without requiring manual credential entry.

**API Key Authentication** — Suited for tools like Claude Code or Cursor. Users generate a dedicated key in Settings → Developer Access, then configure it as a Bearer token in their client's configuration.

## Available Capabilities

The initial release provides six security-reviewed operations:

- Environment listing and retrieval
- Environment creation and starting
- Environment termination (marked destructive for confirmation)
- Supported agent model enumeration

Notably absent are deletion, credential exposure, and direct agent execution features.

## Security Model

"CloudCLI generates the tool catalog from its OpenAPI definition, but an API operation appears only after an explicit MCP security opt-in." This means new API features require deliberate authorization before becoming accessible to agents.

Both authentication methods restrict access to account-owned environments using identical ownership verification as the main CloudCLI platform.

## Access Management

OAuth approvals appear in Developer Access under Authorized apps for revocation. API keys should be created individually per client to enable granular access control without disrupting other integrations.
