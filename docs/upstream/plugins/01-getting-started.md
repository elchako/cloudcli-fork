> Источник: https://cloudcli.ai/docs/plugins/getting-started — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Getting Started with Plugins — CloudCLI UI

## Overview

This guide enables developers to build CloudCLI UI plugins from scratch using TypeScript, completing a functional tab plugin in approximately ten minutes.

## Prerequisites

- Running CloudCLI UI instance
- Node.js 18 or later
- Git installation
- GitHub or alternative Git hosting account

## Initial Setup

### Template-Based Approach

The official starter template at `cloudcli-ai/cloudcli-plugin-starter` on GitHub provides a pre-configured foundation. Using the "Use this template" feature creates a new repository. Following the naming convention `cloudcli-plugin-your-plugin-name` maintains consistency.

Installation proceeds via:
```bash
git clone https://github.com/yourname/cloudcli-plugin-my-first-plugin.git
cd cloudcli-plugin-my-first-plugin
npm install
```

### Manual Project Creation

Alternatively, create a fresh directory:
```bash
mkdir cloudcli-plugin-my-first-plugin
cd cloudcli-plugin-my-first-plugin
git init
npm init -y
```

## Configuration Files

### Manifest Structure

The `manifest.json` file defines plugin metadata:

```json
{
  "name": "my-first-plugin",
  "displayName": "My First Plugin",
  "version": "1.0.0",
  "description": "A simple plugin that shows project info and a greeting.",
  "author": "Your Name",
  "icon": "Zap",
  "type": "module",
  "slot": "tab",
  "entry": "dist/index.js",
  "server": "dist/server.js"
}
```

**Critical fields:**
- **name** — Unique identifier (alphanumeric, hyphens, underscores only)
- **entry** — Compiled frontend JavaScript location
- **server** — Backend Node.js file (optional; omit if unnecessary)

### TypeScript Configuration

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "lib": ["ES2020", "DOM"]
  },
  "include": ["src"]
}
```

Update `package.json`:

```json
{
  "name": "cloudcli-plugin-my-first-plugin",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "@types/node": "^20.0.0"
  }
}
```

Create `.gitignore`:
```
dist/
node_modules/
```

## Type Definitions

Create `src/types.ts`:

```typescript
export interface PluginContext {
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
}

export interface PluginAPI {
  readonly context: PluginContext;
  onContextChange(callback: (ctx: PluginContext) => void): () => void;
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface PluginModule {
  mount(container: HTMLElement, api: PluginAPI): void | Promise<void>;
  unmount?(container: HTMLElement): void;
}
```

## Frontend Implementation

Create `src/index.ts`:

```typescript
import type { PluginAPI, PluginContext } from './types.js';

export function mount(container: HTMLElement, api: PluginAPI): void {
  const ctx: PluginContext = api.context;

  container.innerHTML = `
    <div style="padding: 24px; font-family: system-ui, sans-serif;">
      <h1 style="margin: 0 0 8px;">Hello from My First Plugin!</h1>
      <p style="color: #888;">Theme: ${ctx.theme}</p>
      <p style="color: #888;">Project: ${ctx.project?.name ?? 'None selected'}</p>
      <div id="server-data" style="margin-top: 16px;">Loading server data...</div>
    </div>
  `;

  api.rpc('GET', '/hello')
    .then((data) => {
      const el = container.querySelector('#server-data');
      if (el) el.textContent = `Server says: ${(data as any).message}`;
    })
    .catch((err: Error) => {
      const el = container.querySelector('#server-data');
      if (el) el.textContent = `Server error: ${err.message}`;
    });

  const unsubscribe = api.onContextChange((newCtx) => {
    const h1 = container.querySelector('h1');
    if (h1) {
      (h1 as HTMLElement).style.color = newCtx.theme === 'dark' ? '#fff' : '#000';
    }
  });

  (container as any)._cleanup = unsubscribe;
}

export function unmount(container: HTMLElement): void {
  (container as any)._cleanup?.();
  container.innerHTML = '';
}
```

**Key concepts:**
- The `mount` function receives a container element and API object
- `api.context` provides theme, project, and session information
- `api.rpc` communicates with the backend server
- `api.onContextChange` subscribes to context updates
- The `unmount` function handles cleanup on tab closure

### Frontend-Only Variant

Plugins without backend requirements can omit the `server` field from manifest.json. The `mount` function can still utilize `api.context` and `api.onContextChange` without RPC capabilities.

## Backend Implementation

Create `src/server.ts`:

```typescript
import http from 'node:http';

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  res.setHeader('Content-Type', 'application/json');

  if (url.pathname === '/hello') {
    res.writeHead(200);
    res.end(JSON.stringify({
      message: `Hello from the plugin server! (Node ${process.version})`,
      pluginName: process.env.PLUGIN_NAME,
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') {
    console.log(JSON.stringify({ ready: true, port: addr.port }));
  }
});
```

**Server requirements:**
- Listen on port 0 (OS assigns random available port)
- Bind exclusively to 127.0.0.1 (localhost)
- Output ready signal as JSON: `{"ready": true, "port": <number>}` within 10 seconds

## Building and Testing

Compile TypeScript:
```bash
npm run build
```

Test the server independently:
```bash
node dist/server.js
# Should output: {"ready":true,"port":XXXXX}

# In another terminal:
curl http://127.0.0.1:XXXXX/hello
```

For development workflows, use `npm run dev` to enable automatic recompilation on file changes.

## Publication and Installation

Push to a Git repository:
```bash
git add .
git commit -m "Initial plugin"
git remote add origin https://github.com/yourname/cloudcli-plugin-my-first-plugin.git
git push -u origin main
```

Install in CloudCLI UI via **Settings > Plugins**:
1. Paste Git URL in the plugin installation field
2. Click **Install**
3. The host automatically clones, installs dependencies, compiles TypeScript, and deploys

## Iteration Process

After modifications:
1. Push changes to the Git repository
2. Click the refresh icon in **Settings → Plugins** adjacent to the plugin
3. The system pulls updates, reinstalls dependencies, recompiles, and restarts services

## Community Submission

Submit plugins to the official directory by posting in the GitHub Discussions "Show and Tell" category at `github.com/siteboon/claudecodeui/discussions`.

Include:
- Plugin name (following `cloudcli-plugin-*` convention)
- Repository link (public GitHub required)
- Functional description
- Screenshot or demonstration GIF

The development team reviews submissions and adds approved plugins to the official Available Plugins documentation list.

## Additional Resources

- [Manifest Reference](/docs/plugins/manifest-reference)
- [Frontend API Reference](/docs/plugins/frontend-api)
- [Backend Servers](/docs/plugins/backend-servers)
- [Security Model](/docs/plugins/security-model)
- [Example: Project Stats](/docs/plugins/example-project-stats)
