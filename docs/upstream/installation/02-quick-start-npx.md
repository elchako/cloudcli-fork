> Источник: https://cloudcli.ai/docs/installation/quick-start-npx — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# CloudCLI Quick Start Guide

## Overview

CloudCLI provides a rapid deployment option requiring no installation. The documentation explains how to launch the UI locally using a single command and access it from various devices.

## Key Setup Instructions

**Basic Launch Command:**
The guide instructs users to run `npx @siteboon/claude-code-ui` to start the server, which becomes accessible at `http://localhost:3001`. The tool automatically discovers existing sessions stored in the `~/.claude` folder.

**Port Configuration:**
Should port 3001 already be occupied, users can specify an alternative using the `--port` flag, such as `npx @siteboon/claude-code-ui --port 8080`.

**Remote Access:**
The documentation notes that once running, "open `http://[your-machine-ip]:3001` in any browser on the same network" to access from mobile devices without requiring VPN or tunneling services.

**Server Management:**
The guide indicates users should press `Ctrl+C` to halt the server and rerun the command to restart it.

## Prerequisites and Next Steps

The documentation references prerequisite requirements before proceeding. For regular use, the guide recommends considering global installation for shorter startup commands, or background service configuration for production environments requiring continuous operation.
