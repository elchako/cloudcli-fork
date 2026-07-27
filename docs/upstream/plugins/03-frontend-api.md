> Источник: https://cloudcli.ai/docs/plugins/frontend-api — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Frontend API Reference — CloudCLI UI

## Module Exports

Your plugin's entry file (`src/index.ts`) must export a `mount` function and optionally an `unmount` function.

### `mount(container, api)`

Invoked when a user opens your plugin's tab.

| Parameter | Type | Description |
|-----------|------|-------------|
| `container` | `HTMLElement` | A `<div>` element for rendering content |
| `api` | `PluginAPI` | The API object providing context, events, and server communication |

**Key rules:**
- You control the contents within `container`
- Do not remove or replace the container element itself
- Errors thrown in `mount` are caught and displayed by the host
- `mount` is called each time the tab becomes active

### `unmount(container)`

Called when your plugin tab closes, the plugin disables, or the component unmounts.

| Parameter | Type | Description |
|-----------|------|-------------|
| `container` | `HTMLElement` | The same element passed to `mount` |

**Key rules:**
- This export is optional
- Always unsubscribe from `onContextChange` to prevent memory leaks
- Clear any `setInterval` or `setTimeout` handles
- Remove global event listeners you've added

## Type Definitions

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

## The Plugin API Object

### `api.context`

Returns a read-only snapshot of current context:

```typescript
interface PluginContext {
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `theme` | `'dark' \| 'light'` | Current UI theme |
| `project` | `object \| null` | Currently selected project with name and path |
| `session` | `object \| null` | Currently active session with id and title |

**Note:** Each access reads current state—values don't become stale.

### `api.onContextChange(callback)`

Subscribe to context changes.

| Parameter | Type | Description |
|-----------|------|-------------|
| `callback` | `(ctx: PluginContext) => void` | Invoked whenever theme, project, or session changes |

**Returns:** An unsubscribe function to stop receiving updates.

**Behavior:**
- The callback is NOT called immediately upon subscription
- Read `api.context` in your `mount` function for initial values
- Register multiple callbacks; each receives its own unsubscribe function
- All callbacks clear on component unmount, but explicit unsubscribe is recommended

### `api.rpc(method, path, body?)`

Make an HTTP request to your plugin's backend server through the host.

| Parameter | Type | Description |
|-----------|------|-------------|
| `method` | `string` | HTTP method (GET, POST, PUT, DELETE, etc.) |
| `path` | `string` | Request path on your server |
| `body` | `unknown` (optional) | Request body, serialized as JSON |

**Returns:** `Promise<unknown>` with parsed JSON response

```typescript
// GET request
const stats = await api.rpc('GET', '/stats?path=/home/user/project');

// POST with body
const result = await api.rpc('POST', '/analyze', {
  files: ['src/index.ts'],
  depth: 3,
});

// DELETE
await api.rpc('DELETE', '/cache');
```

**How it works:**
1. Your call becomes a fetch to `/api/plugins/your-plugin-name/rpc/...`
2. The host authenticates using the user's session
3. Configured secrets are injected as `x-plugin-secret-*` headers
4. The request proxies to your plugin server on `127.0.0.1:<port>`
5. The response streams back to the browser

**Important notes:**
- `api.rpc` only works if your manifest includes a `server` entry
- The host attempts lazy-start if your server isn't running
- The host handles authentication—your server doesn't validate tokens
- Query strings in the path parameter are preserved

## Patterns and Best Practices

### Theme-Aware Rendering

```typescript
export function mount(container: HTMLElement, api: PluginAPI): void {
  const render = (ctx: PluginContext): void => {
    const isDark = ctx.theme === 'dark';
    container.innerHTML = `
      <div style="
        background: ${isDark ? '#1e1e1e' : '#ffffff'};
        color: ${isDark ? '#d4d4d4' : '#1e1e1e'};
      ">
        <h2>My Plugin</h2>
      </div>
    `;
  };

  render(api.context);
  (container as any)._unsub = api.onContextChange(render);
}

export function unmount(container: HTMLElement): void {
  (container as any)._unsub?.();
  container.innerHTML = '';
}
```

### Project-Aware Data Loading

```typescript
export function mount(container: HTMLElement, api: PluginAPI): void {
  let currentPath: string | null = null;

  const loadData = async (projectPath: string): Promise<void> => {
    if (projectPath === currentPath) return;
    currentPath = projectPath;

    const content = container.querySelector('#content');
    if (content) content.textContent = 'Loading...';

    try {
      const data = await api.rpc('GET', 
        `/analyze?path=${encodeURIComponent(projectPath)}`);
      if (content) content.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      if (content) content.textContent = `Error: ${(err as Error).message}`;
    }
  };

  container.innerHTML = '<pre id="content">Select a project...</pre>';

  if (api.context.project) {
    loadData(api.context.project.path);
  }

  (container as any)._unsub = api.onContextChange((ctx: PluginContext) => {
    if (ctx.project) {
      loadData(ctx.project.path);
    } else {
      currentPath = null;
      const content = container.querySelector('#content');
      if (content) content.textContent = 'Select a project...';
    }
  });
}
```

### Loading Assets from Your Plugin Directory

```typescript
export function mount(container: HTMLElement, api: PluginAPI): void {
  // Load a stylesheet
  if (!document.querySelector('#my-plugin-styles')) {
    const link = document.createElement('link');
    link.id = 'my-plugin-styles';
    link.rel = 'stylesheet';
    link.href = `/api/plugins/my-plugin/assets/styles.css`;
    document.head.appendChild(link);
  }

  // Load an image
  container.innerHTML = `
    <img src="/api/plugins/my-plugin/assets/logo.png" alt="Logo" />
  `;
}
```

## Next Steps

- [Backend Servers](/docs/plugins/backend-servers) — Add server functionality for filesystem access and external APIs
- [Manifest Reference](/docs/plugins/manifest-reference) — All available configuration options
- [Security Model](/docs/plugins/security-model) — Plugin isolation mechanisms
