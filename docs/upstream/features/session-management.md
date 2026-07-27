> Источник: https://cloudcli.ai/docs/features/session-management — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Session Management — CloudCLI UI

## Overview

CloudCLI UI organizes AI coding agent sessions into projects, providing centralized management across multiple platforms.

## Key Features

### Session Discovery
"All existing sessions appear automatically so you don't need to do anything to make them available." Sessions created in the interface become instantly accessible via terminal commands like `claude -r`.

### Project Organization
The system automatically generates project entries for directories containing sessions and displays session counts per project. Users can rename, delete, or create new projects directly from the UI by specifying a directory or importing from GitHub.

### Session Management Capabilities
Within each project, users can:
- Resume previous conversations
- Rename sessions for improved discoverability
- Remove unnecessary sessions
- Access complete history with timestamps and metadata

### Cross-Device Access

**Self-Hosted Deployment:** Sessions reside locally on your machine, accessible via browser across your network using the format `[yourip]:port`.

**CloudCLI Cloud:** Sessions are stored in cloud infrastructure, enabling access from any device, IDE, or through API integration. The platform supports running Claude Code remotely in persistent sessions that maintain continuity across reboots and network interruptions. Mobile access is also available for managing sessions via phone.

---

*Last updated April 24, 2026*
