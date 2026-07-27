> Источник: https://cloudcli.ai/docs/plugins/example-project-stats — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Example: Project Stats Plugin — CloudCLI UI

## Overview

This documentation walks through the `hello-world` example plugin, which demonstrates patterns for building dashboards with file scanning, caching, and theme-aware rendering within CloudCLI.

## What It Does

The plugin performs five key operations:

1. Reads the current project directory from `api.context.project.path`
2. Calls a backend endpoint via RPC to scan the directory
3. Walks the file tree to count files and calculate lines of code
4. Renders an animated dashboard displaying statistics
5. Detects project switches and reloads automatically

## Plugin Structure

### Manifest Configuration

The plugin declares itself with standard metadata:

```json
{
  "name": "hello-world",
  "displayName": "Project Stats",
  "version": "2.0.0",
  "description": "Scans the current project and shows file counts, lines of code, file-type breakdown.",
  "author": "Claude Code UI",
  "icon": "icon.svg",
  "type": "module",
  "slot": "tab",
  "entry": "index.js",
  "server": "server.js"
}
```

## Frontend Implementation Patterns

### Style and Font Injection

Styles are injected once with ID-based deduplication to prevent duplicate loading.

### Client-Side Caching Strategy

The frontend maintains a cache keyed by project path. When the project remains unchanged, cached results render immediately without fetching new data. New scans occur only when switching projects.

### Animated Metrics

Numbers animate from zero to their target values using cubic easing over 900ms, creating visual polish.

### Theme Adaptation

The plugin uses CSS custom properties that adjust based on the active theme (dark or light mode), enabling instant switching without reloads.

## Backend Implementation Patterns

### Server Setup

A Node.js HTTP server starts on a random local port and logs readiness with JSON output for process management.

### Safety Constraints

Scanning respects hard limits:
- Maximum 5,000 files processed
- Maximum recursion depth of 6 levels
- Excludes common non-source directories (node_modules, .git, dist, build, etc.)

### Text File Filtering

Line counting applies only to recognized source file extensions and skips files exceeding 256KB.

### Response Structure

The backend returns structured JSON containing file counts, line totals, extension breakdowns, largest files, and recently modified entries.

## Installation Options

**Direct Installation:** Copy the example folder to `~/.claude-code-ui/plugins/hello-world` and refresh settings.

**Git-Based Installation:** Initialize a git repository, commit the code, push to a remote, then install via the settings interface.

## Key Design Patterns Summary

| Pattern | Location |
|---------|----------|
| Caching logic | Frontend `load()` function |
| Loading states | `renderLoading()` handler |
| No-project handling | `renderNoProject()` function |
| Theme support | Context change callbacks |
| Count animation | `animateCount()` utility |
| Safety limits | Backend constants |
| Directory exclusions | `SKIP_DIRS` configuration |
| Cleanup | `unmount()` function |
