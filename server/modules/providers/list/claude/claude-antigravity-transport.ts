import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { decodeCliProxyModelId } from '@/modules/providers/list/claude/claude-api-models.js';
import { withoutGatewayEffortSuffix } from '@/modules/providers/list/claude/claude-models.provider.js';
import type { ProviderModelsDefinition } from '@/shared/types.js';

// GOLDJAXE fork (реестр §22.3): CLI добавляет эту строку даже к custom prompt.
// На Antigravity она воспроизводимо вызывает upstream 429; исправляем только её,
// не заменяя preset, инструкции безопасности, сообщения, tools, model или effort.
export const SDK_AGENT_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
export const CLOUDCLI_AGENT_IDENTITY = 'You are CloudCLI, an AI coding assistant.';

export function isAntigravityModel(model: unknown, catalog: ProviderModelsDefinition): boolean {
  if (typeof model !== 'string') return false;
  const id = decodeCliProxyModelId(withoutGatewayEffortSuffix(model));
  return catalog.OPTIONS.some(option => option.catalogProvider === 'antigravity'
    && decodeCliProxyModelId(withoutGatewayEffortSuffix(option.value)) === id);
}

export function neutralizeAntigravityIdentity(payload: unknown, catalog: ProviderModelsDefinition): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;
  if (!isAntigravityModel(body.model, catalog)) return payload;
  if (body.system === SDK_AGENT_IDENTITY) return { ...body, system: CLOUDCLI_AGENT_IDENTITY };
  if (!Array.isArray(body.system)) return payload;
  let changed = false;
  const system = body.system.map(block => {
    if (block?.type !== 'text' || block.text !== SDK_AGENT_IDENTITY) return block;
    changed = true;
    return { ...block, text: CLOUDCLI_AGENT_IDENTITY };
  });
  return changed ? { ...body, system } : payload;
}

const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);
const API_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens', '/v1/models']);
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function fail(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
}

/** Изолированный loopback-адаптер одного SDK-рана. Нет новых API-ключей,
 * повторов, переключений моделей или доступа браузера. Цель фиксируется при
 * создании; редиректы запрещены, путь нельзя превратить в произвольный URL.
 */
export async function createAntigravityTransport(upstreamBaseUrl: string, catalog: ProviderModelsDefinition) {
  const upstreamBase = new URL(upstreamBaseUrl);
  if (!['http:', 'https:'].includes(upstreamBase.protocol) || upstreamBase.username || upstreamBase.password
    || upstreamBase.search || upstreamBase.hash) throw new Error('Invalid configured gateway endpoint');
  const prefix = `/${randomBytes(24).toString('hex')}`;
  const controllers = new Set<AbortController>();
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController();
    controllers.add(controller);
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const incoming = new URL(req.url || '/', 'http://127.0.0.1');
      if (!incoming.pathname.startsWith(`${prefix}/`)) { fail(res, 404, 'Not found'); return; }
      const apiPath = incoming.pathname.slice(prefix.length);
      if (!API_PATHS.has(apiPath) || !['GET', 'POST'].includes(req.method || '')) {
        fail(res, 404, 'Not found'); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) { fail(res, 413, 'Request body too large'); return; }
        chunks.push(bytes);
      }
      let body = Buffer.concat(chunks);
      if (req.method === 'POST' && body.length) {
        let parsed: unknown;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { fail(res, 400, 'Invalid JSON request'); return; }
        const rewritten = neutralizeAntigravityIdentity(parsed, catalog);
        if (rewritten !== parsed) body = Buffer.from(JSON.stringify(rewritten));
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_HEADERS.has(name) && value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const url = `${upstreamBase.origin}${upstreamBase.pathname.replace(/\/$/, '')}${apiPath}${incoming.search}`;
      const response = await fetch(url, { method: req.method, headers,
        ...(req.method === 'POST' ? { body } : {}), redirect: 'error', signal: controller.signal });
      res.statusCode = response.status;
      // fetch декомпрессирует тело; не объявляем SDK старые encoding/length.
      response.headers.forEach((value, name) => {
        if (!HOP_HEADERS.has(name) && name !== 'content-encoding') res.setHeader(name, value);
      });
      if (response.body) await pipeline(Readable.fromWeb(response.body as never), res);
      else res.end();
    } catch {
      if (!res.destroyed) fail(res, 502, 'Configured gateway request failed');
    } finally { controllers.delete(controller); }
  };
  const server = createServer((req, res) => { void serve(req, res); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback gateway did not start');
  return {
    baseUrl: `http://127.0.0.1:${address.port}${prefix}`,
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
