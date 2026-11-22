import { useState } from 'react';

import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { PermissionPanelProps } from '@/shared/types';
import { Button } from '@/shared/ui';

// GOLDJAXE fork (реестр §27.5): системная карточка, не Markdown и не разрешение SDK.
export const PROTECTED_DELIVERY_PANEL = 'CloudCLIProtectedDelivery';

export function ProtectedDeliveryPanel({ request }: PermissionPanelProps) {
  const { sendMessage, isConnected } = useWebSocket();
  const [submitted, setSubmitted] = useState(false);
  const input = request.input as { destinationPreview?: unknown; names?: unknown } | null;
  const destination = input?.destinationPreview;
  const names = input?.names;
  const complete = typeof destination === 'string' && Boolean(destination.trim()) && Array.isArray(names)
    && names.length > 0 && names.every((name): name is string => typeof name === 'string' && Boolean(name));
  const decide = (allow: boolean) => {
    if (submitted || !isConnected || !request.sessionId || (allow && !complete)) return;
    setSubmitted(true);
    // Это отдельный кадр: старый/общий Allow и Allow & remember не доказывают показ адреса.
    sendMessage({ type: 'chat.protected-delivery-decision', sessionId: request.sessionId, requestId: request.requestId, allow });
  };
  return (
    <section aria-label="Подтверждение передачи" className="max-h-[65dvh] min-w-0 overflow-y-auto rounded-xl border bg-background text-foreground">
      <div className="p-4">
        <h3 className="mb-3 font-semibold">Передать защищённые поля?</h3>
        {complete ? (
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-muted-foreground">Операция и полный адрес</dt>
              <dd dir="ltr" className="mt-1 whitespace-pre-wrap font-mono text-sm [overflow-wrap:anywhere]">{destination}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Какие поля передаются</dt>
              <dd><ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{names.map(name => (
                <li key={name} className="min-w-0 font-mono text-sm [overflow-wrap:anywhere]">{name}</li>
              ))}</ul></dd>
            </div>
          </dl>
        ) : <p role="alert">Не удалось показать адрес и поля. Передача недоступна.</p>}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t p-3">
        <Button type="button" variant="outline" className="min-h-11" disabled={submitted || !isConnected} onClick={() => decide(false)}>Отказать</Button>
        <Button type="button" className="min-h-11" disabled={!complete || !request.sessionId || submitted || !isConnected} onClick={() => decide(true)}>Передать один раз</Button>
      </div>
    </section>
  );
}
