> Источник: https://cloudcli.ai/docs/configuration/tools-and-permissions — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Tools & Permissions — CloudCLI UI

## Overview

CloudCLI's documentation page explains how to manage tool permissions for Claude Code. The system operates on a security-first principle where capabilities are disabled by default.

## Key Points

**Default Security Model**
"All Claude Code tools are **disabled by default**." This intentional restriction prevents unintended harmful operations until users explicitly grant permission.

**Enabling Tools**
Users access tool settings via a gear icon in the sidebar, toggle desired capabilities, and preferences persist locally across sessions.

**Available Tools**

| Category | Function | Risk |
|----------|----------|------|
| Read | File content retrieval | Low |
| Glob/Grep/LS | File search operations | Low |
| Edit/Write | File modification | Medium |
| Bash | Shell command execution | High |
| Bash(git log:*) | Scoped git commands | Low |
| WebFetch/WebSearch | Internet access | Medium |
| Task | Sub-agent spawning | Medium |

**Scoped Bash Permissions**
Rather than enabling all bash access, administrators can restrict permissions to specific commands like `npm run lint` or `git log:*` while denying others like `curl`.

**Settings Architecture**
Permissions sync to `~/.claude/settings.json` and can be scoped globally or per-project (`.claude/settings.json`). Project-scoped settings can be version-controlled for team alignment.
