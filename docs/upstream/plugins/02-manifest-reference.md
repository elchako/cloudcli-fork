> Источник: https://cloudcli.ai/docs/plugins/manifest-reference — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Plugin Manifest Reference — CloudCLI UI

## Overview

Every CloudCLI plugin requires a `manifest.json` file in its root directory. This configuration file describes the plugin to the host system and controls loading and display behavior.

## Complete Example

```json
{
  "name": "project-stats",
  "displayName": "Project Stats",
  "version": "2.0.0",
  "description": "Scans the current project and shows file counts, lines of code, and file-type breakdown.",
  "author": "Claude Code UI",
  "icon": "BarChart3",
  "type": "module",
  "slot": "tab",
  "entry": "dist/index.js",
  "server": "dist/server.js",
  "permissions": []
}
```

## Required Fields

### `name`
- **Type:** string
- **Validation:** Must match `/^[a-zA-Z0-9_-]+$/`

The unique identifier for your plugin, used for configuration, routing, and directory naming. Only letters, numbers, hyphens, and underscores are permitted. Use kebab-case by convention (e.g., `my-awesome-plugin`).

### `displayName`
- **Type:** string

The human-readable name displayed in the tab bar and Settings panel. Can include any characters, spaces, and emoji.

### `entry`
- **Type:** string

Path to the compiled frontend entry file relative to the plugin root. Must be a JavaScript file exporting `mount()` and optionally `unmount()` functions. For TypeScript plugins, this points to compiled output in `dist/`.

## Optional Fields

### `version`
- **Type:** string
- **Default:** `"0.0.0"`

Semantic version string displayed in plugin settings. Purely informational.

### `description`
- **Type:** string
- **Default:** `""`

Short description shown below the plugin name in Settings (keep under 120 characters).

### `author`
- **Type:** string
- **Default:** `""`

Plugin creator name displayed in the plugin card.

### `icon`
- **Type:** string
- **Default:** `"Puzzle"`

Icon displayed in the tab bar. Use built-in Lucide Icons names or provide a path to a custom SVG file.

**Built-in icon options:** Puzzle, Box, Database, Globe, Terminal, Wrench, Zap, BarChart3, Folder, MessageSquare, GitBranch

### `type`
- **Type:** string
- **Default:** `"module"`

Set to `"module"`. Your compiled entry file loads as an ES module exporting `mount(container, api)` and optionally `unmount(container)`.

### `slot`
- **Type:** `"tab"`
- **Default:** `"tab"`

Specifies where the plugin appears in the UI. Currently only `tab` is supported.

### `server`
- **Type:** string | null
- **Default:** null

Path to a compiled Node.js server entry file relative to the plugin directory. When set, the host spawns this as a managed subprocess and proxies RPC calls to it. Omit for frontend-only plugins.

### `permissions`
- **Type:** string[]
- **Default:** `[]`

Reserved for future use for declaring required capabilities. Currently set to empty array or omit entirely.

## Validation Rules

| Rule | Error Message |
|------|---------------|
| Must be valid JSON object | `Invalid manifest: not a JSON object` |
| `name` required and string | `Missing required field: name` |
| `displayName` required and string | `Missing required field: displayName` |
| `entry` required and string | `Missing required field: entry` |
| `name` matches pattern | `Invalid plugin name: must only contain...` |

## Minimal Manifest

```json
{
  "name": "my-plugin",
  "displayName": "My Plugin",
  "entry": "dist/index.js"
}
```

## Next Steps

- **Frontend API Reference** — Details on what `mount()` receives
- **Backend Servers** — Adding a server subprocess
- **Example: Project Stats** — Real manifest implementation

---

*Last updated March 18, 2026*
