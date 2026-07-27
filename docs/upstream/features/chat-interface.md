> Источник: https://cloudcli.ai/docs/features/chat-interface — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Chat Interface — CloudCLI Documentation

## Overview

CloudCLI provides two interaction methods for AI coding agents: a responsive chat UI and a direct shell terminal interface.

## Chat Mode

The chat interface streams real-time responses from agents like Claude Code, Cursor CLI, Codex, or Gemini CLI via WebSocket.

**Key features include:**

- Resume previous conversations from any checkpoint
- Create new sessions within project directories
- Permanent message storage with timestamps
- Direct file references with highlighting
- Syntax-highlighted code blocks with copy functionality
- Extended thinking capability for Claude models
- Inline tool request approval/denial options

## Shell Mode

Users can access a full terminal connected to the agent's CLI by selecting the shell icon in the chat toolbar, replicating the experience of running `claude` locally with complete keyboard support.

**Recommended uses:**

- Passing CLI flags directly
- Executing commands unavailable through chat
- Viewing raw output from extended-running tasks

---

**Last updated:** April 24, 2026
