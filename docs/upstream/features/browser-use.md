> Источник: https://cloudcli.ai/docs/features/browser-use — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Browser Use - Visual Browser Sessions for CloudCLI Agents

## Overview

Browser Use enables CloudCLI agents to operate within real browser environments, allowing them to inspect rendered web pages, verify UI behavior, and facilitate handoff to users for authentication steps.

## Core Functionality

The feature provides agents with visual inspection capabilities. As the documentation states, "Browser Use gives an agent eyes and hands in a browser" to load sites, interact with pages, and report on visible elements or issues.

This proves valuable for tasks requiring rendered output assessment: debugging frontend problems, reviewing staging environments, confirming visual modifications, or pausing for user-completed login or MFA procedures.

## Browser Engine Options

**Playwright**: Designed for automated verification tasks without live viewer capability. Suitable for public pages and deterministic workflows.

**Camoufox + noVNC**: Supports live session viewing and manual takeover. The documentation notes this backend is "useful for login-gated apps, MFA, approval prompts, and workflows where the agent should continue after a human completes a step."

## Configuration

Users can enable Browser Use through Settings by:
- Activating agent browser access
- Selecting a browser engine
- Optionally enabling login persistence

## Session Management

Sessions represent active browser processes with finite lifespans tied to runtime activity. Persistent profiles, stored at `~/.cloudcli/browser-use/profiles`, allow cookie and storage reuse across sessions when explicitly enabled.

## Security Considerations

The documentation advises: "enable it only when you want agents to use browser automation" and recommends using temporary sessions for sensitive operations rather than persistent profiles for private dashboards or billing systems.
