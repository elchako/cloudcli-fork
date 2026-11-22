import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  loadProtectedDataProfile,
  type ProtectedDataProfile,
  type ProtectedField,
} from '@/modules/chat/protected-data/protected-data-client';

export type ProtectedDataDraft = {
  scope: string;
  profile: ProtectedDataProfile;
  fields: ProtectedField[];
  target?: string;
};

type Issue = 'unavailable' | 'unsupported' | 'notSecure' | 'directOnly' | 'stageFailed';
type ProtectedDataState = {
  scope: string | null;
  draft: ProtectedDataDraft | null;
  editor: ProtectedDataProfile | null;
  issue: Issue | null;
  loading: boolean;
};

const blank = (scope: string | null): ProtectedDataState => ({ scope, draft: null, editor: null, issue: null, loading: false });

// GOLDJAXE fork (реестр §27): никакого draft mirror, кэша или sessionStorage.
export function useProtectedDataComposer(draftScope: string | null, provider: string) {
  const scope = draftScope ? `${provider}:${draftScope}` : null;
  const [state, setState] = useState(() => blank(scope));
  if (state.scope !== scope) setState(blank(scope));
  const scopeRef = useRef(scope);
  const draftRef = useRef<ProtectedDataDraft | null>(null);
  const pending = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    scopeRef.current = scope;
    return () => {
      pending.current?.abort();
      pending.current = null;
      draftRef.current = null;
      scopeRef.current = null;
    };
  }, [scope]);

  const update = useCallback((patch: Partial<Omit<ProtectedDataState, 'scope'>>) => {
    setState((previous) => previous.scope === scope ? { ...previous, ...patch } : previous);
  }, [scope]);
  const setIssue = useCallback((issue: Issue | null) => update({ issue }), [update]);

  const open = useCallback(async () => {
    if (!scope || pending.current) return;
    if (provider !== 'claude') {
      setIssue('unsupported');
      return;
    }
    if (!window.isSecureContext || !window.crypto?.subtle) {
      setIssue('notSecure');
      return;
    }
    const request = new AbortController();
    pending.current = request;
    update({ issue: null, loading: true });
    try {
      const profile = await loadProtectedDataProfile(request.signal);
      if (request.signal.aborted || scope !== scopeRef.current) return;
      if (profile) update({ editor: profile });
      else setIssue('unavailable');
    } catch {
      if (!request.signal.aborted && scope === scopeRef.current) setIssue('unavailable');
    } finally {
      if (pending.current === request) {
        pending.current = null;
        update({ loading: false });
      }
    }
  }, [provider, scope, setIssue, update]);

  const close = useCallback(() => update({ editor: null }), [update]);
  const attach = useCallback((fields: ProtectedField[], target?: string) => {
    if (!scope || !state.editor || scope !== scopeRef.current) return;
    const draft = { scope, profile: state.editor, fields, target };
    draftRef.current = draft;
    update({ draft, editor: null, issue: null });
  }, [scope, state.editor, update]);
  const remove = useCallback(() => {
    if (scope !== scopeRef.current) return;
    draftRef.current = null;
    update({ draft: null, issue: null });
  }, [scope, update]);
  const isCurrent = useCallback((snapshot: ProtectedDataDraft) => (
    draftRef.current === snapshot && scopeRef.current === snapshot.scope
  ), []);

  return useMemo(() => ({
    ...state,
    open,
    close,
    attach,
    remove,
    isCurrent,
    setIssue,
  }), [attach, close, isCurrent, open, remove, setIssue, state]);
}

export type ProtectedDataComposer = ReturnType<typeof useProtectedDataComposer>;
