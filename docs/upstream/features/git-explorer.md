> Источник: https://cloudcli.ai/docs/features/git-explorer — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Git Explorer — Browse, Diff and Commit in CloudCLI

## Overview

CloudCLI includes a built-in Git explorer enabling developers to manage repositories directly within the interface. This feature is particularly useful for reviewing agent-committed changes or staging specific modifications before committing.

## What You Can Do

- **View changed files** — see which files have been modified, added, or deleted
- **Review diffs** — inspect changes file by file before staging
- **Stage files** — select specific files or hunks to include in a commit
- **Commit** — write a commit message and commit directly from the UI
- **Switch branches** — checkout existing branches without using the terminal

## Typical Workflow With an Agent

1. Give the agent a task in the chat
2. The agent makes changes across multiple files
3. Open the Git explorer to review what changed
4. Stage the files you want to keep
5. Write a commit message and commit

This process provides a clean review step between the agent's work and your repo history.

## Accessing Git on Mobile

The Git explorer is accessible from the bottom navigation bar on mobile devices. All core operations (diff, stage, commit, branch switch) function on touch devices.

## Related Resources

- [File Explorer & Editor](/docs/file-explorer) — browse and edit project files with syntax highlighting
- [Tools & Permissions](/docs/tools-and-permissions) — control which tools your AI coding agents can use

**Last updated:** April 24, 2026
